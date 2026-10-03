// Browser sign-in, end to end, against `wrangler dev` with a stand-in WorkOS
// on this machine (worker/.dev.vars: WORKOS_API_BASE=http://127.0.0.1:8799).
//
//   PANDO_URL=http://localhost:8797 node test/browser.mjs
//
// The stand-in plays AuthKit's hosted page (it signs in whoever the test
// names) and WorkOS's code exchange (it checks the PKCE verifier). The real
// round trip on pando-dev needs a person in a browser.
// No credential or cookie value is printed. It deletes what it made.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const ORIGIN = new URL(URL_).origin;
const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
const STUB_PORT = 8799;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── the stand-in WorkOS ──
const codes = new Map();
const seen = { exchanges: [], logouts: [] };
let nextUser = null;
let sidN = 0;
const stub = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "GET" && u.pathname === "/user_management/authorize") {
      const q = u.searchParams;
      const ok = q.get("response_type") === "code" && q.get("code_challenge_method") === "S256" && q.get("provider") === "authkit" && q.get("redirect_uri") === `${ORIGIN}/v1/login/callback` && q.get("client_id");
      if (!ok || !nextUser) return res.writeHead(400).end("bad authorize request");
      const code = b64url(createHash("sha256").update(String(Math.random())).digest());
      codes.set(code, { challenge: q.get("code_challenge"), user: nextUser });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (req.method === "POST" && u.pathname === "/user_management/authenticate") {
      const f = new URLSearchParams(body);
      const c = codes.get(f.get("code"));
      seen.exchanges.push({ grant: f.get("grant_type"), secret: !!f.get("client_secret"), verifier: !!f.get("code_verifier") });
      if (!c || f.get("grant_type") !== "authorization_code" || b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest()) !== c.challenge) {
        return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", error_description: "bad code or verifier" }));
      }
      codes.delete(f.get("code"));
      const sid = `session_${++sidN}`;
      const jwt = `${b64url("{}")}.${b64url(JSON.stringify({ sub: c.user.id, sid }))}.sig`;
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: c.user, access_token: jwt, refresh_token: "r" }));
    }
    if (req.method === "GET" && u.pathname === "/user_management/sessions/logout") {
      seen.logouts.push(Object.fromEntries(u.searchParams));
      return res.writeHead(302, { location: u.searchParams.get("return_to") ?? "/" }).end();
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []);
const cookieValue = (setCookies, name) => {
  const c = setCookies.find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(";")[0] : null;
};
/** One browser sign-in, following the redirects by hand. */
async function signIn(user, returnTo) {
  nextUser = user;
  const start = await fetch(`${URL_}/v1/login/browser${returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15" } });
  const loginSet = cookiesOf(start);
  const login = cookieValue(loginSet, "__Host-pando_login");
  const atWorkos = await fetch(start.headers.get("location"), { redirect: "manual" });
  const back = atWorkos.headers.get("location");
  const cb = await fetch(back, { redirect: "manual", headers: { cookie: `__Host-pando_login=${login}`, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15" } });
  const set = cookiesOf(cb);
  return { start, loginSet, cb, set, session: cookieValue(set, "__Host-pando_session"), location: cb.headers.get("location"), callbackUrl: back };
}
const api = (method, path, { session, bearer, origin, body, accept } = {}) =>
  fetch(URL_ + path, {
    method,
    redirect: "manual",
    headers: {
      ...(session ? { cookie: `__Host-pando_session=${session}` } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(origin ? { origin } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(accept ? { accept } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const id = Date.now().toString(36);
const work = mkdtempSync(join(tmpdir(), "pando-browser-"));
const made = [];
let session = null;
try {
  // A user made earlier (the bootstrap path) with the same email: the browser must sign in as them.
  const boot = await (await api("POST", "/v1/users", { bearer: BOOT, body: { login: `ana-${id}`, name: "Ana", email: `ana-${id}@pando.invalid` } })).json();
  const A = boot.credential?.secret;
  check("a user made earlier by the bootstrap path", !!A);
  const ana = { id: `user_ana_${id}`, email: `ana-${id}@pando.invalid`, email_verified: true, first_name: "Ana", last_name: "Lima" };

  const s1 = await signIn(ana, "/v1/user");
  check("GET /v1/login/browser redirects to AuthKit with PKCE and state", s1.start.status === 302 && /\/user_management\/authorize\?/.test(s1.start.headers.get("location") ?? "") && /code_challenge=/.test(s1.start.headers.get("location")));
  const lc = s1.loginSet.find((c) => c.startsWith("__Host-pando_login=")) ?? "";
  check("the login cookie is HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes", /HttpOnly/.test(lc) && /Secure/.test(lc) && /SameSite=Lax/.test(lc) && /Path=\//.test(lc) && /Max-Age=600/.test(lc));
  const sc = s1.set.find((c) => c.startsWith("__Host-pando_session=")) ?? "";
  check("the callback sets the session cookie (HttpOnly, Secure, SameSite=Lax, host-only) and returns to return_to", s1.cb.status === 302 && s1.location === "/v1/user" && !!s1.session && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc) && !/Domain=/i.test(sc), `${s1.cb.status} -> ${s1.location}`);
  check("the login cookie is cleared", s1.set.some((c) => c.startsWith("__Host-pando_login=;") && /Max-Age=0/.test(c)));
  check("the code exchange sent the PKCE verifier and the API key", seen.exchanges.at(-1)?.verifier && seen.exchanges.at(-1)?.secret);
  session = s1.session;

  let r = await api("GET", "/v1/user", { session });
  let me = await r.json();
  check("the browser is the same Pando user as before (linked by verified email)", r.status === 200 && me.login === `ana-${id}`, `${r.status} ${me.login}`);
  check("its credential is a browser session with an end date", me.credential?.kind === "browser" && /Safari on macOS/.test(me.credential?.name) && Date.parse(me.credential?.expires_at) > Date.now() + 29 * 86400e3);
  r = await api("GET", "/v1/user/credentials", { session });
  check("it is listed beside the machine credentials", (await r.json()).credentials?.some((c) => c.kind === "browser"));

  // ── Origin: writes and upgrades only from Pando's own pages ──
  r = await api("POST", "/v1/monorepos", { session, origin: ORIGIN, body: { name: `br-${id}` } });
  if (r.status === 201) made.push(`br-${id}`);
  check("a write from Pando's own origin works", r.status === 201, `${r.status}`);
  r = await api("POST", "/v1/monorepos", { session, origin: "https://other.plannotator.workers.dev", body: { name: `br2-${id}` } });
  check("a write from another origin (even same-site) is refused", r.status === 403 && (await r.json()).error?.code === "bad_origin");
  r = await api("POST", "/v1/monorepos", { session, body: { name: `br3-${id}` } });
  check("a write with no Origin is refused", r.status === 403);
  r = await api("GET", `/v1/monorepos/br-${id}/meta/tree`, { session, origin: "https://other.plannotator.workers.dev" });
  check("a read needs no Origin check (and the meta routes take the cookie)", r.status === 200, `${r.status}`);
  r = await api("POST", `/v1/monorepos/br-${id}/meta/restore`, { session, origin: "https://other.plannotator.workers.dev", body: { path: "x", version: 1 } });
  check("a meta layer write from another origin is refused", r.status === 403);

  const ws = (origin) =>
    new Promise((resolve) => {
      const s = new WebSocket(`${URL_.replace(/^http/, "ws")}/v1/monorepos/br-${id}/events`, { headers: { cookie: `__Host-pando_session=${session}`, ...(origin ? { origin } : {}) } });
      const done = (v) => {
        try {
          s.close();
        } catch {}
        resolve(v);
      };
      s.onopen = () => done("open");
      s.onerror = () => done("refused");
      setTimeout(() => done("timeout"), 8000);
    });
  check("the event socket opens with the cookie from Pando's own origin", (await ws(ORIGIN)) === "open");
  check("and is refused from another origin", (await ws("https://other.plannotator.workers.dev")) === "refused");

  // ── the session is a cookie, never a token, and never at the git door ──
  r = await api("GET", "/v1/user", { bearer: session });
  check("the session secret does not work as a Bearer token", r.status === 401);
  const door = (args) => spawnSync("git", ["-c", "credential.helper=", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0" } });
  const cloneUrl = `${URL_}/br-${id}/meta.git`;
  let g = door(["-c", `http.extraHeader=Cookie: __Host-pando_session=${session}`, "ls-remote", cloneUrl]);
  check("the git door ignores the cookie", g.status !== 0);
  g = door(["-c", `http.extraHeader=Authorization: Bearer ${session}`, "ls-remote", cloneUrl]);
  check("the git door refuses the session secret as a credential", g.status !== 0);
  r = await api("GET", "/v1/user", { bearer: A });
  check("the machine credential still works", r.status === 200);

  // ── bad starts and return_to ──
  r = await fetch(`${URL_}/v1/login/callback?code=x&state=y`, { redirect: "manual" });
  check("a callback with no matching login cookie is refused", r.status === 400 && (await r.json()).error?.code === "bad_state");
  const s2 = await signIn(ana, "//evil.example/steal");
  check("return_to on another host becomes /", s2.location === "/", s2.location);
  const s3 = await signIn(ana, "https://evil.example/");
  check("return_to with a scheme becomes /", s3.location === "/", s3.location);

  // ── a new person ──
  const s4 = await signIn({ id: `user_new_${id}`, email: `zed.${id}@pando.invalid`, email_verified: true, first_name: "Zed", last_name: null }, "/");
  me = await (await api("GET", "/v1/user", { session: s4.session })).json();
  check("a first-time person gets a user named from their email", me.login === `zed-${id}` && me.name === "Zed", me.login);

  // ── sign out ──
  r = await api("POST", "/v1/logout", { session, origin: "https://other.plannotator.workers.dev", accept: "application/json" });
  check("sign-out from another origin is refused", r.status === 403);
  r = await api("POST", "/v1/logout", { session, origin: ORIGIN, accept: "application/json" });
  const out = await r.json();
  const cleared = cookiesOf(r).some((c) => c.startsWith("__Host-pando_session=;") && /Max-Age=0/.test(c));
  check("sign-out revokes the session, clears the cookie, and gives WorkOS's logout URL for its session", r.status === 200 && out.signed_out && cleared && /\/user_management\/sessions\/logout\?session_id=session_\d+/.test(out.logout_url) && out.logout_url.includes(encodeURIComponent(`${ORIGIN}/`)), out.logout_url?.replace(/^http:\/\/127\.0\.0\.1:\d+/, "<workos>"));
  r = await api("GET", "/v1/user", { session });
  check("the signed-out session no longer works", r.status === 401);
  r = await api("POST", "/v1/logout", { session: s2.session, origin: ORIGIN });
  check("a form sign-out is sent on with 303", r.status === 303 && /sessions\/logout/.test(r.headers.get("location") ?? ""));
  for (const s of [s3.session, s4.session]) await api("POST", "/v1/logout", { session: s, origin: ORIGIN, accept: "application/json" });
} catch (err) {
  check("no exception", false, String(err?.stack ?? err));
} finally {
  const A = (await (await api("POST", "/v1/users", { bearer: BOOT, body: { login: `cleanup-${id}` } })).json()).credential?.secret;
  void A;
  for (const m of made) {
    // The monorepo's owner is ana: sign in once more to delete it.
    const s = await signIn({ id: `user_ana_${id}`, email: `ana-${id}@pando.invalid`, email_verified: true, first_name: "Ana" }, "/");
    const r = await api("DELETE", `/v1/monorepos/${m}?confirm=${m}`, { session: s.session, origin: ORIGIN });
    check(`delete ${m}`, r.status === 204, `${r.status}`);
    await api("POST", "/v1/logout", { session: s.session, origin: ORIGIN, accept: "application/json" });
  }
  stub.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
