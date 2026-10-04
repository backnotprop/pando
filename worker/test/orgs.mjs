// Organizations (profile SPEC section 8.2), end to end against `wrangler dev`:
// real git through the door, real Artifacts, real local D1, the pando-feed
// queue, and a stand-in WorkOS for the first sign-in of an invited email.
//
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to <dir>
//   npx wrangler dev --port 8821 --persist-to <dir> --var FEED_TEST:1 --var FEED_TICK_MS:500
//
// FEED_TEST:1 is required: the home feed's checks read /v1/_feed/test, and
// without it they fail, saying so.
//   PANDO_URL=http://localhost:8821 PANDO_WORKOS_STANDIN_PORT=8822 node test/orgs.mjs
//
// worker/.dev.vars points WORKOS_API_BASE at http://127.0.0.1:<the stand-in's port>.
// The stand-in plays WorkOS's device flow (`pando login`), as browser.mjs's
// does: it signs in whoever the test names.
//
// Covered: create and the namespace race; reserved and taken names; whose
// `/{name}` is; an org member opens and pushes to an org monorepo with no row
// of their own, and a non-member can't; outside members; an owner's powers
// against a member's; the last owner; removal ends access (and the home's
// feed leaves); an invite becomes a membership at first sign-in; create in an
// org; transfer in and out, the old address still cloning and pushing;
// "your monorepos", ?owner= and the activity by owner; Member.via.
// Credentials are never printed; git never reaches the keychain. It deletes
// every monorepo it made (organizations can't be deleted yet).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8821").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const STANDIN_PORT = Number(process.env.PANDO_WORKOS_STANDIN_PORT ?? 8822);

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(probe, ms = 20_000) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await probe();

    if (v) return v;
    await sleep(300);
  }

  return null;
}

const work = mkdtempSync(join(tmpdir(), "pando-orgs-"));

const git = (args, cwd, secret) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });

  return { ok: r.status === 0, out: scrub(`${r.stdout}${r.stderr}`) };
};

/** A socket that collects JSON frames (the person's /v1/events). */
function openSocket(path, secret) {
  const s = { frames: [], open: false, ws: new WebSocket(WS_ + path, { headers: { authorization: `Bearer ${secret}` } }) };
  s.ws.onopen = () => (s.open = true);

  s.ws.onmessage = (e) => {
    if (e.data !== "pong") s.frames.push(JSON.parse(e.data));
  };

  return s;
}

const NO_FEED_ROUTE = "no /v1/_feed/test: start the server with --var FEED_TEST:1";

/** A person's feed as the test route shows it; throws when the route is not there, so no feed check passes untested. */
async function debugFeed(login) {
  const r = await call("GET", `/v1/_feed/test?login=${login}`, BOOT);

  if (r.status !== 200) throw new Error(`${NO_FEED_ROUTE} (${r.status})`);

  return r.json;
}

/** Whether the person's feed has the monorepo (joined, not pending) or not, as wanted, within the wait. A missing test route is a failure with its reason. */
async function feedHas(login, monorepoId, want = true) {
  try {
    const ok = await waitFor(async () => ((await debugFeed(login)).index?.some((r) => r.name === monorepoId && !r.pending) ?? false) === want);

    return [!!ok, ok ? "" : `the feed ${want ? "never joined" : "never left"} within 20 s`];
  } catch (err) {
    return [false, err instanceof Error ? err.message : String(err)];
  }
}

// ── The stand-in WorkOS: the device flow, as browser.mjs's stand-in plays it ──
let nextUser = null;

const devices = new Map();

const standin = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = (status, v) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

    if (req.method === "POST" && req.url === "/user_management/authorize/device") {
      const device_code = `dev_${devices.size + 1}_${Date.now()}`;
      devices.set(device_code, nextUser);

      return json(200, { device_code, user_code: "ABCD-EFGH", verification_uri: "https://example.invalid/device", verification_uri_complete: "https://example.invalid/device?code=ABCD-EFGH", expires_in: 300, interval: 1 });
    }

    if (req.method === "POST" && req.url === "/user_management/authenticate") {
      const user = devices.get(new URLSearchParams(body).get("device_code"));

      return user ? json(200, { user, access_token: "x.e30.sig", refresh_token: "r" }) : json(400, { error: "invalid_grant" });
    }

    res.writeHead(404).end();
  });
});

await new Promise((r) => standin.listen(STANDIN_PORT, "127.0.0.1", r));

/** `pando login` as a WorkOS user: the Pando user and a machine credential, and the monorepos it joined. */
async function deviceSignIn(user) {
  nextUser = user;
  const start = await call("POST", "/v1/login/device");
  const r = await call("POST", "/v1/login/token", null, { device_code: start.json?.device_code, credential_name: `${user.email}-laptop` });

  return { status: r.status, login: r.json?.user?.login, secret: r.json?.credential?.secret, joined: r.json?.joined ?? [] };
}

const id = Date.now().toString(36);

const L = { ramos: `ramos-${id}`, ana: `ana-${id}`, ben: `ben-${id}`, lee: `lee-${id}` };

const ORG = `pl-${id}`;

const S = {};

/** Monorepos to delete at the end: [full name now, an owner's secret]. */
const made = new Map();

const sockets = [];

const role = (list, login) => list?.find((m) => m.login === login);

try {
  for (const [who, login] of Object.entries(L)) {
    S[who] = (await call("POST", "/v1/users", BOOT, { login, name: who, credential_name: `${who}-mbp` })).json?.credential?.secret;
  }

  check("four people", Object.values(S).every(Boolean));

  // ── 1. Create: the namespace rule, the race, whose /{name} is ──
  let r = await call("POST", "/v1/orgs", S.ramos, { login: ORG.toUpperCase(), name: "Plannotator" });
  check(
    "ramos makes an org (lower case); he is its only owner",
    r.status === 201 && r.json?.type === "org" && r.json?.login === ORG && r.json?.name === "Plannotator" && r.json?.role === "owner" && r.json?.members === 1,
    `${r.status} ${JSON.stringify(r.json)}`,
  );
  r = await call("POST", "/v1/orgs", S.ana, { login: ORG });
  check("the same name again is taken (409 namespace_taken)", r.status === 409 && r.json?.error?.code === "namespace_taken", `${r.status}`);
  r = await call("POST", "/v1/orgs", S.ana, { login: L.ben });
  check("a person's login is taken for an org too", r.status === 409 && r.json?.error?.code === "namespace_taken", `${r.status}`);
  r = await call("POST", "/v1/users", BOOT, { login: ORG });
  check("and an org's name is taken for a person", r.status === 409 && r.json?.error?.code === "namespace_taken", `${r.status}`);

  for (const name of ["settings", "orgs", "docs"]) {
    r = await call("POST", "/v1/orgs", S.ana, { login: name });
    check(`the reserved name ${name} is refused (400 reserved_name)`, r.status === 400 && r.json?.error?.code === "reserved_name", `${r.status}`);
  }

  r = await call("POST", "/v1/orgs", S.ana, { login: "bad--name" });
  check("a name outside the namespace rule is refused (400)", r.status === 400 && r.json?.error?.code === "bad_request", `${r.status}`);
  const race = `race-${id}`;
  const both = await Promise.all([call("POST", "/v1/orgs", S.ramos, { login: race }), call("POST", "/v1/orgs", S.ana, { login: race })]);
  const statuses = both.map((x) => x.status).sort().join(",");
  const winner = both[0].status === 201 ? "ramos" : "ana";
  r = await call("GET", `/v1/orgs/${race}/members`, S[winner]);
  check(
    "two creates of one name at once: one 201, one 409, and only the winner is in it",
    statuses === "201,409" && r.json?.members?.length === 1 && r.json.members[0].login === L[winner] && r.json.members[0].role === "owner",
    `${statuses} ${JSON.stringify(r.json?.members?.map((m) => m.login))}`,
  );

  r = await call("GET", `/v1/users/${ORG}`, S.ben);
  check("GET /v1/users/{org}: an org, with no role or count for someone outside it", r.status === 200 && r.json?.type === "org" && r.json?.role === null && r.json?.members === null, JSON.stringify(r.json));
  r = await call("GET", `/v1/users/${L.ramos.toUpperCase()}`, S.ben);
  check(
    "GET /v1/users/{login}: a person, today's fields only (no email)",
    r.status === 200 && r.json?.type === "user" && r.json?.login === L.ramos && Object.keys(r.json).sort().join() === "created_at,login,name,picture_url,type",
    JSON.stringify(r.json),
  );
  r = await call("GET", `/v1/users/nobody-${id}`, S.ben);
  check("GET /v1/users/{name}: 404 for neither", r.status === 404, `${r.status}`);
  r = await call("GET", "/v1/user/orgs", S.ramos);
  check("ramos's orgs list it, with his role", r.status === 200 && r.json?.orgs?.some((o) => o.login === ORG && o.role === "owner" && o.members === 1), JSON.stringify(r.json?.orgs?.map((o) => o.login)));

  // ── 2. Members and access: ana is in the org, with no row of her own in its monorepo ──
  r = await call("PUT", `/v1/orgs/${ORG}/members/${L.ana}`, S.ramos, { role: "member" });
  check("ramos adds ana by login", r.status === 200 && r.json?.login === L.ana && r.json?.role === "member" && r.json?.added_by === L.ramos, `${r.status}`);
  r = await call("POST", "/v1/monorepos", S.ramos, { name: "ws", owner: ORG, kind: "repo" });
  const ws = r.json?.monorepo;

  if (r.status === 201) made.set(ws.id, [ws.full_name, S.ramos]);
  check("ramos makes org/ws in the org: owner_type org, he owns it", r.status === 201 && ws?.full_name === `${ORG}/ws` && ws?.owner_type === "org" && ws?.role === "owner", `${r.status} ${JSON.stringify(ws)}`);
  const wsUrl = r.json?.repos?.[0]?.clone_url;
  const src = join(work, "ws");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# ws\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  let g = git(["push", "-q", wsUrl, "main"], src, S.ramos);
  check("ramos pushes main to /org/ws.git", g.ok, g.out.slice(-200));

  r = await call("GET", `/v1/monorepos/${ORG}/ws`, S.ana);
  check("ana opens it through the org: role member, owner_type org", r.status === 200 && r.json?.role === "member" && r.json?.owner_type === "org", `${r.status} ${JSON.stringify(r.json)}`);
  g = git(["clone", "-q", wsUrl, join(work, "ws-ana")], work, S.ana);
  check("ana clones it through the git door", g.ok, g.out.slice(-200));
  writeFileSync(join(work, "ws-ana", "ana.txt"), "ana\n");
  git(["checkout", "-qb", "ana/first"], join(work, "ws-ana"));
  git(["add", "-A"], join(work, "ws-ana"));
  git(["commit", "-qm", "ana's change"], join(work, "ws-ana"));
  g = git(["push", "-q", "origin", "ana/first"], join(work, "ws-ana"), S.ana);
  check("and pushes a branch", g.ok, g.out.slice(-200));
  r = await call("GET", "/v1/monorepos", S.ana);
  check("ana's monorepos list it (role member, owner_type org)", r.json?.monorepos?.some((m) => m.id === ws?.id && m.role === "member" && m.owner_type === "org"), JSON.stringify(r.json?.monorepos?.map((m) => m.full_name)));
  r = await call("GET", `/v1/monorepos/${ORG}/ws`, S.ben);
  check("ben, not in the org, is refused on the API", r.status === 403 || r.status === 404, `${r.status} ${r.json?.error?.code}`);
  g = git(["ls-remote", wsUrl], work, S.ben);
  check("and at the git door", !g.ok, g.out.slice(-120));
  check("ana's home feed joined it (a member message per org monorepo)", ...(await feedHas(L.ana, ws?.id)));

  // ── 3. Outside members: lee is added to one org monorepo only ──
  r = await call("PUT", `/v1/monorepos/${ORG}/ws/members/${L.lee}`, S.ramos, { role: "member" });
  check("ramos adds lee to org/ws itself", r.status === 200 && r.json?.via === "direct", `${r.status} ${JSON.stringify(r.json)}`);
  r = await call("POST", "/v1/monorepos", S.ana, { name: "new-thing", owner: ORG, kind: "repo" });
  const nt = r.json?.monorepo;

  if (r.status === 201) made.set(nt.id, [nt.full_name, S.ana]);
  check("ana, a member, makes org/new-thing: she owns it by her own row", r.status === 201 && nt?.role === "owner" && nt?.owner_type === "org", `${r.status}`);
  r = await call("GET", `/v1/monorepos/${ORG}/ws`, S.lee);
  check("lee opens org/ws", r.status === 200 && r.json?.role === "member", `${r.status}`);
  r = await call("GET", `/v1/monorepos/${ORG}/new-thing`, S.lee);
  check("but not the org's other monorepos", r.status === 403 || r.status === 404, `${r.status}`);

  // ── Member.via ──
  r = await call("GET", `/v1/monorepos/${ORG}/new-thing/members`, S.ana);
  let ms = r.json?.members;
  check(
    "new-thing's members: ana both (owner), ramos by the org (owner)",
    role(ms, L.ana)?.via === "both" && role(ms, L.ana)?.role === "owner" && role(ms, L.ramos)?.via === "org" && role(ms, L.ramos)?.role === "owner" && ms?.length === 2,
    JSON.stringify(ms?.map((m) => [m.login, m.role, m.via])),
  );
  r = await call("GET", `/v1/monorepos/${ORG}/ws/members`, S.ana);
  ms = r.json?.members;
  check(
    "ws's members: ramos both, ana by the org, lee direct",
    role(ms, L.ramos)?.via === "both" && role(ms, L.ana)?.via === "org" && role(ms, L.ana)?.role === "member" && role(ms, L.lee)?.via === "direct",
    JSON.stringify(ms?.map((m) => [m.login, m.role, m.via])),
  );

  // ── 4. An owner's powers against a member's ──
  r = await call("PATCH", `/v1/monorepos/${ORG}/new-thing`, S.ramos, { name: "new-thing2" });

  if (r.status === 200) made.set(nt.id, [r.json.full_name, S.ana]);
  check("ramos, an org owner with no row of his own, renames org/new-thing", r.status === 200 && r.json?.full_name === `${ORG}/new-thing2`, `${r.status}`);
  r = await call("PATCH", `/v1/monorepos/${ORG}/ws`, S.ana, { name: "ws-x" });
  check("ana, an org member, can't rename org/ws (403)", r.status === 403, `${r.status}`);
  r = await call("PUT", `/v1/orgs/${ORG}/members/${L.ben}`, S.ana, { role: "member" });
  check("a member can't add people (403 owner_only)", r.status === 403 && r.json?.error?.code === "owner_only", `${r.status}`);
  r = await call("PATCH", `/v1/orgs/${ORG}`, S.ana, { description: "x" });
  check("or change the org's details", r.status === 403, `${r.status}`);
  r = await call("POST", `/v1/orgs/${ORG}/invites`, S.ana, { email: "x@pando.invalid" });
  check("or invite", r.status === 403, `${r.status}`);
  r = await call("GET", `/v1/orgs/${ORG}/members`, S.ana);
  check("a member lists the org's people with their roles", r.status === 200 && role(r.json?.members, L.ramos)?.role === "owner" && role(r.json?.members, L.ana)?.role === "member", `${r.status}`);
  r = await call("GET", `/v1/orgs/${ORG}/members`, S.ben);
  check("someone outside it can't (403)", r.status === 403, `${r.status}`);
  r = await call("GET", `/v1/orgs/${ORG}`, S.ana);
  check("the org's header shows ana her role and the count", r.json?.role === "member" && r.json?.members === 2, JSON.stringify(r.json));
  r = await call("PATCH", `/v1/orgs/${ORG}`, S.ramos, { description: "Plans and code", website: "https://plannotator.ai" });
  check("the owner sets the description and website", r.status === 200 && r.json?.description === "Plans and code" && r.json?.website === "https://plannotator.ai" && r.json?.name === "Plannotator", JSON.stringify(r.json));
  r = await call("PATCH", `/v1/orgs/${ORG}`, S.ramos, { website: "http://plannotator.ai" });
  check("a website that is not https is refused (400)", r.status === 400, `${r.status}`);
  r = await call("POST", "/v1/monorepos", S.ben, { name: "nope", owner: ORG });
  check("ben, outside it, can't make a monorepo there (403 not_your_namespace)", r.status === 403 && r.json?.error?.code === "not_your_namespace", `${r.status}`);

  // ── 5. The last owner ──
  r = await call("PUT", `/v1/orgs/${ORG}/members/${L.ramos}`, S.ramos, { role: "member" });
  check("the only owner can't be made a member (409 last_owner)", r.status === 409 && r.json?.error?.code === "last_owner", `${r.status}`);
  r = await call("DELETE", `/v1/orgs/${ORG}/members/${L.ramos}`, S.ramos);
  check("or leave (409 last_owner)", r.status === 409 && r.json?.error?.code === "last_owner", `${r.status}`);
  await call("PUT", `/v1/orgs/${ORG}/members/${L.ana}`, S.ramos, { role: "owner" });
  // Each owner demotes the other at once. The loser is refused by the write (409) or, when the other write landed first, as no longer an owner (403).
  const demote = await Promise.all([call("PUT", `/v1/orgs/${ORG}/members/${L.ana}`, S.ramos, { role: "member" }), call("PUT", `/v1/orgs/${ORG}/members/${L.ramos}`, S.ana, { role: "member" })]);
  r = await call("GET", `/v1/orgs/${ORG}/members`, S.ramos);
  const owners = r.json?.members?.filter((m) => m.role === "owner").length;
  const codes = demote.map((x) => x.status).sort().join(",");
  check("two demotions at once leave one owner", (codes === "200,409" || codes === "200,403") && owners === 1, `${codes} owners ${owners}`);
  const ownerNow = role(r.json?.members, L.ramos)?.role === "owner" ? "ramos" : "ana";
  await call("PUT", `/v1/orgs/${ORG}/members/${L.ramos}`, S[ownerNow], { role: "owner" });
  await call("PUT", `/v1/orgs/${ORG}/members/${L.ana}`, S.ramos, { role: "member" });
  r = await call("GET", `/v1/orgs/${ORG}/members`, S.ramos);
  check("back to ramos the owner, ana a member", role(r.json?.members, L.ramos)?.role === "owner" && role(r.json?.members, L.ana)?.role === "member");

  r = await call("PUT", `/v1/monorepos/${ORG}/ws/members/${L.ramos}`, S.ramos, { role: "member" });
  check("an org monorepo's last owner row may become a member (its org's owners own it)", r.status === 200 && r.json?.role === "owner" && r.json?.via === "both", `${r.status} ${JSON.stringify(r.json)}`);
  r = await call("DELETE", `/v1/monorepos/${ORG}/ws/members/${L.ramos}`, S.ramos);
  check("and be removed", r.status === 204, `${r.status}`);
  r = await call("GET", `/v1/monorepos/${ORG}/ws`, S.ramos);
  check("with no owner row, ramos still owns it through the org", r.status === 200 && r.json?.role === "owner", `${r.status}`);
  g = git(["ls-remote", wsUrl], work, S.ramos);
  check("and git still works for him", g.ok, g.out.slice(-200));
  r = await call("POST", "/v1/monorepos", S.ben, { name: `solo-${id}`, kind: "repo" });

  if (r.status === 201) made.set(r.json.monorepo.id, [r.json.monorepo.full_name, S.ben]);
  r = await call("PUT", `/v1/monorepos/${L.ben}/solo-${id}/members/${L.ben}`, S.ben, { role: "member" });
  check("a person's monorepo still keeps one owner (409 last_owner)", r.status === 409 && r.json?.error?.code === "last_owner", `${r.status}`);

  // ── 6. Removal ends access; the home's feed leaves ──
  const anaLive = openSocket("/v1/events", S.ana);
  sockets.push(anaLive);
  await waitFor(() => anaLive.open, 10_000);
  r = await call("DELETE", `/v1/orgs/${ORG}/members/${L.ana}`, S.ramos);
  check("ramos removes ana from the org", r.status === 204, `${r.status}`);
  const t0 = Date.now();
  const refused = await waitFor(async () => !git(["ls-remote", wsUrl], work, S.ana).ok, 20_000);
  check("within 20 s ana's git is refused", !!refused, `${Date.now() - t0} ms`);
  writeFileSync(join(work, "ws-ana", "ana.txt"), "ana again\n");
  git(["commit", "-qam", "again"], join(work, "ws-ana"));
  g = git(["push", "-q", "origin", "ana/first"], join(work, "ws-ana"), S.ana);
  check("and her push", !g.ok, g.out.slice(-120));
  r = await call("GET", `/v1/monorepos/${ORG}/new-thing2`, S.ana);
  check("she keeps org/new-thing2 by her own row", r.status === 200 && r.json?.role === "owner", `${r.status}`);
  check("her home's feed left org/ws", ...(await feedHas(L.ana, ws?.id, false)));
  check("her socket got a left frame", !!(await waitFor(() => anaLive.frames.some((f) => f.type === "left" && f.monorepo_id === ws?.id), 10_000)), JSON.stringify(anaLive.frames.map((f) => f.type)));

  r = await call("PUT", `/v1/orgs/${ORG}/members/${L.ana}`, S.ramos, { role: "member" });
  check("ana is added back", r.status === 200);
  check("her socket got a joined frame", !!(await waitFor(() => anaLive.frames.some((f) => f.type === "joined" && f.monorepo_id === ws?.id), 15_000)));
  r = await call("PUT", `/v1/orgs/${ORG}/members/${L.lee}`, S.ramos, { role: "member" });
  r = await call("DELETE", `/v1/orgs/${ORG}/members/${L.lee}`, S.lee);
  check("a member leaves on their own (204)", r.status === 204, `${r.status}`);
  r = await call("GET", `/v1/monorepos/${ORG}/ws`, S.lee);
  check("and keeps what was given to them directly", r.status === 200 && r.json?.role === "member", `${r.status}`);
  r = await call("DELETE", `/v1/orgs/${ORG}/members/${L.ana}`, S.lee);
  check("someone outside it can't remove people", r.status === 403, `${r.status}`);

  // ── 7. Invites: added at once with an account, else at that email's first sign-in ──
  const zoeEmail = `zoe-${id}@pando.invalid`;
  r = await call("POST", `/v1/orgs/${ORG}/invites`, S.ramos, { email: zoeEmail.toUpperCase(), role: "member" });
  check("an invite for an email with no account waits (201 invited)", r.status === 201 && r.json?.status === "invited" && r.json?.invite?.email === zoeEmail, `${r.status}`);
  r = await call("GET", `/v1/orgs/${ORG}/invites`, S.ana);
  check("its people see it waiting", r.json?.invites?.some((i) => i.email === zoeEmail && i.invited_by === L.ramos), `${r.status}`);
  const zoe = await deviceSignIn({ id: `user_zoe_${id}`, email: zoeEmail, email_verified: true, first_name: "Zoe", last_name: null });
  check("zoe signs in for the first time (pando login, the stand-in)", zoe.status === 200 && !!zoe.secret, `${zoe.status}`);
  check("her sign-in says she joined the org's monorepos", zoe.joined.includes(`${ORG}/ws`) && zoe.joined.includes(`${ORG}/new-thing2`), JSON.stringify(zoe.joined));
  r = await call("GET", `/v1/orgs/${ORG}/members`, S.ramos);
  check("she is a member of the org", role(r.json?.members, zoe.login)?.role === "member", JSON.stringify(r.json?.members?.map((m) => m.login)));
  r = await call("GET", "/v1/monorepos?summary=1", zoe.secret);
  check("the org's monorepos are on her home", [ws?.id, nt?.id].every((m) => r.json?.monorepos?.some((x) => x.id === m)), JSON.stringify(r.json?.monorepos?.map((m) => m.full_name)));
  r = await call("GET", `/v1/orgs/${ORG}/invites`, S.ramos);
  check("and the invite is used up", !r.json?.invites?.some((i) => i.email === zoeEmail));
  await call("DELETE", `/v1/orgs/${ORG}/members/${zoe.login}`, S.ramos);
  r = await call("POST", `/v1/orgs/${ORG}/invites`, S.ramos, { email: zoeEmail });
  check("an invite for an email that has signed in adds her at once (200 added)", r.status === 200 && r.json?.status === "added" && r.json?.member?.login === zoe.login, `${r.status}`);
  r = await call("POST", `/v1/orgs/${ORG}/invites`, S.ramos, { email: `nobody-${id}@pando.invalid` });
  r = await call("DELETE", `/v1/orgs/${ORG}/invites/${encodeURIComponent(`nobody-${id}@pando.invalid`)}`, S.ramos);
  const again = await call("DELETE", `/v1/orgs/${ORG}/invites/${encodeURIComponent(`nobody-${id}@pando.invalid`)}`, S.ramos);
  check("an owner withdraws an invite (204, then 404)", r.status === 204 && again.status === 404, `${r.status} ${again.status}`);

  // ── 8. Transfer into the org and out: the old address keeps working ──
  r = await call("POST", "/v1/monorepos", S.ramos, { name: "brand", kind: "repo" });
  const brand = r.json?.monorepo;

  if (r.status === 201) made.set(brand.id, [brand.full_name, S.ramos]);
  const brandUrl = r.json?.repos?.[0]?.clone_url;
  const bsrc = join(work, "brand");
  mkdirSync(bsrc);
  git(["init", "-q"], bsrc);
  writeFileSync(join(bsrc, "README.md"), "# brand\n");
  git(["add", "-A"], bsrc);
  git(["commit", "-qm", "first"], bsrc);
  git(["push", "-q", brandUrl, "main"], bsrc, S.ramos);
  await call("PUT", `/v1/monorepos/${L.ramos}/brand/members/${L.lee}`, S.ramos, { role: "member" });
  await call("POST", "/v1/orgs", S.ben, { login: `bens-${id}` });
  r = await call("PATCH", `/v1/monorepos/${L.ramos}/brand`, S.ramos, { owner: `bens-${id}` });
  check("a transfer to an org ramos is not in is refused (403 not_your_namespace)", r.status === 403 && r.json?.error?.code === "not_your_namespace", `${r.status}`);
  r = await call("PATCH", `/v1/monorepos/${L.ramos}/brand`, S.ramos, { owner: ORG });

  if (r.status === 200) made.set(brand.id, [r.json.full_name, S.ramos]);
  check("ramos moves ramos/brand into the org: org/brand, same id", r.status === 200 && r.json?.full_name === `${ORG}/brand` && r.json?.id === brand?.id && r.json?.owner_type === "org", `${r.status} ${JSON.stringify(r.json)}`);
  r = await call("GET", `/v1/monorepos/${L.ramos}/brand`, S.ramos);
  check("the old API path answers with the new name", r.status === 200 && r.json?.full_name === `${ORG}/brand`, `${r.status}`);
  writeFileSync(join(bsrc, "two.txt"), "two\n");
  git(["checkout", "-qb", "after-move"], bsrc);
  git(["add", "-A"], bsrc);
  git(["commit", "-qm", "after the move"], bsrc);
  g = git(["push", "-q", brandUrl, "after-move"], bsrc, S.ramos);
  check("the old git remote (/ramos/brand.git) still takes a push", g.ok, g.out.slice(-200));
  g = git(["clone", "-q", brandUrl, join(work, "brand-ana")], work, S.ana);
  check("ana, in the org, clones it by the old address", g.ok, g.out.slice(-200));
  check("ana's socket got a joined frame for it", !!(await waitFor(() => anaLive.frames.some((f) => f.type === "joined" && f.monorepo_id === brand?.id), 15_000)));
  r = await call("GET", `/v1/monorepos/${ORG}/brand`, S.lee);
  check("its own member lee keeps it", r.status === 200 && r.json?.role === "member", `${r.status}`);
  r = await call("PATCH", `/v1/monorepos/${ORG}/brand`, S.ramos, { owner: L.ben });
  check("to ben, who is no owner of it: 400 bad_owner", r.status === 400 && r.json?.error?.code === "bad_owner", `${r.status}`);
  r = await call("PATCH", `/v1/monorepos/${ORG}/brand`, S.ramos, { owner: L.ramos });

  if (r.status === 200) made.set(brand.id, [r.json.full_name, S.ramos]);
  check("back to ramos (he owns it): ramos/brand", r.status === 200 && r.json?.full_name === `${L.ramos}/brand` && r.json?.owner_type === "user", `${r.status}`);
  check("ana's home feed leaves it", ...(await feedHas(L.ana, brand?.id, false)));
  r = await call("GET", `/v1/monorepos/${L.ramos}/brand`, S.ana);
  check("and ana can't open it any more", r.status === 403 || r.status === 404, `${r.status}`);
  r = await call("PATCH", `/v1/monorepos/${L.ramos}/brand`, S.ramos, { owner: ORG });

  if (r.status === 200) made.set(brand.id, [r.json.full_name, S.ramos]);
  r = await call("PUT", `/v1/monorepos/${ORG}/brand/members/${L.ramos}`, S.ramos, { role: "member" });
  r = await call("PATCH", `/v1/monorepos/${ORG}/brand`, S.ramos, { owner: L.ramos });

  if (r.status === 200) made.set(brand.id, [r.json.full_name, S.ramos]);
  ms = (await call("GET", `/v1/monorepos/${L.ramos}/brand/members`, S.ramos)).json?.members;
  check(
    "an org owner with only a member row moves it to himself: he gets his own owner row",
    r.status === 200 && role(ms, L.ramos)?.role === "owner" && role(ms, L.ramos)?.via === "direct",
    `${r.status} ${JSON.stringify(ms?.map((m) => [m.login, m.role, m.via]))}`,
  );

  // ── 9. Your monorepos, by owner; the activity by owner ──
  r = await call("GET", `/v1/monorepos?owner=${ORG}`, S.ana);
  const own = r.json?.monorepos?.map((m) => m.full_name).sort().join(",");
  check("?owner= lists ana's monorepos under the org only", own === [`${ORG}/new-thing2`, `${ORG}/ws`].sort().join(","), own);
  r = await call("GET", `/v1/monorepos?owner=${ORG}&summary=1`, S.ana);
  check("with summary=1 too", r.json?.monorepos?.length === 2 && r.json.monorepos.every((m) => m.owner === ORG && m.owner_type === "org"), JSON.stringify(r.json?.monorepos?.map((m) => m.full_name)));
  r = await call("GET", `/v1/monorepos?owner=nobody-${id}`, S.ana);
  check("an owner with none of hers is an empty list", r.status === 200 && r.json?.monorepos?.length === 0);

  const orgEvents = await waitFor(async () => {
    const p = await call("GET", `/v1/events?owner=${ORG}&limit=200`, S.ana);

    return p.json?.events?.some((e) => e.monorepo_id === ws?.id) ? p : null;
  }, 20_000);

  check("GET /v1/events?owner=: the org's activity only", !!orgEvents && orgEvents.json.events.every((e) => e.monorepo.startsWith(`${ORG}/`)), JSON.stringify(orgEvents?.json?.events?.map((e) => e.monorepo)));
  r = await call("GET", `/v1/events?owner=${L.ana}`, S.ana);
  check("and by another owner, none of the org's", r.status === 200 && !r.json?.events?.some((e) => e.monorepo_id === ws?.id), `${r.status}`);
  r = await call("GET", `/v1/events?owner=${ORG}&in=${ORG}/ws`, S.ana);
  check("owner and in together are refused (400)", r.status === 400, `${r.status}`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const s of sockets) s.ws.close();

  for (const [full, secret] of made.values()) {
    const r = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, secret);
    check(`delete ${full}`, r.status === 204, `${r.status}`);
  }

  standin.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
