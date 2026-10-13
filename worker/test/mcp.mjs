// The MCP endpoint and its sign-in, end to end against `wrangler dev` with real D1, Durable Objects,
// Artifacts and git, and a stand-in WorkOS on this machine (it signs the test's person in):
//   1. routing: /mcp takes POST only (GET and DELETE 405), another Origin is refused, another host is off;
//   2. the 401: one exact challenge and body for no token, a bad token and a browser cookie alone;
//   3. the discovery documents, whole, at both addresses, and every CORS header on every door, including
//      the absence of CORS on authorize, the consent page, revoke and /mcp;
//   4. registration: what is kept and answered, each refusal, and the per-address limit before any parse;
//   5. authorize: sign-in first, unknown clients and unproven redirect URIs answered in place, the rest
//      sent back with iss, the consent page and its click (cookie, Origin, a consent burned once), the
//      remembered grant (page, no page, page again after revoking; other people and other apps still see it),
//      and the loopback redirect rules;
//   6. token: a wrong verifier burns the code, a code works once, binding mismatches, the exact answer, the
//      credential row, and that the token opens /mcp only (not the API, not git);
//   7. MCP on 2026-07-28: discover, tools/list against the census and the text budgets, every tool once with
//      real data (a monorepo, two projects, a branch, statuses, an artifact, a session, an issue), the
//      resources, malformed requests, an unsupported version, a header mismatch, subscriptions/listen
//      refused without a stream; and the 2025 era (initialize, tools/list, a call) for 2025-era hosts;
//   8. revocation: /oauth/revoke and Settings both end the app's whole grant, stop service at once, burn its
//      warm codes, and leave other apps' and other credentials' working.
//
//   PANDO_URL=http://127.0.0.1:8909 PANDO_E2E_STANDIN_PORT=8910 PANDO_STATE=<the server's --persist-to> node test/mcp.mjs
//
// The server runs with --var MCP_ORIGIN:<PANDO_URL>, and worker/.dev.vars points WORKOS_API_BASE at the
// stand-in's port. Registrations are limited to 10 a minute per address: leave a minute between runs.
// No credential, code or cookie is printed. Every repository it makes is deleted at the end.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, isConnectionReset, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

// wrangler dev closes idle keep-alive connections, and a request sent on one never reached it (record.mjs, artifacts.mjs):
// this suite's POSTs are sent again once too.
const once = globalThis.fetch;

globalThis.fetch = (input, init = {}) =>
  once(input, init).catch((err) => {
    if (!isConnectionReset(err)) throw err;

    return once(input, init);
  });

const URL_ = (process.env.PANDO_URL ?? "http://127.0.0.1:8909").replace(/\/$/, "");

const O = new URL(URL_).origin;

const STANDIN_PORT = Number(process.env.PANDO_E2E_STANDIN_PORT ?? 8910);

const STATE = process.env.PANDO_STATE ?? `${process.env.HOME}/.cache/pando-mcp/state`;

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const RECORDED = new URL("../../packages/contract/recorded/", import.meta.url);

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/pmc_[a-f0-9]{20,}/g, "<client>");

/** A real answer, for the contract's check (packages/contract/scripts/check-recorded.ts). */
const record = (file, schema, route, status, body) => writeFileSync(new URL(file, RECORDED), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`));
};

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers });

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pkce = () => {
  const verifier = b64url(randomBytes(32));

  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A local D1 query on the server's own state (read only). */
function d1(sql) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "pando-accounts-dev", "--local", "--persist-to", STATE, "--json", "--command", sql], {
    cwd: new URL("..", import.meta.url).pathname, encoding: "utf8",
  });

  try {
    return JSON.parse(r.stdout)[0].results;
  } catch {
    return null;
  }
}

// ── The stand-in WorkOS: AuthKit's page signs in `nextUser`; the code exchange checks PKCE ──
let nextUser = null;

const workosCodes = new Map();

const standin = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${STANDIN_PORT}`);
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "GET" && u.pathname === "/user_management/authorize") {
      const code = b64url(randomBytes(24));
      workosCodes.set(code, { challenge: u.searchParams.get("code_challenge"), user: nextUser });
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state"));

      return res.writeHead(302, { location: back.toString() }).end();
    }

    if (req.method === "POST" && u.pathname === "/user_management/authenticate") {
      const f = new URLSearchParams(body);
      const c = workosCodes.get(f.get("code"));

      if (!c || b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest()) !== c.challenge) {
        return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      }

      workosCodes.delete(f.get("code"));

      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: c.user, access_token: `${b64url("{}")}.${b64url(JSON.stringify({ sid: "sid_1" }))}.sig` }));
    }

    res.writeHead(404).end();
  });
});

await new Promise((r) => standin.listen(STANDIN_PORT, "127.0.0.1", r));

const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [];

const cookieValue = (set, name) => {
  const c = set.find((x) => x.startsWith(`${name}=`));

  return c ? c.slice(name.length + 1).split(";")[0] : null;
};

/** A browser sign-in as `user` through the stand-in: the session cookie's value. */
async function signIn(user) {
  nextUser = user;
  const start = await fetch(`${URL_}/v1/login/browser`, { redirect: "manual" });
  const login = cookieValue(cookiesOf(start), "__Host-pando_login");
  const atWorkos = await fetch(start.headers.get("location"), { redirect: "manual" });
  const cb = await fetch(atWorkos.headers.get("location"), { redirect: "manual", headers: { cookie: `__Host-pando_login=${login}` } });

  return cookieValue(cookiesOf(cb), "__Host-pando_session");
}

/** GET /oauth/authorize with these parameters, as a browser with this session (or none). */
const authorize = (params, session) =>
  fetch(`${URL_}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual", headers: session ? { cookie: `__Host-pando_session=${session}` } : {} });

/** The click on the consent page. */
function decide(session, consentCookie, consentId, decision, origin = O) {
  const headers = new Headers({ cookie: `__Host-pando_session=${session}; pando_mcp_consent=${consentCookie}`, "content-type": "application/x-www-form-urlencoded" });

  if (origin) headers.set("origin", origin);

  return fetch(`${URL_}/oauth/authorize`, { method: "POST", redirect: "manual", headers, body: new URLSearchParams({ consent: consentId, decision }) });
}

const token = (form) => fetch(`${URL_}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

const register = (body) => fetch(`${URL_}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const RESOURCE = `${O}/mcp`;

/** One whole sign-in for a registered client: authorize (page and Allow, or remembered), then the token. */
async function signInApp(clientId, redirectUri, session) {
  const p = pkce();
  let res = await authorize({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: p.challenge, code_challenge_method: "S256", state: "st", scope: "mcp", resource: RESOURCE }, session);
  let shown = false;

  if (res.status === 200) {
    shown = true;
    const html = await res.text();
    const id = /name="consent" value="([^"]+)"/.exec(html)?.[1];
    res = await decide(session, cookieValue(cookiesOf(res), "pando_mcp_consent"), id, "allow");
  }

  const code = new URL(res.headers.get("location")).searchParams.get("code");
  const t = await token({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: clientId, redirect_uri: redirectUri, resource: RESOURCE });

  return { shown, token: (await t.json()).access_token };
}

// ── MCP on the wire ──
const MODERN = "2026-07-28";

const meta = (version = MODERN) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "pando-mcp-test", version: "1.0.0" },
});

let rpcId = 0;

/** A modern JSON-RPC request with its standard headers; `extra` overrides them. */
async function rpc(bearer, method, params = {}, extra = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": method };

  if (bearer) headers.authorization = `Bearer ${bearer}`;

  if (method === "tools/call" || method === "prompts/get") headers["mcp-name"] = params.name;

  if (method === "resources/read") headers["mcp-name"] = params.uri;
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: meta(extra.version) } });
  const res = await fetch(`${URL_}/mcp`, { method: "POST", headers: { ...headers, ...extra.headers }, body: extra.raw ?? body });
  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {}

  return { status: res.status, type: res.headers.get("content-type"), headers: res.headers, json, text };
}

/** A tool call: its result (structured content, isError, content). */
const tool = async (bearer, name, args = {}) => (await rpc(bearer, "tools/call", { name, arguments: args })).json?.result;

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-mcp-"));

const home = join(work, "home");

mkdirSync(home);

let S = null;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

const gitEnv = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: `ana-${id}@pando.invalid`, GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: `ana-${id}@pando.invalid`,
};

// The keychain rule (AGENTS.md): no system config, the helper list emptied, then this one helper.
const git = (args, cwd, secret = S) =>
  spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { ...gitEnv, PANDO_SECRET: secret }, encoding: "utf8",
  });

/** The census: tools/list must give exactly these, in this order (worker/src/mcp/tools.ts TOOL_NAMES). */
const CENSUS = ["whoami", "list_repositories", "repository", "branch", "branch_diff", "merge", "issues", "write_issue", "read_artifact", "comment_artifact", "session", "launch_agent"];

const PRM = { resource: RESOURCE, authorization_servers: [O], bearer_methods_supported: ["header"], scopes_supported: ["mcp"], resource_name: "Pando" };

const ASM = {
  issuer: O,
  authorization_endpoint: `${O}/oauth/authorize`,
  token_endpoint: `${O}/oauth/token`,
  registration_endpoint: `${O}/oauth/register`,
  revocation_endpoint: `${O}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["mcp"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
};

const CHALLENGE = `Bearer realm="Pando", resource_metadata="${O}/.well-known/oauth-protected-resource/mcp", scope="mcp"`;

const UNAUTHORIZED_BODY = { error: "invalid_token", error_description: "Sign in to Pando: your MCP host opens the browser for it" };

const CORS_ALLOW_HEADERS = "authorization, content-type, accept, mcp-protocol-version";

try {
  // ── 1. Routing ──
  let r = await call("GET", "/mcp");
  check("GET /mcp is 405, Allow: POST", r.status === 405 && r.headers.get("allow") === "POST", `${r.status}`);
  r = await call("DELETE", "/mcp");
  check("DELETE /mcp is 405 (no sessions to end)", r.status === 405 && r.headers.get("allow") === "POST", `${r.status}`);
  const other = URL_.replace("127.0.0.1", "localhost");
  r = await request(other, "POST", "/mcp", { body: {} });
  const r2 = await request(other, "GET", "/.well-known/oauth-authorization-server");
  check("on a host other than MCP_ORIGIN's, /mcp and the documents are an ordinary 404", r.status === 404 && r2.status === 404 && r.json?.error?.code === "not_found" && !r2.headers.get("access-control-allow-origin"), `${r.status} ${r2.status}`);

  // ── 2. The 401 ──
  r = await call("POST", "/mcp", null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("no token: 401 with the exact challenge", r.status === 401 && r.headers.get("www-authenticate") === CHALLENGE, r.headers.get("www-authenticate"));
  check("no token: the fixed body, no-store, no CORS", same(r.json, UNAUTHORIZED_BODY) && r.headers.get("cache-control") === "no-store" && !r.headers.get("access-control-allow-origin"));
  record("mcp-401.json", "OAuthError", "POST /mcp (no token: 401)", r.status, r.json);
  r = await call("POST", "/mcp", `pando_${randomBytes(20).toString("hex")}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("a token Pando never made: the same 401, challenge and body (never anonymous)", r.status === 401 && r.headers.get("www-authenticate") === CHALLENGE && same(r.json, UNAUTHORIZED_BODY));
  r = await call("POST", "/mcp", "not-even-a-pando-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("a bearer of any other shape: the same 401", r.status === 401 && same(r.json, UNAUTHORIZED_BODY));

  // ── People: ana (bootstrap user, later the same person through the browser), bo (another person) ──
  const ana = { id: `user_ana_${id}`, email: `ana-${id}@pando.invalid`, email_verified: true, first_name: "Ana", last_name: "Lima" };
  const bo = { id: `user_bo_${id}`, email: `bo-${id}@pando.invalid`, email_verified: true, first_name: "Bo", last_name: "Berg" };
  const login = `ana-${id}`;
  S = (await call("POST", "/v1/users", BOOT, { login, name: "Ana Lima", email: ana.email, credential_name: "ana-mbp" })).json?.credential?.secret;
  check("ana, made by the bootstrap path, with a machine credential", !!S);
  const anaSession = await signIn(ana);
  const me = await call("GET", "/v1/user", null, null, { cookie: `__Host-pando_session=${anaSession}` });
  check("ana signs in through the browser (stand-in WorkOS) as the same person", me.status === 200 && me.json?.login === login, `${me.status} ${me.json?.login}`);
  const boSession = await signIn(bo);
  check("bo signs in through the browser too", !!boSession);

  r = await call("POST", "/mcp", null, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { cookie: `__Host-pando_session=${anaSession}` });
  check("a browser cookie alone is no MCP credential: the same 401", r.status === 401 && r.headers.get("www-authenticate") === CHALLENGE && same(r.json, UNAUTHORIZED_BODY));
  r = await call("POST", "/mcp", S, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" });
  check("another site's Origin is refused before anything (403)", r.status === 403 && !r.headers.get("access-control-allow-origin"), `${r.status}`);

  // ── 3. Discovery documents and CORS ──
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    r = await call("GET", path);
    check(`${path}: the whole document`, r.status === 200 && same(r.json, PRM) && r.text === JSON.stringify(PRM), r.text);
    check(`${path}: Access-Control-Allow-Origin * and no Allow-Credentials`, r.headers.get("access-control-allow-origin") === "*" && r.headers.get("access-control-allow-credentials") === null);
  }

  record("oauth-protected-resource.json", "ProtectedResourceMetadata", "GET /.well-known/oauth-protected-resource/mcp", r.status, r.json);

  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
    r = await call("GET", path);
    check(`${path}: the whole document, in order`, r.status === 200 && r.text === JSON.stringify(ASM), r.text.slice(0, 200));
    check(`${path}: Access-Control-Allow-Origin * and no Allow-Credentials`, r.headers.get("access-control-allow-origin") === "*" && r.headers.get("access-control-allow-credentials") === null);
  }

  record("oauth-authorization-server.json", "AuthorizationServerMetadata", "GET /.well-known/oauth-authorization-server", r.status, r.json);

  const preflight = (path) => fetch(`${URL_}${path}`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "mcp-protocol-version, content-type" } });

  for (const [path, methods] of [["/.well-known/oauth-protected-resource/mcp", "GET, HEAD, OPTIONS"], ["/.well-known/oauth-authorization-server", "GET, HEAD, OPTIONS"], ["/oauth/register", "POST, OPTIONS"], ["/oauth/token", "POST, OPTIONS"]]) {
    const p = await preflight(path);
    const h = p.headers;
    check(
      `preflight ${path}: 204, no body, allow-origin *, allow-methods ${methods}, the fixed allow-headers, max-age 600, no allow-credentials`,
      p.status === 204 && (await p.text()) === "" && h.get("access-control-allow-origin") === "*" && h.get("access-control-allow-methods") === methods &&
        h.get("access-control-allow-headers") === CORS_ALLOW_HEADERS && h.get("access-control-max-age") === "600" && h.get("access-control-allow-credentials") === null,
      `${p.status} ${h.get("access-control-allow-methods")}`,
    );
  }

  for (const [method, path] of [["GET", "/oauth/token"], ["GET", "/oauth/register"], ["GET", "/oauth/revoke"], ["POST", "/.well-known/oauth-authorization-server"], ["PUT", "/oauth/authorize"]]) {
    r = await call(method, path);
    check(`${method} ${path}: 405 with its Allow, and no CORS header`, r.status === 405 && !!r.headers.get("allow") && r.headers.get("access-control-allow-origin") === null, `${r.status}`);
  }

  r = await call("POST", "/oauth/revoke", null, null, { "content-type": "application/x-www-form-urlencoded", origin: "https://app.example" });
  check("POST /oauth/revoke: no CORS header", r.status === 200 && r.headers.get("access-control-allow-origin") === null, `${r.status}`);
  r = await call("POST", "/mcp", S, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("/mcp: no CORS header on an answer", r.headers.get("access-control-allow-origin") === null);
  const pre = await fetch(`${URL_}/oauth/authorize`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
  check("/oauth/authorize answers no preflight (405, no CORS)", pre.status === 405 && pre.headers.get("access-control-allow-origin") === null, `${pre.status}`);

  // ── 4. Registration (10 a minute per address: count them) ──
  const LOOP = "http://127.0.0.1/callback";
  // Cursor's registration as Workspaces recorded it: four URIs, one its own cursor:// scheme.
  const CURSOR_CB = "cursor://anysphere.cursor-mcp/oauth/callback";
  const C = await (await register({ client_name: "Cursor", redirect_uris: [CURSOR_CB, "http://localhost/callback", "http://127.0.0.1/callback", "https://cursor.com/oauth/callback"], grant_types: ["authorization_code", "refresh_token"] })).json();
  check("Cursor's registration shape (an app scheme among its URIs) is taken", (C.client_id ?? "").startsWith("pmc_") && C.redirect_uris.includes(CURSOR_CB));
  const regA = await register({ client_name: "Test Host A", redirect_uris: [LOOP, "testhost://oauth/callback"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none", application_type: "native", unknown_member: 1 });
  const A = await regA.json();
  check(
    "a registration (201): what Pando honours, narrowed (no refresh_token), no-store, CORS *, no null fields",
    regA.status === 201 && /^pmc_[0-9a-f]{40}$/.test(A.client_id) && same(Object.keys(A), ["client_id", "client_id_issued_at", "client_name", "redirect_uris", "grant_types", "response_types", "token_endpoint_auth_method", "scope"]) &&
      same(A.grant_types, ["authorization_code"]) && same(A.redirect_uris, [LOOP, "testhost://oauth/callback"]) && A.token_endpoint_auth_method === "none" && A.scope === "mcp" &&
      regA.headers.get("cache-control") === "no-store" && regA.headers.get("access-control-allow-origin") === "*" && !Object.values(A).includes(null),
    JSON.stringify(Object.keys(A)),
  );
  record("oauth-register.json", "OAuthClientRegistration", "POST /oauth/register (201)", regA.status, A);
  const B = await (await register({ client_name: "Test Host B‮ evil", redirect_uris: [LOOP] })).json();
  check("a second app: its name kept without format characters", B.client_name === "Test Host B evil", B.client_name);
  let made = 3;

  for (const [why, body, code] of [
    ["javascript:", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    ["http on a host on the internet", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    ["a fragment", { redirect_uris: ["https://ok.example/cb#x"] }, "invalid_redirect_uri"],
    ["a user and password", { redirect_uris: ["https://u:p@ok.example/cb"] }, "invalid_redirect_uri"],
    ["eleven URIs", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://ok.example/${i}`) }, "invalid_redirect_uri"],
    ["a client secret method", { redirect_uris: [LOOP], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
  ]) {
    const res = await register(body);
    made++;
    const j = await res.json();
    check(`registration refused: ${why} (400 ${code}, CORS *)`, res.status === 400 && j.error === code && res.headers.get("access-control-allow-origin") === "*", `${res.status} ${j.error}`);
  }

  r = await call("POST", "/oauth/register", null, null, { "content-type": "text/plain" });
  made++;
  check("registration as text/plain: 415", r.status === 415 && r.json?.error === "invalid_client_metadata", `${r.status}`);
  check("ten registrations made within the minute", made === 10, `${made}`);
  r = await call("POST", "/oauth/register", null, { redirect_uris: [LOOP] });
  check("the eleventh in a minute from one address: 429, Retry-After 60, before the body is read", r.status === 429 && r.headers.get("retry-after") === "60" && r.json?.error === "temporarily_unavailable", `${r.status}`);

  // ── 5. Authorize ──
  const p1 = pkce();
  const base = { response_type: "code", client_id: A.client_id, redirect_uri: "http://127.0.0.1:51001/callback", code_challenge: p1.challenge, code_challenge_method: "S256", state: "abc", scope: "mcp", resource: RESOURCE };
  r = await authorize(base);
  const loc = r.headers.get("location") ?? "";
  check("not signed in: off to the browser sign-in, coming back to the same request", r.status === 302 && loc.startsWith("/v1/login/browser?return_to=") && decodeURIComponent(loc.split("return_to=")[1]).startsWith("/oauth/authorize?"), loc.slice(0, 80));
  check("authorize answers never carry CORS", r.headers.get("access-control-allow-origin") === null);
  r = await authorize({ ...base, client_id: "pmc_unknown" }, anaSession);
  check("an unknown app: answered in place (400 page), never sent anywhere", r.status === 400 && !r.headers.get("location") && /not registered/.test(await r.text()), `${r.status}`);
  r = await authorize({ ...base, redirect_uri: "http://127.0.0.1:51001/elsewhere" }, anaSession);
  check("a redirect URI the app did not register: answered in place (400)", r.status === 400 && !r.headers.get("location"), `${r.status}`);

  const backOf = (res) => new URL(res.headers.get("location")).searchParams;

  r = await authorize({ ...base, code_challenge_method: "plain" }, anaSession);
  let q = backOf(r);
  check("PKCE plain: sent back as invalid_request with state and iss", r.status === 302 && q.get("error") === "invalid_request" && q.get("state") === "abc" && q.get("iss") === O);
  r = await authorize({ ...base, resource: "https://elsewhere.example/mcp" }, anaSession);
  q = backOf(r);
  check("another resource: sent back as invalid_target", q.get("error") === "invalid_target" && q.get("iss") === O);
  r = await authorize({ ...base, response_type: "token" }, anaSession);
  check("response_type token: unsupported_response_type", backOf(r).get("error") === "unsupported_response_type");

  // The consent page.
  r = await authorize(base, anaSession);
  let html = await r.text();
  const consentCookie = cookiesOf(r).find((c) => c.startsWith("pando_mcp_consent="));
  const consentValue = cookieValue(cookiesOf(r), "pando_mcp_consent");
  const consentId = /name="consent" value="([^"]+)"/.exec(html)?.[1];
  check("the consent page: 200, the app's name, unverified, who signs in, the loopback warning", r.status === 200 && /Connect Test Host A to Pando/.test(html) && /not verified/.test(html) && html.includes(login) && /Any program on this computer could have started this/.test(html));
  check("the consent page has no script and no sealed state in it", !/<script/i.test(html) && consentId === consentValue);
  check(
    "the consent page's headers: private no-store, frame DENY, no referrer, its CSP, no CORS",
    r.headers.get("cache-control") === "private, no-store" && r.headers.get("x-frame-options") === "DENY" && r.headers.get("referrer-policy") === "no-referrer" &&
      r.headers.get("content-security-policy") === "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'" && r.headers.get("access-control-allow-origin") === null,
  );
  check("the consent cookie: Path=/oauth/authorize, HttpOnly, Secure, SameSite=Lax, ten minutes", (consentCookie ?? "").endsWith("; Path=/oauth/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=600"), consentCookie?.replace(/=[^;]+/, "=<id>"));
  check("rendering the page made no code", d1(`SELECT COUNT(*) AS n FROM oauth_codes WHERE login = '${login}'`)?.[0]?.n === 0);

  r = await decide(anaSession, consentValue, consentId, "allow", null);
  check("Allow without Pando's Origin: refused (403), the cookie cleared", r.status === 403 && cookiesOf(r).some((c) => c.startsWith("pando_mcp_consent=;")), `${r.status}`);
  r = await decide(anaSession, "not-the-cookie", consentId, "allow");
  check("Allow with a cookie that is not this page's: refused (400)", r.status === 400 && !r.headers.get("location"), `${r.status}`);
  r = await decide(boSession, consentValue, consentId, "allow");
  check("Allow by another person signed in in that browser: refused, and the consent is spent", r.status === 400 && !r.headers.get("location"), `${r.status}`);
  r = await decide(anaSession, consentValue, consentId, "allow");
  check("the same consent again (spent): refused on Allow", r.status === 400 && !r.headers.get("location"), `${r.status}`);

  // A fresh page, Deny.
  r = await authorize(base, anaSession);
  html = await r.text();
  let cv = cookieValue(cookiesOf(r), "pando_mcp_consent");
  r = await decide(anaSession, cv, cv, "deny");
  q = backOf(r);
  check("Deny: back to the app with access_denied, state and iss (303), the cookie cleared", r.status === 303 && q.get("error") === "access_denied" && q.get("state") === "abc" && q.get("iss") === O && !q.get("code"));
  r = await decide(anaSession, cv, cv, "deny");
  check("the same consent again (spent): refused on Deny", r.status === 400, `${r.status}`);

  // A fresh page, Allow.
  r = await authorize(base, anaSession);
  cv = cookieValue(cookiesOf(r), "pando_mcp_consent");
  r = await decide(anaSession, cv, cv, "allow");
  q = backOf(r);
  const code1 = q.get("code");
  check("Allow: back to the app with a code, state and iss (303)", r.status === 303 && /^pando_[0-9a-f]{40}$/.test(code1 ?? "") && q.get("state") === "abc" && q.get("iss") === O);

  // ── 6. Token ──
  const tokenForm = { grant_type: "authorization_code", code: code1, code_verifier: p1.verifier, client_id: A.client_id, redirect_uri: base.redirect_uri, resource: RESOURCE };
  let t = await fetch(`${URL_}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tokenForm) });
  check("token as JSON: 415, CORS *", t.status === 415 && t.headers.get("access-control-allow-origin") === "*", `${t.status}`);
  t = await token({ ...tokenForm, grant_type: "refresh_token", refresh_token: "x" });
  check("refresh_token grant: unsupported_grant_type (no refresh tokens)", t.status === 400 && (await t.json()).error === "unsupported_grant_type");
  t = await token({ ...tokenForm, code_verifier: pkce().verifier });
  let tj = await t.json();
  check("a wrong verifier: invalid_grant, the fixed words, CORS *", t.status === 400 && tj.error === "invalid_grant" && tj.error_description === "the code is unknown, used, expired, or does not match this request" && t.headers.get("access-control-allow-origin") === "*");
  record("oauth-token-invalid-grant.json", "OAuthError", "POST /oauth/token (a wrong verifier)", t.status, tj);
  t = await token(tokenForm);
  check("the right verifier after a wrong one: the code is burned (invalid_grant)", t.status === 400 && (await t.json()).error === "invalid_grant");

  async function freshCode(clientId, redirectUri, session, p) {
    const res = await authorize({ ...base, client_id: clientId, redirect_uri: redirectUri, code_challenge: p.challenge }, session);

    if (res.status === 302) return new URL(res.headers.get("location")).searchParams.get("code");
    const c = cookieValue(cookiesOf(res), "pando_mcp_consent");

    return new URL((await decide(session, c, c, "allow")).headers.get("location")).searchParams.get("code");
  }

  const p2 = pkce();
  let code2 = await freshCode(A.client_id, base.redirect_uri, anaSession, p2);
  t = await token({ ...tokenForm, code: code2, code_verifier: p2.verifier, redirect_uri: "http://127.0.0.1:51002/callback" });
  check("a redirect URI other than the authorize request's: invalid_grant", t.status === 400 && (await t.json()).error === "invalid_grant");
  code2 = await freshCode(A.client_id, base.redirect_uri, anaSession, p2);
  t = await token({ ...tokenForm, code: code2, code_verifier: p2.verifier, resource: "https://elsewhere.example/mcp" });
  check("another resource at the token door: invalid_target", t.status === 400 && (await t.json()).error === "invalid_target");
  code2 = await freshCode(A.client_id, base.redirect_uri, anaSession, p2);
  t = await token({ ...tokenForm, code: code2, code_verifier: p2.verifier, client_id: B.client_id });
  check("another app's client_id: invalid_grant", t.status === 400 && (await t.json()).error === "invalid_grant");
  code2 = await freshCode(A.client_id, base.redirect_uri, anaSession, p2);
  t = await token({ ...tokenForm, code: code2, code_verifier: p2.verifier });
  tj = await t.json();
  const TA = tj.access_token;
  check(
    "the exchange: 200, exactly access_token, token_type, expires_in (ten years), scope; no refresh_token; no-store; CORS *",
    t.status === 200 && same(Object.keys(tj), ["access_token", "token_type", "expires_in", "scope"]) && /^pando_[0-9a-f]{40}$/.test(TA) && tj.token_type === "Bearer" && tj.expires_in === 315360000 && tj.scope === "mcp" &&
      t.headers.get("cache-control") === "no-store" && t.headers.get("access-control-allow-origin") === "*",
    JSON.stringify(Object.keys(tj)),
  );
  record("oauth-token.json", "OAuthToken", "POST /oauth/token (200)", t.status, tj);
  t = await token({ ...tokenForm, code: code2, code_verifier: p2.verifier });
  check("the same code twice: invalid_grant", t.status === 400 && (await t.json()).error === "invalid_grant");

  const rows = d1(`SELECT login, name, kind, client_id, monorepo_id, revoked_at, expires_at, workos_sid FROM credentials WHERE login = '${login}' AND kind = 'mcp'`);
  check("the credential row, whole: ana's, kind mcp, named after the app, its client_id, no expiry", same(rows, [{ login, name: "Test Host A", kind: "mcp", client_id: A.client_id, monorepo_id: null, revoked_at: null, expires_at: null, workos_sid: null }]), JSON.stringify(rows));
  r = await call("GET", "/v1/user/credentials", null, null, { cookie: `__Host-pando_session=${anaSession}` });
  check("Settings, Your machines: the sign-in shows as kind mcp, named after the app", r.json?.credentials?.some((c) => c.kind === "mcp" && c.name === "Test Host A"));
  record("credentials-mcp.json", "CredentialList", "GET /v1/user/credentials (with an MCP host's sign-in, kind mcp)", r.status, r.json);
  r = await call("GET", "/v1/user", TA);
  check("the MCP token does not open the API directly (401): its audience is /mcp", r.status === 401, `${r.status}`);

  // ── 7. MCP, 2026-07-28 ──
  r = await rpc(TA, "server/discover");
  const disc = r.json?.result;
  check(
    "server/discover: 2026-07-28, tools and resources without change events, Pando's identity, cache hints",
    r.status === 200 && r.type === "application/json" && disc?.supportedVersions?.includes(MODERN) && same(disc.capabilities, { tools: { listChanged: false }, resources: { listChanged: false } }) &&
      disc._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "pando" && disc.resultType === "complete" && disc.ttlMs === 3600000 && disc.cacheScope === "public",
    JSON.stringify(disc?.capabilities),
  );
  check("the instructions open with the whoami rule and fit Claude Code's 2,048 characters", disc?.instructions?.startsWith("Call whoami first") && disc.instructions.length <= 2048, `${disc?.instructions?.length}`);
  r = await rpc(TA, "tools/list");
  const tools = r.json?.result?.tools ?? [];
  check("tools/list is the census, in order", same(tools.map((x) => x.name), CENSUS), tools.map((x) => x.name).join(","));
  check("every description is at most 500 characters", tools.every((x) => x.description.length <= 500), tools.map((x) => x.description.length).join(","));
  const ann = Object.fromEntries(tools.map((x) => [x.name, x.annotations]));
  check(
    "annotations: reads are read-only; merge is a write, not destructive, idempotent; writes are not read-only",
    ["whoami", "list_repositories", "repository", "branch", "branch_diff", "issues", "read_artifact", "session"].every((n) => ann[n]?.readOnlyHint === true) &&
      ann.merge?.readOnlyHint === false && ann.merge?.destructiveHint === false && ann.merge?.idempotentHint === true &&
      ["write_issue", "comment_artifact", "launch_agent"].every((n) => ann[n]?.readOnlyHint === false && ann[n]?.idempotentHint === false),
  );
  check("tools/list carries its cache hints (public, an hour)", r.json?.result?.ttlMs === 3600000 && r.json?.result?.cacheScope === "public");

  let res = await tool(TA, "whoami");
  check("whoami: ana, through a credential of kind mcp named after the app", res?.structuredContent?.login === login && same(res.structuredContent.credential, { kind: "mcp", name: "Test Host A" }), JSON.stringify(res?.structuredContent?.credential));

  // Real data: a monorepo with two projects, a branch with a change, statuses, an artifact, a session, an issue.
  const M = `mcp-${id}`;
  r = await call("POST", "/v1/monorepos", S, { name: M });
  tw.add(`${login}/${M}`);
  const mono = `/v1/monorepos/${login}/${M}`;
  const REPO = `${login}/${M}`;
  check("a monorepo", r.status === 201, `${r.status}`);

  // Artifacts sometimes answers a repo's creation with 502: tried again, as a person would.
  const makeRepo = async (path) => {
    for (let i = 0; i < 4; i++) {
      const res2 = await call("POST", `${mono}/repos`, S, { path });

      if (res2.status !== 502) return res2;
      await new Promise((ok) => setTimeout(ok, 2000));
    }

    return call("POST", `${mono}/repos`, S, { path });
  };

  r = await makeRepo("projects/web");
  const WEB = r.json?.name;
  const webUrl = r.json?.clone_url;
  r = await makeRepo("projects/api");
  check("two projects in it", !!WEB && r.status === 201, `${r.status}`);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# web\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("main pushed", git(["push", "-q", webUrl, "main"], src).status === 0);
  const BR = "feat/checkout";
  git(["checkout", "-qb", BR], src);
  writeFileSync(join(src, "checkout.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "Add checkout total"], src);
  check("a branch pushed", git(["push", "-q", webUrl, BR], src).status === 0);
  const head = git(["rev-parse", "HEAD"], src).stdout.trim();
  const branchApi = `${mono}/repos/${WEB}/branches/${encodeURIComponent(BR)}`;
  r = await call("POST", `${mono}/repos/${WEB}/statuses/${head}`, S, { state: "failure", context: "ci/test", description: "2 failing" });
  check("a failing status on the branch head", r.status === 201 || r.status === 200, `${r.status}`);

  const form = new FormData();
  form.append("file", new Blob(["# Checkout plan\n\nTotal the cart, then charge it.\n"], { type: "text/markdown" }), "checkout-plan.md");
  const up = await fetch(`${URL_}${branchApi}/artifacts`, { method: "POST", body: form, headers: { authorization: `Bearer ${S}` } });
  const art = await up.json();
  check("an artifact on the branch", up.status === 201 && !!art.id, `${up.status}`);

  const fixture = readFileSync(new URL("./sessions/fixtures/pi.jsonl", import.meta.url), "utf8");
  const piAgent = JSON.parse(fixture.split("\n")[0]).id;
  let n = BigInt(`0x${createHash("sha256").update(`pi:${piAgent}`).digest("hex").slice(0, 32)}`);
  let sid = "";

  for (let i = 0; i < 26; i++) {
    sid = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(n & 31n)] + sid;
    n >>= 5n;
  }

  sid = `s_${sid}`;
  r = await request(URL_, "POST", `${mono}/sessions/${sid}/pieces?at=0&next=${Buffer.byteLength(fixture)}`, {
    secret: S, raw: fixture, headers: { "pando-session": JSON.stringify({ program: "pi", agent_id: piAgent, repo: WEB, branch: BR, parent: null }), "content-type": "application/x-ndjson" },
  });
  check("a recorded session on the branch", r.status === 200 && r.json?.id === sid, `${r.status}`);

  res = await tool(TA, "whoami");
  check("whoami names the repository with ana's role", res?.structuredContent?.repositories?.some((x) => x.repository === REPO && x.role === "owner"));
  // The home's counts are summed off the request (FEED_TICK_MS): wait for them.
  let listed = null;

  for (let i = 0; i < 40 && listed?.projects !== 2; i++) {
    res = await tool(TA, "list_repositories", { owner: login });
    listed = res?.structuredContent?.repositories?.find((x) => x.repository === REPO);

    if (listed?.projects !== 2) await new Promise((ok) => setTimeout(ok, 1000));
  }

  check("list_repositories: the repository, a monorepo with two projects", listed?.kind === "monorepo" && listed.projects === 2, JSON.stringify(listed));
  res = await tool(TA, "repository", { repository: REPO });
  const webP = res?.structuredContent?.projects?.find((x) => x.project === WEB);
  check(
    "repository: both projects, the branch open with its checks failing",
    res?.structuredContent?.counts?.projects === 2 && webP?.default_branch === "main" && webP.open_branches.some((b) => b.branch === BR && b.checks === "failure"),
    JSON.stringify(webP?.open_branches),
  );
  res = await tool(TA, "branch", { repository: REPO, branch: BR });
  check("branch without a project in a two-project repository: a tool error naming them", res?.isError === true && /2 projects/.test(res.content[0].text), res?.content?.[0]?.text);

  r = await call("POST", `${mono}/issues`, S, { title: "Checkout totals are wrong", body: "Fix in feat/checkout", link: [{ repo: WEB, branch: BR }] });
  const linkedIssue = r.json?.number;
  check("an issue linked to the branch", r.status === 201 && Number.isInteger(linkedIssue), `${r.status} ${r.text.slice(0, 120)}`);

  // A branch's facts (ahead, merge base, mergeable) and its issue links are worked out after the push: wait for them.
  for (let i = 0; i < 60; i++) {
    const [fb, fi] = await Promise.all([call("GET", branchApi, S), call("GET", `${mono}/issues?linked=${encodeURIComponent(`${WEB}:${BR}`)}&state=all`, S)]);

    if (fb.json?.stale === false && fi.json?.issues?.length) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }

  res = await tool(TA, "branch", { repository: REPO, project: WEB, branch: BR });
  const b = res?.structuredContent;
  check(
    "branch: head, ahead 1, mergeable, failing checks with the status, the artifact, the session, the linked issue",
    b?.head === head && b.ahead === 1 && b.mergeable === "clean" && b.sessions.some((x) => x.id === sid) && b.checks.state === "failure" && b.checks.statuses.some((s) => s.context === "ci/test" && s.state === "failure") &&
      b.artifacts.some((a) => a.id === art.id) && b.issues.some((i) => i.number === linkedIssue),
    JSON.stringify(b)?.slice(0, 300),
  );
  res = await tool(TA, "branch_diff", { repository: REPO, project: WEB, branch: BR });
  const d = res?.structuredContent;
  const link = res?.content?.find((c) => c.type === "resource_link");
  check(
    "branch_diff: the one file added, its patch, and a link to the whole diff",
    d?.files?.length === 1 && d.files[0].path === "checkout.ts" && d.files[0].status === "added" && /\+export const total/.test(d.patch) && link?.uri === d.full_diff && d.full_diff.startsWith("pando-diff://"),
    JSON.stringify(d?.files),
  );

  res = await tool(TA, "write_issue", { repository: REPO, action: "open", title: "Add a coupon field", body: "From the MCP", project: WEB, link: [{ project: WEB, branch: BR }] });
  const issueN = res?.structuredContent?.issue;
  check("write_issue open: a new issue", Number.isInteger(issueN) && res.structuredContent.state === "open", JSON.stringify(res?.structuredContent));
  res = await tool(TA, "write_issue", { repository: REPO, action: "comment", number: issueN, body: "Looking at it" });
  check("write_issue comment: a comment by ana", (res?.structuredContent?.comment ?? "").startsWith("ic_") && res.structuredContent.author === login);
  res = await tool(TA, "write_issue", { repository: REPO, action: "comment", body: "no number" });
  check("write_issue comment without a number: a tool error", res?.isError === true);
  res = await tool(TA, "issues", { repository: REPO, number: issueN });
  check("issues one: its body and the comment", res?.structuredContent?.body === "From the MCP" && res.structuredContent.comments.some((c) => c.body === "Looking at it" && c.author === login), JSON.stringify(res?.structuredContent)?.slice(0, 200));
  res = await tool(TA, "issues", { repository: REPO, q: "coupon" });
  check("issues list with words: the one found, with the counts", res?.structuredContent?.issues?.length === 1 && res.structuredContent.issues[0].number === issueN && res.structuredContent.counts.open >= 1);
  res = await tool(TA, "issues", { repository: REPO, number: 9999 });
  check("issues with a number that does not exist: Pando's refusal as a tool error", res?.isError === true && /Pando refused \(404/.test(res.content[0].text), res?.content?.[0]?.text);

  res = await tool(TA, "read_artifact", { repository: REPO, artifact: art.id });
  check("read_artifact: its document and versions", /Total the cart/.test(res?.structuredContent?.document ?? "") && res.structuredContent.versions.length === 1 && res.content.some((c) => c.type === "resource_link"));
  res = await tool(TA, "comment_artifact", { repository: REPO, artifact: art.id, body: "Charge after the total", quote: "Total the cart" });
  check("comment_artifact: a comment on a quoted passage", !!res?.structuredContent?.comment && res.structuredContent.artifact === art.id, JSON.stringify(res?.structuredContent));
  res = await tool(TA, "read_artifact", { repository: REPO, artifact: art.id });
  check("read_artifact shows the open thread", res?.structuredContent?.threads?.some((x) => x.body === "Charge after the total" && x.author === login));

  res = await tool(TA, "session", { repository: REPO, id: sid });
  check("session: who ran it, pi, its project and branch, its conversation", res?.structuredContent?.person === login && res.structuredContent.program === "pi" && res.structuredContent.branch === BR && res.structuredContent.entries.length > 0, JSON.stringify(res?.structuredContent)?.slice(0, 200));

  // launch_agent as bo, who is not a member: the launch route answers as it would for bo, and nothing starts
  // (a real launch would reach whichever pando-agents dev server is running on this machine).
  const tokBo = (await signInApp(B.client_id, "http://127.0.0.1:53000/callback", boSession)).token;
  res = await tool(tokBo, "launch_agent", { repository: REPO, project: WEB, branch: BR, prompt: "Fix the failing test" });
  check("launch_agent goes through Pando's launch route as the caller: bo, not a member, is refused (403) as a tool error", res?.isError === true && /Pando refused \(403 not_a_member\)/.test(res.content[0].text), res?.content?.[0]?.text?.slice(0, 160));

  r = await rpc(TA, "resources/read", { uri: d.full_diff });
  check("the branch's whole diff", /checkout\.ts/.test(r.json?.result?.contents?.[0]?.text ?? "") && r.json.result.contents[0].mimeType === "text/x-patch", r.text.slice(0, 200));

  res = await tool(TA, "merge", { repository: REPO, project: WEB, branch: BR });
  check("merge with a failing check: Pando's refusal (412 checks_not_green) as a tool error", res?.isError === true && /412 checks_not_green/.test(res.content[0].text), res?.content?.[0]?.text?.slice(0, 160));
  res = await tool(TA, "merge", { repository: REPO, project: WEB, branch: BR, force: true, expected_head: "0".repeat(40) });
  check("merge with an expected head the branch is not at: refused", res?.isError === true, res?.content?.[0]?.text?.slice(0, 160));
  res = await tool(TA, "merge", { repository: REPO, project: WEB, branch: BR, force: true, expected_head: head });
  check("merge with force: merged by ana, forced, closing the linked issues", res?.structuredContent?.status === "merged" && res.structuredContent.forced === true && res.structuredContent.merged_by === login && res.structuredContent.closes_issues.includes(issueN), JSON.stringify(res?.structuredContent));

  // Resources.
  r = await rpc(TA, "resources/templates/list");
  const templates = r.json?.result?.resourceTemplates?.map((x) => x.uriTemplate) ?? [];
  check("resources/templates/list: file, diff, artifact", same(templates, ["pando://{owner}/{name}/{project}/{ref}/{+path}", "pando-diff://{owner}/{name}/{project}/{branch}", "pando-artifact://{owner}/{name}/{id}/{version}"]), templates.join(" "));
  r = await rpc(TA, "resources/read", { uri: `pando://${REPO}/${WEB}/main/checkout.ts` });
  check("a file at main (merged): its text, private and not cached", /export const total/.test(r.json?.result?.contents?.[0]?.text ?? "") && r.json.result.cacheScope === "private" && r.json.result.ttlMs === 0, r.text.slice(0, 200));
  r = await rpc(TA, "resources/read", { uri: `pando://${REPO}/${WEB}/main/nope.ts` });
  check("a file that does not exist: an invalid-params error naming Pando's refusal", r.json?.error?.code === -32602 && /404/.test(r.json.error.message), r.text.slice(0, 200));
  r = await rpc(TA, "resources/read", { uri: `pando-artifact://${REPO}/${art.id}/1` });
  check("an artifact's document", /Total the cart/.test(r.json?.result?.contents?.[0]?.text ?? ""), r.text.slice(0, 200));

  // Malformed and refused requests.
  r = await rpc(TA, "tools/list", {}, { raw: "{not json" });
  check("a body that is not JSON: a JSON-RPC parse error, JSON, never HTML", r.json?.error?.code === -32700 && r.type?.startsWith("application/json"), `${r.status} ${r.text.slice(0, 120)}`);
  r = await rpc(TA, "tools/list", {}, { version: "2099-01-01", headers: { "mcp-protocol-version": "2099-01-01" } });
  check("an unsupported version: -32022 naming the supported ones", r.json?.error?.code === -32022 && JSON.stringify(r.json.error.data ?? {}).includes(MODERN), r.text.slice(0, 200));
  r = await rpc(TA, "tools/list", {}, { headers: { "mcp-method": "tools/call" } });
  check("Mcp-Method not matching the body: 400, -32020", r.status === 400 && r.json?.error?.code === -32020, `${r.status} ${r.text.slice(0, 120)}`);
  r = await rpc(TA, "no/such/method");
  check("an unknown method: -32601", r.json?.error?.code === -32601, r.text.slice(0, 120));
  r = await rpc(TA, "tools/call", { name: "issues", arguments: { repository: "not a repository" } });
  check("arguments the schema refuses: an error the model can read, not a crash", r.status === 200 && (r.json?.result?.isError === true || r.json?.error?.code === -32602), r.text.slice(0, 160));
  r = await rpc(TA, "subscriptions/listen", { notifications: { toolsListChanged: true } });
  check("subscriptions/listen: refused in a JSON answer, no event stream opened", !!r.json?.error && !(r.type ?? "").includes("text/event-stream"), `${r.type} ${r.text.slice(0, 160)}`);

  // The 2025 era, for 2025-era hosts (Codex 0.160 speaks 2025-06-18).
  const legacy = async (bearer, method, params, version = "2025-06-18") => {
    const headers = new Headers({ authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" });

    if (method !== "initialize") headers.set("mcp-protocol-version", version);

    const res2 = await fetch(`${URL_}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });

    return { status: res2.status, type: res2.headers.get("content-type"), session: res2.headers.get("mcp-session-id"), json: await res2.json().catch(() => null) };
  };

  r = await legacy(TA, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-host", version: "1" } });
  check("2025 era: initialize answers 2025-06-18 in JSON, with no session id", r.json?.result?.protocolVersion === "2025-06-18" && r.type?.startsWith("application/json") && r.session === null, JSON.stringify(r.json)?.slice(0, 160));
  r = await legacy(TA, "tools/list", {});
  check("2025 era: the same census", same(r.json?.result?.tools?.map((x) => x.name), CENSUS));
  r = await legacy(TA, "tools/call", { name: "whoami", arguments: {} });
  check("2025 era: whoami works", r.json?.result?.structuredContent?.login === login);

  // A machine credential (pando login) works at /mcp too, for scripts.
  res = await tool(S, "whoami");
  check("a machine credential works at /mcp (the scripts' lane), reported as its own kind", res?.structuredContent?.credential?.kind === "bootstrap" || res?.structuredContent?.credential?.kind === "machine", JSON.stringify(res?.structuredContent?.credential));
  const gitWithMcp = git(["ls-remote", webUrl], src, TA);
  check("the MCP token does not open git (only /mcp)", gitWithMcp.status !== 0);

  // ── 5b. The remembered grant, and the loopback rules ──
  const p3 = pkce();
  r = await authorize({ ...base, code_challenge: p3.challenge }, anaSession);
  check("the same app again for ana: no page, a code at once", r.status === 302 && !!backOf(r).get("code") && backOf(r).get("iss") === O, `${r.status}`);
  r = await authorize({ ...base, code_challenge: p3.challenge }, boSession);
  check("the same app for bo (another person): the page", r.status === 200);
  r = await authorize({ ...base, client_id: B.client_id, code_challenge: p3.challenge }, anaSession);
  check("another app for ana: the page", r.status === 200);

  for (const [uri, ok, why] of [
    ["http://127.0.0.1:59999/callback", true, "another port on loopback"],
    ["http://127.0.0.1:59999/callback?cb=7", true, "an added query on loopback (Codex)"],
    ["http://127.0.0.1:59999/other", false, "another path"],
    ["http://localhost:59999/callback", false, "another loopback host"],
    ["testhost://oauth/callback", true, "an app scheme, exactly"],
    ["testhost://oauth/callback?x=1", false, "an app scheme with an added query"],
  ]) {
    r = await authorize({ ...base, redirect_uri: uri, code_challenge: p3.challenge }, anaSession);
    check(`redirect URI ${ok ? "taken" : "refused in place"}: ${why}`, ok ? r.status === 302 && !!backOf(r).get("code") : r.status === 400 && !r.headers.get("location"), `${r.status}`);
  }

  const pc = pkce();
  r = await authorize({ ...base, client_id: C.client_id, redirect_uri: CURSOR_CB, code_challenge: pc.challenge }, anaSession);
  const cc = cookieValue(cookiesOf(r), "pando_mcp_consent");
  const cursorPage = await r.text();
  r = await decide(anaSession, cc, cc, "allow");
  const cursorBack = new URL(r.headers.get("location") ?? "x:");
  check("Cursor: the page says where the answer goes (the app that opens cursor:// links), and Allow goes back to cursor:// with a code", /opens <code>cursor:\/\/<\/code> links/.test(cursorPage) && cursorBack.protocol === "cursor:" && !!cursorBack.searchParams.get("code") && cursorBack.searchParams.get("iss") === O);
  t = await token({ grant_type: "authorization_code", code: cursorBack.searchParams.get("code"), code_verifier: pc.verifier, client_id: C.client_id, redirect_uri: CURSOR_CB, resource: RESOURCE });
  const tokC = (await t.json()).access_token;
  check("Cursor's code trades for a token that works", t.status === 200 && (await tool(tokC, "whoami"))?.structuredContent?.credential?.name === "Cursor");

  // ── 8. Revocation ──
  const tokB = (await signInApp(B.client_id, "http://127.0.0.1:52000/callback", anaSession)).token;
  check("a second app signed in for ana", !!tokB && (await tool(tokB, "whoami"))?.structuredContent?.credential?.name === "Test Host B evil");
  const pw = pkce();
  const warmA = await freshCode(A.client_id, base.redirect_uri, anaSession, pw);
  const pwB = pkce();
  const warmB = await freshCode(B.client_id, "http://127.0.0.1:52000/callback", anaSession, pwB);
  r = await call("POST", "/oauth/revoke", null, null, { "content-type": "application/x-www-form-urlencoded" });
  const revoke = (tok) => fetch(`${URL_}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok }) });
  let rv = await revoke(`pando_${randomBytes(20).toString("hex")}`);
  check("revoke a token Pando never made: 200 (no oracle)", rv.status === 200);
  rv = await revoke(S);
  check("revoke with ana's machine credential: 200, and it still works (this door reaches MCP credentials only)", rv.status === 200 && (await call("GET", "/v1/user", S)).status === 200);
  rv = await revoke(TA);
  check("revoke app A's token: 200", rv.status === 200);
  r = await rpc(TA, "tools/call", { name: "whoami", arguments: {} });
  check("after revoking, the same call is the 401 with the challenge", r.status === 401 && r.headers.get("www-authenticate") === CHALLENGE, `${r.status}`);
  t = await token({ ...tokenForm, code: warmA, code_verifier: pw.verifier });
  check("app A's code made before the revoke no longer trades", t.status === 400 && (await t.json()).error === "invalid_grant");
  t = await token({ ...tokenForm, code: warmB, code_verifier: pwB.verifier, client_id: B.client_id, redirect_uri: "http://127.0.0.1:52000/callback" });
  const tokB2 = (await t.json()).access_token;
  check("app B's code made at the same time still trades (control)", t.status === 200 && !!tokB2);
  check("app B's token still works (control)", (await tool(tokB, "whoami"))?.structuredContent?.login === login);
  r = await authorize({ ...base, code_challenge: p3.challenge }, anaSession);
  check("app A asks again: the consent page (the grant is gone)", r.status === 200);

  // Settings: revoking one of app B's credentials ends both.
  const list = (await call("GET", "/v1/user/credentials", null, null, { cookie: `__Host-pando_session=${anaSession}` })).json?.credentials ?? [];
  const bRows = list.filter((c) => c.kind === "mcp" && c.name === "Test Host B evil");
  check("Settings lists app B's two sign-ins", bRows.length === 2, `${bRows.length}`);
  r = await call("DELETE", `/v1/user/credentials/${bRows[0]?.id}`, null, null, { cookie: `__Host-pando_session=${anaSession}`, origin: O });
  check("revoked in Settings (204)", r.status === 204, `${r.status}`);
  check("both of app B's tokens stop at once", (await rpc(tokB, "tools/list")).status === 401 && (await rpc(tokB2, "tools/list")).status === 401);
  r = await call("GET", "/v1/user/credentials", null, null, { cookie: `__Host-pando_session=${anaSession}` });
  const left = (r.json?.credentials ?? []).filter((c) => c.kind === "mcp").map((c) => c.name);
  check("Settings lists only the app still connected (Cursor)", same(left, ["Cursor"]), left.join(","));
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  standin.close();

  check("this run's repositories are deleted", await tw.cleanup());

  rmSync(work, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;

console.log(`\n${passed} of ${results.length} passed`);

process.exit(passed === results.length ? 0 : 1);
