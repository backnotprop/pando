// End to end, stage 7: "Review with agent" on a branch. The session reads the
// branch, runs a command in its sandbox, and posts one review as the person;
// it cannot merge, write a file or approve, and it pushes nothing.
//
//   agents/test/serve.sh start && node agents/test/review.mjs

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { call, check, done, git, makeRepo, scrub, tool, untilSettled } from "./lib.mjs";

const t = await makeRepo("agents-s7", { "README.md": "# Review\n\nAll good here.\n" });

try {
  // A person's branch, pushed from their machine.
  const src = join(t.work, "src");
  git(["checkout", "-q", "-b", "feature"], src);
  writeFileSync(join(src, "README.md"), "# Review\n\nAll good here.\nThis line has a tpyo.\n");
  git(["commit", "-qam", "Add a line"], src);
  let g = git(["push", "-q", t.cloneUrl, "feature"], src, t.secret);
  check("a branch to review, pushed by the person", g.ok, g.out.slice(-200));
  let r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/feature`, t.secret);
  const head = r.json?.head;

  const script = [
    tool("branch_diff", {}),
    tool("bash", { command: "git branch --show-current; tail -1 README.md" }),
    tool("merge", {}),
    tool("write", { path: "x.txt", content: "no" }),
    tool("post_review", { verdict: "approve", body: "Looks fine." }),
    tool("post_review", { verdict: "request_changes", body: "One typo.", comments: [{ path: "README.md", line: 4, body: "tpyo: typo" }] }),
  ].join("\n");

  r = await call("POST", `/v1/monorepos/${t.full}/agents/review`, t.secret, { branch: "feature", model: "scripted", prompt: script });
  check("Review with agent: 201, kind review, on feature", r.status === 201 && r.json?.kind === "review" && r.json?.branch === "feature" && r.json?.machine === "cloud-1", scrub(JSON.stringify(r.json)));
  r = await untilSettled(t, 1);
  check("the run ends, waiting", r.json?.status === "waiting", JSON.stringify(r.json));
  r = await call("GET", `/v1/monorepos/${t.full}/agents?repo=${t.name}&branch=feature&kind=review`, t.secret);
  const other = await call("GET", `/v1/monorepos/${t.full}/agents?repo=${t.name}&branch=main`, t.secret);
  check("the branch's sessions: GET .../agents?repo=&branch=", r.json?.sessions?.length === 1 && r.json.sessions[0].number === 1 && other.json?.sessions?.length === 0, JSON.stringify({ on: r.json?.sessions?.length, main: other.json?.sessions?.length }));

  const tr = (await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret)).json.messages;
  const told = tr.find((m) => m.role === "user")?.parts[0]?.text ?? "";
  check("the agent is told the branch to review", told.startsWith(`Review branch feature of ${t.name} in ${t.full}`), told.split("\n")[0]);
  const res = tr.filter((m) => m.role === "tool").map((m) => m.parts[0]);
  const by = (name, i = 0) => res.filter((p) => p.name === name)[i];
  check("branch_diff shows the branch's change", /^\+This line has a tpyo\.$/m.test(by("branch_diff")?.text ?? ""), by("branch_diff")?.text);
  check("bash runs on the branch, checked out in the sandbox", /^feature\nThis line has a tpyo\.$/m.test(by("bash")?.text ?? ""), by("bash")?.text);
  check("merge is not offered to a review", by("merge")?.error === true, by("merge")?.text);
  check("nor write", by("write")?.error === true, by("write")?.text);
  check("approve is refused by the tool", by("post_review", 0)?.error === true, by("post_review", 0)?.text);
  check("request_changes is posted", by("post_review", 1)?.error === false, by("post_review", 1)?.text);

  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/feature/reviews`, t.secret);
  const review = r.json?.reviews?.[0];
  check("the review is on feature, by the person, with its line comment", r.json?.reviews?.length === 1 && review.verdict === "request_changes" && review.author === t.login && review.comments?.[0]?.line === 4 && review.head === head, scrub(JSON.stringify(review)));
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/feature`, t.secret);
  check("the branch did not move", r.json?.head === head);

  r = await call("POST", `/v1/monorepos/${t.full}/agents/review`, t.secret, { branch: "nope", model: "scripted" });
  check("a branch that is not there: 404", r.status === 404, r.status);
  r = await call("POST", `/v1/monorepos/${t.full}/agents/review`, t.secret, { branch: "main", model: "scripted" });
  check("main is not reviewed: 400", r.status === 400, r.status);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
