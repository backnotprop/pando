// End to end: an agent's merge when the repo's checks run on merge (owner,
// 2026-10-13, CI costs). A push starts no build; the agent's merge tool asks
// Pando to merge, which starts the build and refuses with "checks started";
// when the check goes green Pando tells the session, and it merges.
//
//   agents/test/serve.sh start && node agents/test/merge-on-merge.mjs
//
// Buildkite is a stand-in on this machine (the hook's api_url); the Worker
// sends it the server's BUILDKITE_API_TOKEN, never printed.

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { call, check, done, git, makeRepo, scrub, sleep, tool, untilSettled } from "./lib.mjs";

const created = [];

const stand = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/builds") {
      const body = JSON.parse(raw);
      created.push(body);

      return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ number: created.length, commit: body.commit, branch: body.branch }));
    }

    res.writeHead(404).end();
  });
});

await new Promise((r) => stand.listen(0, "127.0.0.1", r));

/** Each tool result of the session's transcript, in order. */
async function results(t, n) {
  const r = await call("GET", `/v1/monorepos/${t.full}/agents/${n}/transcript`, t.secret);

  return r.json.messages.filter((m) => m.role === "tool").map((m) => m.parts[0]);
}

const t = await makeRepo("agents-om", { "README.md": "# On merge\n", ".pando/pando.toml": '[repos."."]\nrequired_checks = ["ci/test"]\n' });

const repo = `/v1/monorepos/${t.full}/repos/${t.name}`;

try {
  let r = await call("PATCH", repo, t.secret, { ci_policy: "on_merge" });
  check("the repo's checks run on merge", r.status === 200 && r.json?.ci_policy === "on_merge", r.status);
  r = await call("POST", `${repo}/hooks`, t.secret, { type: "buildkite", buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${stand.address().port}/builds` } });
  check("a buildkite hook at the stand-in", r.status === 201, r.status);

  const src = join(t.work, "src");
  git(["checkout", "-q", "-b", "fix"], src);
  writeFileSync(join(src, "README.md"), "# On merge\n\nFixed.\n");
  git(["commit", "-qam", "Fix the README"], src);
  const g = git(["push", "-q", t.cloneUrl, "fix"], src, t.secret);
  const head = git(["rev-parse", "HEAD"], src).out.trim();
  await sleep(3000);
  check("the push starts no build", g.ok && created.length === 0, `${created.length} builds`);

  r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { model: "scripted", branch: "fix", prompt: tool("merge", {}) });
  check("an agent on fix, told to merge", r.status === 201, scrub(JSON.stringify(r.json)));
  r = await untilSettled(t, 1);
  const first = (await results(t, 1)).find((p) => p.name === "merge");
  check("its merge tool: Pando refuses with checks started for this merge", first?.error && /Pando refused \(412\) checks_not_green: checks started for this merge/.test(first.text), first?.text);
  for (let i = 0; i < 40 && created.length === 0; i++) await sleep(250);
  check("and the build of the branch's head is started, for the merge", created.length === 1 && created[0].commit === head && created[0].message.startsWith("Checks for merging fix"), JSON.stringify(created.map((b) => b.message)));

  r = await call("POST", `${repo}/statuses/${head}`, t.secret, { state: "success", context: "ci/test" });
  check("ci/test goes green", r.status === 201, r.status);
  const end = Date.now() + 120_000;
  let merged = null;

  while (!merged && Date.now() < end) {
    merged = (await results(t, 1)).find((p) => p.name === "merge" && !p.error) ?? null;

    if (!merged) await sleep(500);
  }

  check("Pando tells the session, and its merge lands", (merged?.text ?? "").startsWith("Merged fix into main"), merged?.text);
  r = await call("GET", `${repo}/branches/fix`, t.secret);
  check("fix is merged; main's merge commit builds as before", r.json?.state === "merged" && created.some((b) => b.branch === "main"), JSON.stringify(created.map((b) => b.branch)));
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  stand.close();
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
