// End to end: an agent's sandbox credential works only for its repository
// (credentials.monorepo_id, worker/migrations/0008). The launch never shows
// its secret, so this writes one credential row into the local D1 the way
// the launch does, with a secret it knows, and asks Pando's real auth path:
// its own repository (API and git) opens; another repository of the same
// person, the user routes and that repository's git do not. It also checks
// that a launch writes the scope.
//
//   agents/test/serve.sh start && node agents/test/scope.mjs     (AGENTS_STATE: the server's state folder)

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { call, check, done, git, makeRepo, scrub } from "./lib.mjs";

const STATE = process.env.AGENTS_STATE ?? fileURLToPath(new URL("../.state", import.meta.url));

const WORKER = fileURLToPath(new URL("../../worker", import.meta.url));

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "pando-accounts-dev", "--local", "--persist-to", STATE, "--json", "--command", sql], { cwd: WORKER, encoding: "utf8" });

  return JSON.parse(out)[0].results;
}

const a = await makeRepo("agents-scope", { "README.md": "# Scope A\n" });

const b = await makeRepo("agents-scope", { "README.md": "# Scope B\n" });

try {
  // b's person joins a, so only the credential's scope can refuse.
  let r = await call("PUT", `/v1/monorepos/${a.full}/members/${b.login}`, a.secret, { role: "member" });
  check("b's person is a member of a too", r.status === 200 || r.status === 201, r.status);

  const secret = `pando_${randomBytes(20).toString("hex")}`;
  const hash = createHash("sha256").update(secret).digest("hex");

  d1(`INSERT INTO credentials (id, hash, login, name, kind, created_at, monorepo_id) VALUES ('cred_scope_${Date.now().toString(36)}', '${hash}', '${b.login}', 'cloud-9', 'sandbox', '${new Date().toISOString()}', '${b.monorepoId}')`);

  r = await call("GET", `/v1/monorepos/${b.full}/repos`, secret);
  check("its own repository opens", r.status === 200, r.status);
  let g = git(["ls-remote", b.cloneUrl], b.work, secret);
  check("git on its own repository works", g.ok && /refs\/heads\/main/.test(g.out), scrub(g.out.slice(-200)));
  r = await call("GET", `/v1/monorepos/${a.full}/repos`, secret);
  check("another repository the person belongs to does not (401)", r.status === 401, r.status);
  g = git(["ls-remote", a.cloneUrl], a.work, secret);
  check("nor its git", !g.ok, scrub(g.out.slice(-200)));
  r = await call("GET", "/v1/user", secret);
  check("nor the user routes (401)", r.status === 401, r.status);
  r = await call("GET", "/v1/user/credentials", secret);
  check("so it cannot list or make credentials", r.status === 401, r.status);
  r = await call("GET", `/v1/monorepos/${a.full}/repos`, b.secret);
  check("the person's own machine credential still opens both", r.status === 200, r.status);

  // A launch writes the scope.
  r = await call("POST", `/v1/monorepos/${a.full}/agents`, a.secret, { prompt: "ok", model: "scripted" });
  check("a launch", r.status === 201, r.status);
  const row = d1(`SELECT monorepo_id FROM credentials WHERE login = '${a.login}' AND name = 'cloud-1'`)[0];
  check("its credential is limited to its repository", row?.monorepo_id === a.monorepoId, JSON.stringify(row));
  await call("POST", `/v1/monorepos/${a.full}/agents/1/stop`, a.secret);
} finally {
  for (const t of [a, b]) {
    const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
    check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
  }
}

done();
