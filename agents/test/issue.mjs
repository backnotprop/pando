// End to end, stage 4: "Address with agent" on an issue. Pando makes the
// branch agent/<n>-<title words>, linked to the issue, and launches a session
// told the issue; the agent pushes, comments, and asks to merge. The merge
// waits while the required check is missing; when the check goes green, Pando
// tells the session, it merges, and the merge closes the issue. It records
// the contract's responses for these routes.
//
//   agents/test/serve.sh start && node agents/test/issue.mjs

import { writeFileSync } from "node:fs";
import { call, check, done, makeRepo, say, scrub, tool, untilClosed, untilSession } from "./lib.mjs";

const OUT = new URL("../../packages/contract/recorded/", import.meta.url);

function record(file, schema, route, status, body) {
  writeFileSync(new URL(file, OUT), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);
}

const t = await makeRepo("agents-s4", {
  "README.md": "# Issue\n\nThis line has a tpyo.\n",
  ".pando/pando.toml": '[repos."."]\nrequired_checks = ["ci/test"]\n',
});

const BRANCH = "1-the-readme-has-a-typo";

try {
  const body = [
    "The second line of the README says tpyo.",
    "",
    "(For the scripted model:)",
    tool("edit", { path: "README.md", edits: [{ oldText: "tpyo", newText: "typo" }] }),
    tool("bash", { command: "git commit -qam 'Fix the README typo' && git push -q origin HEAD 2>&1; echo pushed=$?" }),
    tool("comment_issue", { number: 1, body: "Fixed the typo; the README reads right now." }),
    tool("merge", {}),
  ].join("\n");

  let r = await call("POST", `/v1/monorepos/${t.full}/issues`, t.secret, { title: "The README has a typo", body });
  check("issue #1", r.status === 201, r.status);
  r = await call("POST", `/v1/monorepos/${t.full}/issues/1/comments`, t.secret, { body: "Only the README, nothing else." });

  // ── Address with agent ──
  r = await call("POST", `/v1/monorepos/${t.full}/issues/1/agent`, t.secret, { model: "scripted" });
  record("agent-issue-launched.json", "AgentSession", "POST /v1/monorepos/{owner}/{monorepo}/issues/{n}/agent", r.status, r.json);
  check("Address with agent: 201, kind issue, #1, on 1-the-readme-has-a-typo", r.status === 201 && r.json?.kind === "issue" && r.json?.issue === 1 && r.json?.branch === BRANCH, scrub(JSON.stringify(r.json)));

  r = await call("GET", `/v1/monorepos/${t.full}/issues/1/timeline`, t.secret);
  const linked = r.json.items.find((x) => x.kind === "linked");
  check("the issue's timeline: the branch linked, by the person", linked?.branch === BRANCH && linked?.actor === t.login, JSON.stringify(linked));
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/${encodeURIComponent(BRANCH)}`, t.secret);
  check("the branch is made off main, titled as the issue", r.status === 200 && r.json?.title === "The README has a typo", JSON.stringify({ status: r.status, title: r.json?.title }));

  r = await untilSession(t, 1, (s) => s?.status !== "working");
  check("the run ends with its merge waiting for ci/test", r.json?.status === "waiting" && r.json?.awaiting_checks === true, JSON.stringify(r.json));
  record("agent-awaiting.json", "AgentSession", "GET /v1/monorepos/{owner}/{monorepo}/agents/{n} (its merge waits for checks)", r.status, r.json);

  r = await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret);
  const first = r.json.messages.find((m) => m.role === "user")?.parts[0]?.text ?? "";
  check(
    "the agent is told the issue: title, body, comments, its linked branch",
    /^Address issue #1 in .+: The README has a typo/.test(first) && /The second line of the README says tpyo/.test(first) && /Only the README, nothing else/.test(first) && first.includes(`Your branch ${BRANCH} is linked to #1`),
    first.slice(0, 600),
  );
  const toolsRun = r.json.messages.filter((m) => m.role === "tool").map((m) => `${m.parts[0].name}${m.parts[0].error ? "!" : ""}`).join(" ");
  check("edit, bash, comment_issue, then merge refused", toolsRun === "edit bash comment_issue merge!", toolsRun);

  r = await call("GET", `/v1/monorepos/${t.full}/agents?issue=1`, t.secret);
  record("agents-issue.json", "AgentSessionList", "GET /v1/monorepos/{owner}/{monorepo}/agents?issue={n}", r.status, r.json);
  check("the issue's sessions: GET .../agents?issue=1", r.json?.sessions?.length === 1 && r.json.sessions[0].number === 1);
  r = await call("GET", `/v1/monorepos/${t.full}/agents?issue=2`, t.secret);
  check("and none for another issue", r.json?.sessions?.length === 0);

  // A second agent on the same issue gets its own branch.
  r = await call("POST", `/v1/monorepos/${t.full}/issues/1/agent`, t.secret, { model: "scripted", prompt: "Look only." });
  check("a second agent on #1 works on the same branch, as it is", r.status === 201 && r.json?.branch === BRANCH, r.json?.branch);
  await untilSession(t, 2, (s) => s?.status !== "working");
  await call("POST", `/v1/monorepos/${t.full}/agents/2/stop`, t.secret);

  // ── The check goes green: Pando tells the session; it merges ──
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/${encodeURIComponent(BRANCH)}`, t.secret);
  const t0 = Date.now();
  r = await call("POST", `/v1/monorepos/${t.full}/repos/${t.name}/statuses/${r.json.head}`, t.secret, { state: "success", context: "ci/test" });
  check("ci/test goes green on the branch head", r.status === 201 || r.status === 200, r.status);
  r = await untilSession(t, 1, (s) => s?.status === "waiting" && !s.awaiting_checks && Date.parse(s.updated_at) >= t0);
  check("the session was told and ran again, no longer waiting for checks", r.json?.status === "waiting" && r.json?.awaiting_checks === false, JSON.stringify(r.json));
  r = await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret);
  const told = r.json.messages.filter((m) => m.role === "user").at(-1)?.parts[0]?.text ?? "";
  const merged = r.json.messages.filter((m) => m.role === "tool").at(-1)?.parts[0];
  check("Pando's message, then the merge", told.startsWith(`[Pando] The required checks on ${BRANCH} are green now.`) && merged?.name === "merge" && !merged.error && /closing #1/.test(merged.text), `${told}\n${merged?.text}`);
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/${encodeURIComponent(BRANCH)}`, t.secret);
  check("the branch is merged, by the person, from cloud-1", r.json?.state === "merged" && r.json?.merged_by === t.login && r.json?.merged_machine === "cloud-1", JSON.stringify({ s: r.json?.state, by: r.json?.merged_by, m: r.json?.merged_machine }));
  r = await untilClosed(t, 1);
  check("issue #1 is closed by the merge", r.json?.state === "closed" && r.json?.closed_by_merge !== null, JSON.stringify({ state: r.json?.state, by: r.json?.closed_by_merge }));
  r = await call("GET", `/v1/monorepos/${t.full}/issues/1/timeline`, t.secret);
  const comment = r.json.items.find((x) => x.kind === "comment" && x.comment.machine === "cloud-1")?.comment;
  check("the agent's report on the issue, as the person from cloud-1", comment?.author === t.login && /Fixed the typo/.test(comment?.body ?? ""), JSON.stringify(comment));

  r = await call("POST", `/v1/monorepos/${t.full}/issues/1/agent`, t.secret, { model: "scripted" });
  record("error-409-issue-closed.json", "ErrorBody", "POST /v1/monorepos/{owner}/{monorepo}/issues/{n}/agent (a closed issue)", r.status, r.json);
  check("a closed issue is not addressed (409 issue_closed)", r.status === 409 && r.json?.error?.code === "issue_closed", r.status);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
  say("");
}

done();
