// Pando without pando-agents (its web e2e runs this way): every agent read
// answers normally from Pando's own records, and everything that needs
// pando-agents refuses clearly (503 agents_unavailable), having made nothing.
// The lists and counts, an issue's and a branch's agents, the models (Pando's
// own Workers AI list), the person's chats: 200. New agent, Address with
// agent, Review with agent and a new chat: 503, with no session, no branch
// and no link made.
//
//   agents/test/serve.sh start-alone && node agents/test/absent.mjs
import { call, check, done, git, makeRepo, scrub } from "./lib.mjs";

const t = await makeRepo("absent", { "README.md": "# Absent\n" });

try {
  const src = `${t.work}/src`;

  git(["checkout", "-qb", "feature"], src);
  git(["commit", "-q", "--allow-empty", "-m", "A feature"], src);
  const g = git(["push", "-q", t.cloneUrl, "feature"], src, t.secret);

  check("a branch to review, pushed", g.ok, g.out.slice(-200));
  let r = await call("POST", `/v1/monorepos/${t.full}/issues`, t.secret, { title: "The README has a typo", body: "tpyo" });

  check("issue #1", r.status === 201, r.status);

  // ── Reads: Pando's own records, 200 ──
  const empty = (x) => x.status === 200 && x.json?.sessions?.length === 0;

  const reads = {
    "the Agents list": `/v1/monorepos/${t.full}/agents`,
    "the working count": `/v1/monorepos/${t.full}/agents?status=working&limit=1`,
    "an issue's agents": `/v1/monorepos/${t.full}/agents?issue=1`,
    "a branch's review agents": `/v1/monorepos/${t.full}/agents?repo=${t.name}&branch=feature&kind=review&status=working`,
    "the person's chats": `/v1/monorepos/${t.full}/assistant`,
  };

  for (const [name, path] of Object.entries(reads)) {
    r = await call("GET", path, t.secret);
    check(`${name}: 200, empty`, empty(r), `${r.status} ${scrub(r.text.slice(0, 200))}`);
  }

  r = await call("GET", `/v1/monorepos/${t.full}/agents`, t.secret);

  check("the counts are zero", r.json?.counts?.all === 0 && r.json.counts.working === 0 && r.json.counts.waiting === 0, JSON.stringify(r.json?.counts));
  r = await call("GET", `/v1/monorepos/${t.full}/agents/models`, t.secret);
  check("the models: 200, Pando's own list (GLM-5.3 Flash)", r.status === 200 && r.json?.models?.map((m) => m.id).join(",") === "@cf/zai-org/glm-5.3-flash", `${r.status} ${r.text.slice(0, 200)}`);
  r = await call("GET", `/v1/monorepos/${t.full}/agents/1`, t.secret);
  check("a session that does not exist: 404", r.status === 404, r.status);

  // ── What needs pando-agents: 503 agents_unavailable, nothing made ──
  const refused = (x) => x.status === 503 && x.json?.error?.code === "agents_unavailable";

  const launches = {
    "New agent": [`/v1/monorepos/${t.full}/agents`, { prompt: "Fix it.", branch: "fix-readme", model: "scripted" }],
    "Address with agent": [`/v1/monorepos/${t.full}/issues/1/agent`, { model: "scripted" }],
    "Review with agent": [`/v1/monorepos/${t.full}/agents/review`, { branch: "feature", model: "scripted" }],
    "a new chat": [`/v1/monorepos/${t.full}/assistant`, { prompt: "Hello?", model: "scripted" }],
  };

  for (const [name, [path, body]] of Object.entries(launches)) {
    r = await call("POST", path, t.secret, body);
    check(`${name}: 503 agents_unavailable`, refused(r), `${r.status} ${scrub(r.text.slice(0, 200))}`);
  }

  r = await call("GET", `/v1/monorepos/${t.full}/agents`, t.secret);

  const chats = await call("GET", `/v1/monorepos/${t.full}/assistant`, t.secret);
  check("no session was recorded", r.json?.sessions?.length === 0 && chats.json?.sessions?.length === 0, `${r.json?.sessions?.length} ${chats.json?.sessions?.length}`);
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches?state=all`, t.secret);
  const names = (r.json?.branches ?? []).map((b) => b.name);
  check("no branch was made (no fix-readme, no 1-the-readme-has-a-typo)", names.join(",") === "feature", names.join(", "));
  r = await call("GET", `/v1/monorepos/${t.full}/issues/1/timeline`, t.secret);
  check("the issue has no branch linked", !JSON.stringify(r.json).includes("1-the-readme"), r.status);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
