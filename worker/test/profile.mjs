// Profiles (profile SPEC section 8.1, with the owner's answers in
// decisions/RULINGS.md, "Profiles"), end to end against `wrangler dev`: real
// git through the door, real Artifacts, real local D1, the facts outbox and
// each person's FeedObject, and a stand-in WorkOS for a sign-in.
//
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to <dir>
//   npx wrangler dev --port 8833 --persist-to <dir> --var FACTS_TEST:1 --var FACTS_RETRY_MS:300,300
//   PANDO_URL=http://localhost:8833 PANDO_WORKOS_STANDIN_PORT=8834 node test/profile.mjs
//
// FACTS_TEST:1 is required: the exactly-once check loses a drain's answer on
// purpose through /v1/_facts/test, and fails, saying so, without it.
// worker/.dev.vars points WORKOS_API_BASE at the stand-in's port.
// PROFILE_BIG=<n> also times a generated history of n commits (one merge in
// five) arriving at once, and prints how long its count took.
//
// Covered: a merge credits the author and every co-author once, and a lost
// answer counts nothing twice; a co-author or author with no account counts
// for nobody, an agent's line is ignored, and someone who can't open the
// repository gets nothing; pushes alone count nothing, a branch opened counts
// once; reviews; a repository arriving with history fills the right days
// (merge commits and commits older than the window not counted); days follow
// the viewer's time zone; one day's timeline; a viewer sees only work in
// repositories they can open, and orgs they share; Edit profile and its
// limits; an edited name survives a sign-in; your own profile hears a
// `contributed` frame live. Credentials are never printed; git never reaches
// the keychain. It deletes every monorepo it made.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8833").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const STANDIN_PORT = Number(process.env.PANDO_WORKOS_STANDIN_PORT ?? 8834);

const BIG = Number(process.env.PROFILE_BIG ?? 0);

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
    await sleep(250);
  }

  return null;
}

const DAY = 86_400_000;

const work = mkdtempSync(join(tmpdir(), "pando-profile-"));

/** git with no system config, no inherited helper, and one that reads the secret from the environment. `env`: author, dates. */
const git = (args, cwd, secret, env = {}) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "",
      GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid", ...env,
    },
  });

  return { ok: r.status === 0, out: scrub(`${r.stdout}${r.stderr}`), stdout: r.stdout };
};

/** One commit in `dir`: a file changed, by `who` ({name, email}), at `at` (ms) when given. */
const commit = (dir, file, message, who, at) => {
  writeFileSync(join(dir, file), `${message}\n${Math.random()}\n`);
  git(["add", "-A"], dir);
  const date = at ? { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() } : {};
  const r = git(["commit", "-q", "-m", message], dir, null, { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, ...date });

  if (!r.ok) throw new Error(`commit failed: ${r.out}`);
};

// ── The stand-in WorkOS: the device flow, as orgs.mjs plays it ──
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

/** `pando login` as a WorkOS user. */
async function deviceSignIn(user) {
  nextUser = user;
  const start = await call("POST", "/v1/login/device");
  const r = await call("POST", "/v1/login/token", null, { device_code: start.json?.device_code, credential_name: `${user.email}-laptop` });

  return { status: r.status, login: r.json?.user?.login };
}

const id = Date.now().toString(36);

const L = { ramos: `ramos-${id}`, ana: `ana-${id}`, ben: `ben-${id}` };

const E = { ramos: `ramos-${id}@example.com`, ana: `ana-${id}@example.com`, ben: `ben-${id}@example.com` };

const who = (k) => ({ name: k, email: E[k] });

const S = {};

/** Monorepos to delete at the end: full name, its owner's secret. */
const made = [];

const sockets = [];

/** A person's contributions as `viewer` sees them. */
const contributions = (login, viewer, tz = 0, day = null) => call("GET", `/v1/users/${login}/contributions?tz=${tz}${day ? `&day=${day}` : ""}`, S[viewer]);

/** One kind's count in one monorepo, over the year, from the timeline. */
function countIn(c, kind, full) {
  return (c?.months ?? []).reduce((a, m) => a + (m[kind].find((x) => x.full_name === full)?.n ?? 0), 0);
}

/** A monorepo the test makes: plain repo, its clone URL; deleted at the end. */
async function makeRepo(owner, name) {
  const r = await call("POST", "/v1/monorepos", S[owner], { name, kind: "repo" });

  if (r.status !== 201) throw new Error(`no repo ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  made.push([r.json.monorepo.full_name, S[owner]]);

  return { id: r.json.monorepo.id, full: r.json.monorepo.full_name, url: r.json.repos[0].clone_url };
}

/** The facts outbox of a monorepo: waiting rows. */
const outbox = async (monorepoId) => (await call("GET", `/v1/_facts/test?monorepo=${monorepoId}`, BOOT)).json;

try {
  for (const k of Object.keys(L)) {
    S[k] = (await call("POST", "/v1/users", BOOT, { login: L[k], name: k, email: E[k], credential_name: `${k}-mbp` })).json?.credential?.secret;
  }

  check("three people", Object.values(S).every(Boolean));
  const probe = await call("GET", "/v1/_facts/test?monorepo=none", BOOT);

  if (probe.status === 404) throw new Error("no /v1/_facts/test: start the server with --var FACTS_TEST:1");

  // ── Edit profile ──
  let r = await call("PATCH", "/v1/user", S.ramos, { name: "Michael Ramos", bio: "Building Pando.", location: "San Diego", links: ["https://plannotator.ai", "", "https://example.com/ramos"] });
  check(
    "PATCH /v1/user saves the name, bio, location and links (an empty link is dropped)",
    r.status === 200 && r.json?.type === "user" && r.json?.name === "Michael Ramos" && r.json?.bio === "Building Pando." && r.json?.location === "San Diego" && r.json?.links?.join() === "https://plannotator.ai,https://example.com/ramos",
    `${r.status} ${JSON.stringify(r.json)}`,
  );
  r = await call("PATCH", "/v1/user", S.ramos, { bio: "x".repeat(161) });
  check("a bio over 160 characters is refused (400)", r.status === 400, `${r.status}`);
  r = await call("PATCH", "/v1/user", S.ramos, { links: ["http://plannotator.ai"] });
  check("a link that is not https is refused (400)", r.status === 400, `${r.status}`);
  r = await call("PATCH", "/v1/user", S.ramos, { links: ["https://a.dev", "https://b.dev", "https://c.dev", "https://d.dev", "https://e.dev"] });
  check("five links are refused (400)", r.status === 400, `${r.status}`);
  r = await call("PATCH", "/v1/user", S.ramos, { location: null });
  check("a field left out is kept, null clears one", r.status === 200 && r.json?.location === null && r.json?.bio === "Building Pando.", JSON.stringify(r.json));
  r = await call("GET", `/v1/users/${L.ramos}`, S.ben);
  check(
    "anyone signed in sees the header, never the email",
    r.status === 200 && r.json?.bio === "Building Pando." && r.json?.links?.length === 2 && !("email" in r.json) && !r.text.includes(E.ramos),
    JSON.stringify(r.json),
  );

  // ── An edited name survives a sign-in ──
  const signed = await deviceSignIn({ id: `user_ramos_${id}`, email: E.ramos, email_verified: true, first_name: "Mike", last_name: "R" });
  r = await call("GET", `/v1/users/${L.ramos}`, S.ben);
  check("signing in (WorkOS says \"Mike R\") keeps the name saved in Edit profile", signed.status === 200 && signed.login === L.ramos && r.json?.name === "Michael Ramos", `${signed.status} ${signed.login} ${r.json?.name}`);

  // ── Orgs on a profile: those the viewer shares ──
  const org = `pl-${id}`;
  await call("POST", "/v1/orgs", S.ramos, { login: org, name: "Plannotator" });
  await call("PUT", `/v1/orgs/${org}/members/${L.ana}`, S.ramos, { role: "member" });
  r = await call("GET", `/v1/users/${L.ramos}`, S.ana);
  const r2 = await call("GET", `/v1/users/${L.ramos}`, S.ben);
  check("ana, in the org too, sees it on ramos's profile; ben does not", r.json?.orgs?.some((o) => o.login === org && o.name === "Plannotator") && r2.json?.orgs?.length === 0, `${JSON.stringify(r.json?.orgs)} ${JSON.stringify(r2.json?.orgs)}`);

  // ── A merge: the author and every co-author, once; a lost answer counts nothing twice ──
  const p = await makeRepo("ramos", `p-${id}`);
  await call("PUT", `/v1/monorepos/${p.full}/members/${L.ana}`, S.ramos, { role: "member" });
  const pdir = join(work, "p");
  mkdirSync(pdir);
  git(["init", "-q"], pdir);
  commit(pdir, "README.md", "first, by no account", { name: "Someone", email: `someone-${id}@example.com` });
  let g = git(["push", "-q", p.url, "main"], pdir, S.ramos);
  check("ramos pushes main (its one commit has no account's email)", g.ok, g.out.slice(-200));
  git(["checkout", "-qb", "feat"], pdir);
  commit(pdir, "a.txt", "by ramos", who("ramos"));
  commit(pdir, "b.txt", `by ana, with ramos\n\nCo-authored-by: Michael Ramos <${E.ramos.toUpperCase()}>`, who("ana"));
  commit(pdir, "c.txt", `by an agent, for ramos\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Michael Ramos <${E.ramos}>`, { name: "Claude", email: "noreply@anthropic.com" });
  commit(pdir, "d.txt", `by ramos, with someone unknown\n\nCo-authored-by: Nobody <nobody-${id}@example.com>`, who("ramos"));
  commit(pdir, "e.txt", "by someone with no account", { name: "Nobody", email: `nobody-${id}@example.com` });
  commit(pdir, "f.txt", "by ben, who can't open it", who("ben"));
  g = git(["push", "-q", p.url, "feat"], pdir, S.ramos);
  check("ramos pushes a branch of six commits", g.ok, g.out.slice(-200));
  // Pushes alone: a force-push of an amended head changes nothing.
  writeFileSync(join(pdir, "f.txt"), "amended\n");
  git(["add", "-A"], pdir);
  git(["commit", "-q", "--amend", "--no-edit"], pdir, null, { GIT_AUTHOR_NAME: "ben", GIT_AUTHOR_EMAIL: E.ben });
  g = git(["push", "-qf", p.url, "feat"], pdir, S.ramos);
  check("and force-pushes it amended", g.ok, g.out.slice(-200));

  const branchSeen = await waitFor(async () => {
    const c = (await contributions(L.ramos, "ramos")).json;

    return c?.kinds?.branch === 1 ? c : null;
  });

  check("the branch opened counts once for ramos, who pushed it (two pushes)", branchSeen?.kinds?.branch === 1 && countIn(branchSeen, "branch", p.full) === 1, JSON.stringify(branchSeen?.kinds));
  r = await contributions(L.ana, "ana");
  check("before the merge: no commits for anyone (pushes count nothing)", branchSeen?.kinds?.commit === 0 && r.json?.kinds?.commit === 0, `${branchSeen?.kinds?.commit} ${r.json?.kinds?.commit}`);

  // The live socket: ramos's own profile hears his work.
  const live = { frames: [], ws: new WebSocket(`${WS_}/v1/events`, { headers: { authorization: `Bearer ${S.ramos}` } }) };
  sockets.push(live);
  live.ws.onmessage = (e) => e.data !== "pong" && live.frames.push(JSON.parse(e.data));
  await waitFor(() => live.ws.readyState === WebSocket.OPEN, 10_000);
  live.ws.send(JSON.stringify({ type: "hello" }));
  await waitFor(() => live.frames.some((f) => f.type === "caught_up"), 10_000);

  // Two drains lose their answers: the merge's credit runs again, and adds nothing.
  r = await call("POST", "/v1/_facts/test", BOOT, { monorepo: p.id, lose: 2 });
  check("the facts outbox will lose the next two answers", r.status === 200, `${r.status}`);
  const head = git(["rev-parse", "HEAD"], pdir).stdout.trim();
  const mergedAt = Date.now();
  r = await call("POST", `/v1/monorepos/${p.full}/repos/${p.full.split("/")[1]}/branches/feat/merge?force=1`, S.ramos, { expected_head: head });
  check("ramos merges it", r.status === 200 && r.json?.status === "merged", `${r.status} ${JSON.stringify(r.json?.error)}`);
  const frame = await waitFor(() => live.frames.find((f) => f.type === "contributed" && f.kind === "commit" && f.monorepo_id === p.id), 10_000);
  check("within seconds ramos's socket hears it: a contributed frame for his 4 commits", frame && frame.monorepo === p.full && frame.n === 4 && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(frame.hour), `${Date.now() - mergedAt} ms ${JSON.stringify(frame)}`);

  const settled = await waitFor(async () => {
    const o = await outbox(p.id);

    return o?.live === 0 && o?.losses_left === 0 ? o : null;
  });

  check("the lost answers were retried until the outbox emptied", !!settled, JSON.stringify(await outbox(p.id)));
  const mine = (await contributions(L.ramos, "ramos")).json;
  const anas = (await contributions(L.ana, "ana")).json;
  const bens = (await contributions(L.ben, "ben")).json;
  check("ramos: 4 commits (his own two, and as a co-author of ana's and of the agent's), counted once despite the retries", mine?.kinds?.commit === 4 && countIn(mine, "commit", p.full) === 4, JSON.stringify(mine?.kinds));
  check("ana: her one commit", anas?.kinds?.commit === 1 && countIn(anas, "commit", p.full) === 1, JSON.stringify(anas?.kinds));
  check("ben's commit counts for nobody: he can't open the repository", bens?.kinds?.commit === 0 && bens?.total === 0, JSON.stringify(bens?.kinds));
  check(
    "the unknown co-author and author count for no one, the agent's line is ignored, and no answer names the agent",
    !JSON.stringify([mine, anas, bens]).includes("anthropic") && !JSON.stringify([mine, anas, bens]).includes("Claude") && !JSON.stringify([mine, anas, bens]).includes("nobody-"),
  );

  // ── Reviews ──
  git(["checkout", "-qb", "rev", "main"], pdir);
  git(["pull", "-q", p.url, "main"], pdir, S.ana);
  commit(pdir, "g.txt", "for review", who("ana"));
  git(["push", "-q", p.url, "rev"], pdir, S.ana);
  r = await call("POST", `/v1/monorepos/${p.full}/repos/${p.full.split("/")[1]}/branches/rev/reviews`, S.ramos, { verdict: "approve" });
  const r3 = await call("POST", `/v1/monorepos/${p.full}/repos/${p.full.split("/")[1]}/branches/rev/reviews`, S.ramos, { verdict: "comment", body: "nice" });

  const reviewed = await waitFor(async () => {
    const c = (await contributions(L.ramos, "ramos")).json;

    return c?.kinds?.review === 2 ? c : null;
  });

  check("two reviews by ramos: reviews +2; ana's push of a new branch: her branches +1", r.status === 201 && r3.status === 201 && reviewed && (await waitFor(async () => (await contributions(L.ana, "ana")).json?.kinds?.branch === 1)), JSON.stringify(reviewed?.kinds));
  check("and the review came live too", !!(await waitFor(() => live.frames.find((f) => f.type === "contributed" && f.kind === "review"), 5_000)));

  // ── A repository arriving with history ──
  const h = await makeRepo("ramos", `h-${id}`);
  const hdir = join(work, "h");
  mkdirSync(hdir);
  git(["init", "-q"], hdir);
  const now = Date.now();
  const expected = new Map();
  const count = (at) => expected.set(new Date(at).toISOString().slice(0, 10), (expected.get(new Date(at).toISOString().slice(0, 10)) ?? 0) + 1);

  // Older than the window: never counted.
  for (let i = 0; i < 3; i++) commit(hdir, "old.txt", `old ${i}`, who("ramos"), now - (420 - i) * DAY);

  // One at 02:30 UTC on a day of its own, for the time zones: in California it is the evening before.
  const tzAt = Date.UTC(new Date(now - 45 * DAY).getUTCFullYear(), new Date(now - 45 * DAY).getUTCMonth(), new Date(now - 45 * DAY).getUTCDate(), 2, 30);
  commit(hdir, "tz.txt", "at 02:30 UTC", who("ramos"), tzAt);
  count(tzAt);

  // 50 commits over 40 days, at different hours.
  for (let k = 0; k < 50; k++) {
    const at = now - 41 * DAY + Math.floor((k * 40 * DAY) / 50) + (k % 7) * 3_600_000;
    commit(hdir, "log.txt", `history ${k}`, who("ramos"), at);
    count(at);
  }

  // A side branch merged in: its 3 commits count, the merge commit does not.
  const sideAt = now - 5 * DAY;
  git(["checkout", "-qb", "side", "HEAD~3"], hdir);

  for (let k = 0; k < 3; k++) {
    commit(hdir, "side.txt", `side ${k}`, who("ramos"), sideAt + k * 60_000);
    count(sideAt + k * 60_000);
  }

  git(["checkout", "-q", "main"], hdir);
  const mergeAt = new Date(sideAt + 10 * 60_000).toISOString();
  git(["merge", "-q", "--no-ff", "-m", "merge side", "side"], hdir, null, { GIT_AUTHOR_NAME: "ramos", GIT_AUTHOR_EMAIL: E.ramos, GIT_AUTHOR_DATE: mergeAt, GIT_COMMITTER_DATE: mergeAt });
  // One by ana, who is not in this repository.
  commit(hdir, "ana.txt", "by ana, who is not in it", who("ana"), now - 2 * DAY);
  const arrived = Date.now();
  g = git(["push", "-q", h.url, "main"], hdir, S.ramos);
  check("ramos pushes main with 59 commits of history (3 older than a year, a merge, one by ana)", g.ok, g.out.slice(-200));

  const filled = await waitFor(async () => {
    const c = (await contributions(L.ramos, "ramos")).json;

    return countIn(c, "commit", h.full) >= 54 ? c : null;
  }, 60_000);

  const historyMs = Date.now() - arrived;
  check("its history fills ramos's graph: 54 commits (not the merge, not the three older than a year)", countIn(filled, "commit", h.full) === 54, `${countIn(filled, "commit", h.full)} after ${historyMs} ms`);
  const byDay = new Map((filled?.days ?? []).map((d) => [d.date, d]));
  const otherWork = new Map();

  for (const d of (mine?.days ?? [])) otherWork.set(d.date, d.n);
  const wrong = [...expected].filter(([date, n]) => (byDay.get(date)?.commit ?? 0) < n);
  check("each on its own day (UTC)", wrong.length === 0, wrong.slice(0, 3).map(([d, n]) => `${d}: want ${n}, got ${byDay.get(d)?.commit}`).join("; "));
  r = await contributions(L.ana, "ana");
  check("ana's commit there counts for no one: she is not in that repository", r.json?.kinds?.commit === 1, JSON.stringify(r.json?.kinds));

  // ── Time zones: 02:30 UTC is the evening before in California ──
  const utcDay = new Date(tzAt).toISOString().slice(0, 10);
  const westDay = new Date(tzAt - 420 * 60_000).toISOString().slice(0, 10);
  const west = (await contributions(L.ramos, "ramos", -420)).json;
  const on = (c, d) => c?.days?.find((x) => x.date === d)?.commit ?? 0;
  check(
    "the 02:30 UTC commit is on its own day with tz=0, and on the day before with tz=-420",
    west?.tz === -420 && on(filled, utcDay) === 1 && on(filled, westDay) === 0 && on(west, westDay) === 1 && on(west, utcDay) === 0,
    `tz=0 ${utcDay}:${on(filled, utcDay)} ${westDay}:${on(filled, westDay)}; tz=-420 ${utcDay}:${on(west, utcDay)} ${westDay}:${on(west, westDay)}`,
  );
  const dayUtc = (await contributions(L.ramos, "ramos", 0, utcDay)).json;
  const dayWest = (await contributions(L.ramos, "ramos", -420, westDay)).json;
  const none = (await contributions(L.ramos, "ramos", -420, utcDay)).json;
  check(
    "and one day's timeline names it in each zone, and not the day after in California",
    dayUtc?.period === utcDay && dayUtc.commit[0]?.full_name === h.full && dayUtc.commit[0]?.n === 1 && dayWest?.commit[0]?.n === 1 && none?.commit?.length === 0,
    `${JSON.stringify(dayUtc?.commit)} ${JSON.stringify(dayWest?.commit)} ${JSON.stringify(none?.commit)}`,
  );
  r = await contributions(L.ramos, "ramos", 0, "2001-01-01");
  check("a day outside the window is refused (400)", r.status === 400, `${r.status}`);

  // ── What a viewer sees ──
  const asAna = await contributions(L.ramos, "ana");
  const asBen = await contributions(L.ramos, "ben");
  const own = (await contributions(L.ramos, "ramos")).json;
  check(
    "ana sees ramos's work in the repository she can open, and no word of the other",
    asAna.status === 200 && countIn(asAna.json, "commit", p.full) === 4 && !asAna.text.includes(h.full) && asAna.json?.monorepos?.length === 1 && asAna.json.monorepos[0].full_name === p.full,
    `${asAna.status} ${JSON.stringify(asAna.json?.kinds)} ${JSON.stringify(asAna.json?.monorepos?.map((m) => m.full_name))}`,
  );
  check(
    "ben, who shares nothing with him, sees none of it",
    asBen.status === 200 && asBen.json?.total === 0 && asBen.json?.days?.length === 0 && asBen.json?.monorepos?.length === 0 && !asBen.text.includes(p.full) && !asBen.text.includes(h.full),
    `${asBen.json?.total} ${JSON.stringify(asBen.json?.monorepos)}`,
  );
  const created = own?.months?.flatMap((m) => m.created.map((c) => c.full_name)) ?? [];
  check(
    "ramos sees both repositories he made, counted, and the org he made",
    created.includes(p.full) && created.includes(h.full) && own?.kinds?.created >= 2 && own?.months?.some((m) => m.joined.some((o) => o.org === org && o.created)),
    `${JSON.stringify(created)} ${JSON.stringify(own?.kinds)}`,
  );
  const sum = own?.days?.reduce((a, d) => a + d.n, 0);
  check(
    "the total is the sum of the days, and the shades rise",
    own?.total === sum && own?.total === own.kinds.commit + own.kinds.branch + own.kinds.review + own.kinds.created && own.levels.every((l, i) => i === 0 || l > own.levels[i - 1]),
    `${own?.total} ${sum} ${JSON.stringify(own?.levels)}`,
  );
  check("the window: 53 weeks from a Sunday to today", own && new Date(`${own.from}T00:00:00Z`).getUTCDay() === 0 && (Date.parse(own.to) - Date.parse(own.from)) / DAY >= 364 && (Date.parse(own.to) - Date.parse(own.from)) / DAY <= 370, `${own?.from} ${own?.to}`);
  r = await call("GET", `/v1/users/${org}/contributions`, S.ramos);
  check("an org has no graph (404)", r.status === 404, `${r.status}`);

  console.log(`history: 59 commits pushed, 54 counted in ${historyMs} ms`);

  // ── A large history, timed (PROFILE_BIG=<n>) ──
  if (BIG > 0) {
    const b = await makeRepo("ramos", `big-${id}`);
    const bdir = join(work, "big");
    mkdirSync(bdir);
    git(["init", "-q"], bdir);
    // fast-import: n commits over the last 300 days, one in five a merge of a one-commit side branch.
    const lines = [];
    let mark = 0;
    let mainMark = 0;

    for (let i = 0; i < BIG; i++) {
      const at = Math.floor((now - 300 * DAY + Math.floor((i * 300 * DAY) / BIG)) / 1000);
      const person = `ramos <${E.ramos}> ${at} +0000`;

      if (i % 5 === 4 && mainMark) {
        const side = ++mark;
        lines.push(`commit refs/heads/side`, `mark :${side}`, `author ${person}`, `committer ${person}`, `data 4`, `side`, `from :${mainMark}`, `M 644 inline side-${i}.txt`, `data 2`, `s`, "");
        const m = ++mark;
        lines.push(`commit refs/heads/main`, `mark :${m}`, `author ${person}`, `committer ${person}`, `data 5`, `merge`, `from :${mainMark}`, `merge :${side}`, "");
        mainMark = m;
      } else {
        const m = ++mark;
        lines.push(`commit refs/heads/main`, `mark :${m}`, `author ${person}`, `committer ${person}`, `data 4`, `work`, ...(mainMark ? [`from :${mainMark}`] : []), `M 644 inline f-${i % 50}.txt`, `data ${String(i).length}`, String(i), "");
        mainMark = m;
      }
    }

    const fi = spawnSync("git", ["fast-import", "--quiet"], { cwd: bdir, input: `${lines.join("\n")}\n`, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work } });

    if (fi.status !== 0) throw new Error(`fast-import: ${fi.stderr}`);
    git(["checkout", "-q", "main"], bdir);
    const total = Number(git(["rev-list", "--count", "--no-merges", "main"], bdir).stdout.trim());
    const merges = Number(git(["rev-list", "--count", "--merges", "main"], bdir).stdout.trim());
    const t0 = Date.now();
    g = git(["push", "-q", b.url, "main"], bdir, S.ramos);
    const pushed = Date.now();
    const done = await waitFor(async () => countIn((await contributions(L.ramos, "ramos")).json, "commit", b.full) >= total, 15 * 60_000);
    check(`a generated history of ${total} commits (and ${merges} merges) arrives and is counted in full`, g.ok && !!done, `push ${pushed - t0} ms, counted ${Date.now() - pushed} ms after the push`);
    console.log(`big history: ${total} commits, ${merges} merges; push ${pushed - t0} ms; counted ${Date.now() - pushed} ms after the push`);
  }
} catch (err) {
  check("no unexpected error", false, describeError(err));
} finally {
  for (const s of sockets) s.ws.close();

  for (const [full, secret] of made) {
    const d = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, secret);

    if (d.status !== 204) console.log(`cleanup: ${full} ${d.status}`);
  }

  standin.close();
  rmSync(work, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;

console.log(`\n${passed} of ${results.length} checks passed`);

process.exit(passed === results.length ? 0 : 1);
