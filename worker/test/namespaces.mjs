// Namespaces (NAMESPACES.md): monorepos are owner/name with a permanent id.
//
//   PANDO_URL=http://localhost:8797 node test/namespaces.mjs      (wrangler dev)
//
// Two people own a monorepo of the same name; names match without case; the
// short-name filter; reserved and taken logins; a rename keeps the old git
// URL and API path working; a new monorepo taking an old name says so; a
// transfer; the git door's two shapes; a delete forgets the old names.
// Real git, real Artifacts. Credentials never printed; git never reaches the
// keychain; everything made is deleted.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

const work = mkdtempSync(join(tmpdir(), "pando-ns-"));

const git = (args, cwd, secret) => {
  const r = spawnSync(
    "git",
    ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
    },
  );

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.replace(/pando_[a-f0-9]+/g, "<credential>") };
};

const id = Date.now().toString(36);

const ana = `ana-${id}`;

const bo = `bo-${id}`;

const made = []; // [full_name, secret]

try {
  // ── logins are namespaces ──
  let r = await call("POST", "/v1/users", BOOT, { login: ana.toUpperCase() });
  const A = r.json?.credential?.secret;
  check("a login is kept lower case", r.status === 201 && r.json?.user?.login === ana, `${r.status} ${r.json?.user?.login}`);
  r = await call("POST", "/v1/users", BOOT, { login: bo });
  const B = r.json?.credential?.secret;
  check("a second person", r.status === 201 && !!B);
  r = await call("POST", "/v1/users", BOOT, { login: ana });
  check("a taken login is refused (namespace_taken)", r.status === 409 && r.json?.error?.code === "namespace_taken", `${r.status} ${r.json?.error?.code}`);

  for (const login of ["v1", "login", "settings"]) {
    r = await call("POST", "/v1/users", BOOT, { login });
    check(`the reserved name ${login} is refused as a login`, r.status === 400 && r.json?.error?.code === "reserved_name", `${r.status}`);
  }

  r = await call("POST", "/v1/users", BOOT, { login: `x-${id}-` });
  check("a login ending in a hyphen is refused", r.status === 400, `${r.status}`);

  // ── two owners, one name ──
  const name = `acme-${id}`;
  r = await call("POST", "/v1/monorepos", A, { name, kind: "repo" });
  const a1 = r.json?.monorepo;

  if (r.status === 201) made.push([a1.full_name, A]);
  const aUrl = r.json?.repos?.[0]?.clone_url;
  check("ana makes ana/acme, a plain repo at /ana/acme.git", r.status === 201 && a1?.full_name === `${ana}/${name}` && aUrl === `${URL_}/${ana}/${name}.git`, `${r.status} ${aUrl}`);
  r = await call("POST", "/v1/monorepos", B, { name: name.toUpperCase() });
  const b1 = r.json?.monorepo;

  if (r.status === 201) made.push([b1.full_name, B]);
  check("bo makes bo/acme too (the name is unique per owner only), lower case", r.status === 201 && b1?.full_name === `${bo}/${name}` && b1?.id !== a1?.id, `${r.status} ${b1?.full_name}`);
  r = await call("POST", "/v1/monorepos", A, { name });
  check("ana can't make ana/acme twice", r.status === 409 && r.json?.error?.code === "monorepo_exists", `${r.status}`);
  r = await call("POST", "/v1/monorepos", A, { name: `x-${id}`, owner: bo });
  check("nobody makes monorepos in another person's namespace", r.status === 403 && r.json?.error?.code === "not_your_namespace", `${r.status}`);

  r = await call("GET", `/v1/monorepos/${ana.toUpperCase()}/${name.toUpperCase()}`, A);
  check("owner/name match without case", r.status === 200 && r.json?.id === a1?.id && r.json?.full_name === `${ana}/${name}`, `${r.status}`);
  r = await call("GET", `/v1/monorepos/${name}`, A);
  check("the old one-segment path is gone (404)", r.status === 404, `${r.status}`);

  // ── git: push, and the door's two shapes ──
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# ns\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  let g = git(["push", "-q", aUrl, "main"], src, A);
  check("push main to /ana/acme.git", g.ok, g.out.slice(-200));
  // git only says "not found"; the door's answer says why.
  const refs = (path, secret) => fetch(`${URL_}${path}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${secret}` } }).then(async (x) => ({ status: x.status, text: await x.text() }));
  let d = await refs(`/${ana}/${name}/${name}.git`, A);
  check("a plain repo has no /owner/name/repo.git URL", d.status === 404 && /plain git repo/.test(d.text), `${d.status} ${d.text.slice(0, 120)}`);
  d = await refs(`/${bo}/${name}.git`, B);
  check("a monorepo has no /owner/name.git URL", d.status === 404 && /is a monorepo/.test(d.text), `${d.status} ${d.text.slice(0, 120)}`);
  g = git(["ls-remote", `${URL_}/${bo}/${name}/meta.git`], work, B);
  check("a monorepo's meta repo is /owner/monorepo/meta.git", g.ok, g.out.slice(-200));

  // ── the short-name filter ──
  r = await call("PUT", `/v1/monorepos/${ana}/${name}/members/${bo}`, A, { role: "member" });
  check("ana adds bo to ana/acme", r.status === 200, `${r.status}`);
  r = await call("GET", `/v1/monorepos?name=${name.toUpperCase()}`, B);
  const names = (r.json?.monorepos ?? []).map((m) => m.full_name);
  check("?name= lists bo's monorepos with that name, his own first", r.status === 200 && names.join(",") === `${bo}/${name},${ana}/${name}`, names.join(","));
  r = await call("GET", `/v1/monorepos?name=nothing-${id}`, B);
  check("?name= with no match is an empty list", r.status === 200 && r.json?.monorepos?.length === 0);

  // ── rename: the old name keeps working ──
  const renamed = `acme2-${id}`;
  r = await call("PATCH", `/v1/monorepos/${ana}/${name}`, B, { name: renamed });
  check("a member can't rename", r.status === 403, `${r.status}`);
  r = await call("PATCH", `/v1/monorepos/${ana}/${name}`, A, { name: renamed });

  if (r.status === 200) made[0][0] = `${ana}/${renamed}`;
  check("ana renames ana/acme to ana/acme2: same id", r.status === 200 && r.json?.full_name === `${ana}/${renamed}` && r.json?.id === a1?.id && r.json?.replaced_alias === null, `${r.status} ${r.json?.full_name}`);
  r = await call("GET", `/v1/monorepos/${ana}/${name}`, A);
  check("the old path still answers, with the new name", r.status === 200 && r.json?.full_name === `${ana}/${renamed}`, `${r.status} ${r.json?.full_name}`);
  r = await call("GET", `/v1/monorepos/${ana}/${renamed}/repos`, A);
  check("repos now show the new git URL", r.json?.repos?.[0]?.clone_url === `${URL_}/${ana}/${renamed}.git`, r.json?.repos?.[0]?.clone_url);
  g = git(["ls-remote", aUrl], work, A);
  check("the old git URL still works", g.ok && /refs\/heads\/main/.test(g.out), g.out.slice(-200));
  writeFileSync(join(src, "README.md"), "# ns\nmore\n");
  git(["commit", "-qam", "second"], src);
  g = git(["push", "-q", `${URL_}/${ana}/${renamed}.git`, "main:next"], src, A);
  check("and the new one takes a push", g.ok, g.out.slice(-200));
  r = await call("PATCH", `/v1/monorepos/${ana}/${renamed}`, A, { name: "bad--name" });
  check("a bad name is refused", r.status === 400, `${r.status}`);

  // ── the old name is taken by a new monorepo: said, not silent ──
  r = await call("POST", "/v1/monorepos", A, { name, kind: "repo" });
  const a3 = r.json?.monorepo;

  if (r.status === 201) made.push([a3.full_name, A]);
  check(
    "a new ana/acme takes the old name over and says where it led",
    r.status === 201 && a3?.id !== a1?.id && r.json?.replaced_alias?.full_name === `${ana}/${name}` && r.json?.replaced_alias?.pointed_to === `${ana}/${renamed}`,
    JSON.stringify(r.json?.replaced_alias),
  );
  r = await call("GET", `/v1/monorepos/${ana}/${name}`, A);
  check("ana/acme is now the new one", r.status === 200 && r.json?.id === a3?.id);
  r = await call("PATCH", `/v1/monorepos/${ana}/${renamed}`, A, { name });
  check("renaming onto a taken name is refused", r.status === 409 && r.json?.error?.code === "monorepo_exists", `${r.status}`);

  // ── transfer ──
  r = await call("PATCH", `/v1/monorepos/${ana}/${renamed}`, A, { owner: bo });
  check("a transfer needs the new owner to be an owner of it already", r.status === 400 && r.json?.error?.code === "bad_owner", `${r.status}`);
  await call("PUT", `/v1/monorepos/${ana}/${renamed}/members/${bo}`, A, { role: "owner" });
  r = await call("PATCH", `/v1/monorepos/${ana}/${renamed}`, A, { owner: bo });

  if (r.status === 200) made[0][0] = `${bo}/${renamed}`;
  check("ana transfers it to bo: bo/acme2, same id", r.status === 200 && r.json?.full_name === `${bo}/${renamed}` && r.json?.id === a1?.id, `${r.status} ${r.json?.full_name}`);
  g = git(["ls-remote", aUrl], work, A);
  check("the first git URL (/ana/acme.git) now leads to the new ana/acme, which is empty", g.ok && !/refs\/heads\/main/.test(g.out), g.out.slice(-200));
  g = git(["ls-remote", `${URL_}/${ana}/${renamed}.git`], work, B);
  check("ana/acme2 (the name before the transfer) still leads to bo/acme2", g.ok && /refs\/heads\/main/.test(g.out), g.out.slice(-200));

  // ── delete forgets the old names ──
  r = await call("DELETE", `/v1/monorepos/${bo}/${renamed}?confirm=${bo}/${renamed}`, B);

  if (r.status === 204) made.shift();
  check("bo deletes bo/acme2 (confirm with the full name)", r.status === 204, `${r.status}`);
  r = await call("GET", `/v1/monorepos/${ana}/${renamed}`, B);
  check("its old names are gone with it", r.status === 404, `${r.status}`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const [full, secret] of made) {
    const r = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, secret);
    check(`delete ${full}`, r.status === 204, `${r.status}`);
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
