// End to end, stage 3: the Pando tools in the session object (issue,
// list_files, read_file, branch_diff, comment_issue, post_review, merge)
// beside Pi's sandbox tools, through Pando's own routes with the session's
// credential. The merge goes through Pando's normal route: refused while the
// required check is missing, merged once it is green, closing the issue.
//
//   agents/test/serve.sh start && node agents/test/tools.mjs

import { call, check, done, makeRepo, say, scrub, sleep, tool, untilClosed, untilSettled } from "./lib.mjs";

/** Until the session's last tool result is a merge, after Pando told it the checks are green. */
async function untilMerged(t, ms = 120_000) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const last = (await results(t, 1)).at(-1);

    if (last?.name === "merge" && !last.error) return last;
    await sleep(500);
  }

  return null;
}

/** Each tool result of the transcript by tool name, in order. */
async function results(t, n) {
  const r = await call("GET", `/v1/monorepos/${t.full}/agents/${n}/transcript`, t.secret);

  return r.json.messages.filter((m) => m.role === "tool").map((m) => m.parts[0]);
}

const t = await makeRepo("agents-s3", {
  "README.md": "# Tools\n\nThis line has a tpyo.\n",
  "src/app.js": "export const answer = 42;\n",
  ".pando/pando.toml": '[repos."."]\nrequired_checks = ["ci/test"]\n',
});

try {
  let r = await call("POST", `/v1/monorepos/${t.full}/issues`, t.secret, { title: "The README has a typo", body: "Second line: tpyo." });
  check("issue #1", r.status === 201 && r.json?.number === 1, r.status);

  const prompt = [
    "Address issue #1.",
    tool("issue", { number: 1 }),
    tool("list_files", {}),
    tool("read_file", { path: "README.md" }),
    tool("edit", { path: "README.md", edits: [{ oldText: "tpyo", newText: "typo" }] }),
    tool("bash", { command: "git commit -qam 'Fix the README typo' -m 'Fixes #1' && git push -q origin fix-readme 2>&1; echo pushed=$?" }),
    tool("branch_diff", {}),
    tool("comment_issue", { number: 1, body: "Fixed on fix-readme." }),
    tool("post_review", { verdict: "comment", body: "One line changed; nothing else touched." }),
    tool("merge", {}),
  ].join("\n");

  r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { prompt, model: "scripted", branch: "fix-readme" });
  check("launched", r.status === 201, scrub(JSON.stringify(r.json)));
  r = await untilSettled(t, 1);
  check("the run ends, waiting", r.json?.status === "waiting", JSON.stringify(r.json));

  const res = await results(t, 1);
  const by = Object.fromEntries(res.map((p) => [p.name, p]));
  say(`      tools: ${res.map((p) => `${p.name}${p.error ? " (error)" : ""}`).join(", ")}`);
  check("issue reads the issue from Pando", /#1 The README has a typo \(open/.test(by.issue?.text) && /Second line: tpyo/.test(by.issue?.text), by.issue?.text);
  check("list_files lists the root", /^\.pando\/$/m.test(by.list_files?.text) && /^README\.md$/m.test(by.list_files?.text) && /^src\/$/m.test(by.list_files?.text), by.list_files?.text);
  check("read_file reads main's README", /This line has a tpyo\./.test(by.read_file?.text), by.read_file?.text);
  check("branch_diff shows the pushed change as a unified diff", /^-This line has a tpyo\.$/m.test(by.branch_diff?.text) && /^\+This line has a typo\.$/m.test(by.branch_diff?.text), by.branch_diff?.text);
  check("comment_issue and post_review succeed", !by.comment_issue?.error && !by.post_review?.error, `${by.comment_issue?.text}\n${by.post_review?.text}`);
  check("merge is refused by Pando while ci/test is missing (412 checks_not_green)", by.merge?.error && /Pando refused \(412\) checks_not_green: checks are missing/.test(by.merge.text), by.merge?.text);

  r = await call("GET", `/v1/monorepos/${t.full}/issues/1/timeline`, t.secret);
  const comment = r.json.items.find((x) => x.kind === "comment")?.comment;
  check("the comment is the person's, from cloud-1", comment?.author === t.login && comment?.machine === "cloud-1" && comment?.body === "Fixed on fix-readme.", JSON.stringify(comment));
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/fix-readme/reviews`, t.secret);
  const review = r.json?.reviews?.[0];
  check("the review is on fix-readme, as the person", review?.verdict === "comment" && JSON.stringify(review).includes(t.login), scrub(JSON.stringify(review)));

  // The check goes green: Pando tells the session, which merges (stage 4's issue.mjs follows that message itself).
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/fix-readme`, t.secret);
  const head = r.json?.head;
  r = await call("POST", `/v1/monorepos/${t.full}/repos/${t.name}/statuses/${head}`, t.secret, { state: "success", context: "ci/test" });
  check("ci/test is green on the branch head", r.status === 201 || r.status === 200, r.status);
  const merged = await untilMerged(t);
  check("merge goes through Pando's normal route and closes #1", merged?.name === "merge" && !merged.error && /Merged agent\/1 into main \(merge commit [0-9a-f]{12}, closing #1\)/.test(merged.text), merged?.text);
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/fix-readme`, t.secret);
  check("fix-readme is merged, by the person, from cloud-1", r.json?.state === "merged" && r.json?.merged_by === t.login && r.json?.merged_machine === "cloud-1", scrub(JSON.stringify({ state: r.json?.state, by: r.json?.merged_by, machine: r.json?.merged_machine })));
  r = await untilClosed(t, 1);
  check("issue #1 is closed by the merge", r.json?.state === "closed", r.json?.state);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
