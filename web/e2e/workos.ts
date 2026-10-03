// A stand-in WorkOS for the e2e run, on this machine only (the Worker honours
// WORKOS_API_BASE only for a localhost address). It plays AuthKit's hosted
// page (signing in whoever the test named with POST /_next), the code
// exchange (checking the PKCE verifier), and the session logout.
//
//   node e2e/workos.ts        (Playwright starts it on STANDIN_PORT; worker/.dev.vars points here)
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { STANDIN_PORT } from "./ports.ts";

const PORT = STANDIN_PORT;

interface Person {
  id: string;
  email: string;
  email_verified: boolean;
  first_name: string;
  last_name: string | null;
}

const b64url = (b: Buffer) => b.toString("base64url");

const codes = new Map<string, { challenge: string; person: Person }>();

let next: Person | null = null;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    if (req.method === "POST" && url.pathname === "/_next") {
      next = JSON.parse(body);

      return res.writeHead(204).end();
    }

    if (req.method === "GET" && url.pathname === "/healthz") return res.writeHead(200).end("ok");

    if (req.method === "GET" && url.pathname === "/user_management/authorize") {
      const q = url.searchParams;
      const back = q.get("redirect_uri");

      if (!next || !back || q.get("code_challenge_method") !== "S256") return res.writeHead(400).end("bad authorize request");
      const code = b64url(randomBytes(24));
      codes.set(code, { challenge: q.get("code_challenge") ?? "", person: next });
      const to = new URL(back);
      to.searchParams.set("code", code);
      to.searchParams.set("state", q.get("state") ?? "");

      return res.writeHead(302, { location: to.toString() }).end();
    }

    if (req.method === "POST" && url.pathname === "/user_management/authenticate") {
      const form = new URLSearchParams(body);
      const saved = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";

      if (!saved || b64url(createHash("sha256").update(verifier).digest()) !== saved.challenge) {
        return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      }

      codes.delete(form.get("code") ?? "");
      const token = `${b64url(Buffer.from("{}"))}.${b64url(Buffer.from(JSON.stringify({ sid: `session_${saved.person.id}` })))}.sig`;

      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: saved.person, access_token: token, refresh_token: "r" }));
    }

    if (req.method === "GET" && url.pathname === "/user_management/sessions/logout") {
      return res.writeHead(302, { location: url.searchParams.get("return_to") ?? "/" }).end();
    }

    res.writeHead(404).end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`workos stand-in on ${PORT}`));
