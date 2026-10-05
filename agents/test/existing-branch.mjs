// End to end: New agent on an existing branch. The person's branch, with a
// commit of theirs on it, is the agent's workspace as it is: nothing reset,
// the agent's commit lands on top, and Pando made no new branch.
//
//   agents/test/serve.sh start && node agents/test/existing-branch.mjs

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, check, done, git, makeRepo, scrub, tool, untilSettled } from "./lib.mjs";

const t = await makeRepo("agents-eb", { "README.md": "# Existing\n" });

try {
  const src = join(t.work, "src");
  git(["checkout", "-q", "-b", "feature/half-done"], src);
  writeFileSync(join(src, "notes.md"), "started by a person\n");
  git(["add", "notes.md"], src);
  git(["commit", "-qm", "A person's start"], src);
  let g = git(["push", "-q", t.cloneUrl, "feature/half-done"], src, t.secret);
  check("a person's branch with a commit of theirs", g.ok, g.out.slice(-200));
  let r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/feature%2Fhalf-done`, t.secret);
  const before = r.json?.head;

  r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, {
    model: "scripted",
    branch: "feature/half-done",
    prompt: tool("bash", { command: "git branch --show-current; git log --format=%s -2; cat notes.md; echo 'finished by the agent' >> notes.md && git commit -qam 'The agent finishes it' && git push -q origin feature/half-done 2>&1; echo pushed=$?" }),
  });
  check("launched on the existing branch", r.status === 201 && r.json?.branch === "feature/half-done", scrub(JSON.stringify(r.json)));
  r = await untilSettled(t, 1);
  check("the run ends, waiting", r.json?.status === "waiting", JSON.stringify(r.json));

  const out = (await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret)).json.messages.filter((m) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";
  check("the agent works on that branch, with the person's commit and file as they were", /^feature\/half-done\nA person's start\nfirst\nstarted by a person$/m.test(out) && /pushed=0/.test(out), out);

  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/feature%2Fhalf-done/commits`, t.secret);
  const subjects = JSON.stringify(r.json);
  check("its commit lands on top of the person's; nothing was reset", subjects.indexOf("The agent finishes it") < subjects.indexOf("A person's start") && subjects.includes(before), subjects.slice(0, 300));
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches`, t.secret);
  const names = (r.json?.branches ?? []).map((b) => b.name);
  check("no new branch was made (no agent/1)", !names.includes("agent/1") && names.includes("feature/half-done"), names.join(", "));
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
