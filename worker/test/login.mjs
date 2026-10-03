// pando login's device flow, end to end against WorkOS, through the Worker.
//
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev node test/login.mjs
//
// It prints a URL and a code; a person opens the URL, signs in to WorkOS and
// confirms the code. The script then checks the credential it got, revokes
// it, and checks that it no longer works. The credential's secret is never
// printed. Codes last 5 minutes; the script starts a new one when a code
// expires, for up to 20 minutes.
import { writeFileSync } from "node:fs";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const NOTE = "/tmp/pando-login-url.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body) => {
  const res = await fetch(URL_ + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const get = async (path, secret, method = "GET") => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}` } });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const deadline = Date.now() + 20 * 60_000;
let signedIn = null;
while (!signedIn && Date.now() < deadline) {
  const start = await post("/v1/login/device");
  if (start.status !== 200) {
    console.log("could not start:", start.status, JSON.stringify(start.json));
    process.exit(1);
  }
  const { device_code, user_code, verification_uri_complete, expires_in } = start.json;
  let interval = start.json.interval ?? 5;
  const line = `Open ${verification_uri_complete} and confirm the code ${user_code} (valid ${expires_in} s, until ${new Date(Date.now() + expires_in * 1000).toISOString()})`;
  console.log(line);
  writeFileSync(NOTE, line + "\n");
  const until = Date.now() + expires_in * 1000;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    const r = await post("/v1/login/token", { device_code, credential_name: "server-git-login-test", kind: "machine" });
    if (r.status === 200) {
      signedIn = r.json;
      break;
    }
    const code = r.json?.error?.code;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "expired_token") break;
    console.log("sign-in ended:", r.status, code, r.json?.error?.message);
    process.exit(1);
  }
}
if (!signedIn) {
  console.log("nobody confirmed a code in 20 minutes");
  process.exit(1);
}

const S = signedIn.credential.secret;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
check("signed in through WorkOS", !!S && S.startsWith("pando_"), `login ${signedIn.user.login}, email ${signedIn.user.email}, credential ${signedIn.credential.id} (${signedIn.credential.name}), joined [${signedIn.joined.join(", ")}]`);
let r = await get("/v1/user", S);
check("GET /v1/user with the new credential", r.status === 200 && r.json?.login === signedIn.user.login, `${r.status}`);
r = await get("/v1/monorepos", S);
check("GET /v1/monorepos", r.status === 200, (r.json?.monorepos ?? []).map((m) => `${m.name}:${m.role}`).join(" "));
r = await get(`/v1/user/credentials/${signedIn.credential.id}`, S, "DELETE");
check("the test credential is revoked", r.status === 204, `${r.status}`);
await sleep(16_000);
r = await get("/v1/user", S);
check("and no longer works", r.status === 401, `${r.status}`);
writeFileSync(NOTE, "done\n");
console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
