// How a person gets a Pando user and a machine credential. Every sign-in
// route lives in this module.
//
// - `pando login`: WorkOS AuthKit's CLI Auth (the OAuth device flow). The
//   Worker talks to WorkOS itself, so it receives the signed-in user straight
//   from api.workos.com and needs no token verification. WorkOS only proves
//   identity: its access and refresh tokens are dropped, and Pando keeps its
//   own users, credentials and membership (accounts/object.ts).
// - Self-hosted, single user: PANDO_BOOTSTRAP makes a user (POST /v1/users).
//
// Secrets read here, never logged: WORKOS_CLIENT_ID (public in a device flow,
// but kept as a secret anyway) and PANDO_BOOTSTRAP.

import { Hono } from "hono";
import type { Env } from "../env";
import { credential, HttpError, toErrorResponse } from "../http";
import { hashToken, isBootstrap, newToken } from "../monorepo/session";
import type { Outcome } from "../monorepo/types";
import { accounts } from "./auth";
import type { Credential, CredentialKind, User } from "./object";

export const signin = new Hono<{ Bindings: Env }>();
signin.onError((err) => toErrorResponse(err));

const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,38}$/;

/** Make a user and their first credential (bootstrap secret only). */
signin.post("/v1/users", async (c) => {
  if (!c.env.PANDO_BOOTSTRAP) throw new HttpError(503, "bootstrap_not_configured", "the Worker secret PANDO_BOOTSTRAP is not set");
  if (!(await isBootstrap(c.env, credential(c.req.raw)))) throw new HttpError(401, "unauthorized", "making users needs the bootstrap secret until sign-in exists");
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new HttpError(400, "bad_request", "the body must be a JSON object");
  if (typeof b.login !== "string" || !LOGIN_RE.test(b.login)) throw new HttpError(400, "bad_request", "login: lower-case letters, digits and single hyphens, at most 39");
  const opt = (v: unknown, field: string) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length > 200) throw new HttpError(400, "bad_request", `${field} must be a short string`);
    return v;
  };
  const secret = newToken();
  const out = (await accounts(c.env).createUser(
    { login: b.login, name: opt(b.name, "name"), email: opt(b.email, "email") },
    { hash: await hashToken(secret), name: opt(b.credential_name, "credential_name") ?? "bootstrap", kind: "bootstrap" },
  )) as Outcome<{ user: User; credential: Credential }>;
  if (!out.ok) throw new HttpError(out.status, out.code, out.message);
  return c.json({ user: out.value.user, credential: { ...out.value.credential, secret } }, 201);
});

// ── pando login: WorkOS CLI Auth ─────────────────────────────────────────

const WORKOS = "https://api.workos.com/user_management";

function workosClient(env: Env): string {
  if (!env.WORKOS_CLIENT_ID) throw new HttpError(503, "sign_in_not_configured", "the Worker secret WORKOS_CLIENT_ID is not set");
  return env.WORKOS_CLIENT_ID;
}

async function workos(path: string, form: Record<string, string>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${WORKOS}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/** Step 1: a code for the person to confirm in the browser, and a device code for the CLI to poll with. */
signin.post("/v1/login/device", async (c) => {
  const r = await workos("/authorize/device", { client_id: workosClient(c.env) });
  if (!r.ok) {
    throw new HttpError(502, "workos", `WorkOS refused to start the sign-in (${r.status}): ${String(r.data.error ?? r.data.message ?? "")}`.trim());
  }
  const d = r.data;
  return c.json({
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    verification_uri_complete: d.verification_uri_complete,
    expires_in: d.expires_in,
    interval: d.interval,
  });
});

const PENDING = new Set(["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant"]);

/** Step 2, polled: once the person confirmed, the Pando user and a new machine credential. */
signin.post("/v1/login/token", async (c) => {
  const clientId = workosClient(c.env);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b.device_code !== "string" || !b.device_code) throw new HttpError(400, "bad_request", "device_code is required");
  const name = b.credential_name;
  if (typeof name !== "string" || !name || name.length > 200) throw new HttpError(400, "bad_request", "credential_name (the machine name) is required");
  const kind = (b.kind ?? "machine") as CredentialKind;
  if (kind !== "machine" && kind !== "sandbox") throw new HttpError(400, "bad_request", "kind is machine or sandbox");

  const r = await workos("/authenticate", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: b.device_code,
    client_id: clientId,
  });
  if (!r.ok) {
    const code = String(r.data.error ?? "sign_in_failed");
    const message = String(r.data.error_description ?? "the sign-in did not complete");
    throw new HttpError(400, PENDING.has(code) ? code : "sign_in_failed", message);
  }
  const u = r.data.user as { id?: string; email?: string; email_verified?: boolean; first_name?: string | null; last_name?: string | null } | undefined;
  if (!u?.id || !u.email) throw new HttpError(502, "workos", "WorkOS returned no user");
  const display = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
  const secret = newToken();
  const out = (await accounts(c.env).signIn(
    { workos_id: u.id, email: u.email, email_verified: u.email_verified === true, name: display },
    { hash: await hashToken(secret), name, kind },
  )) as { user: User; credential: Credential; joined: string[] };
  return c.json({ user: out.user, credential: { ...out.credential, secret }, joined: out.joined });
});
