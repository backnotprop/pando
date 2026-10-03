// How a person gets a user and a first credential. The method is not decided
// (an emailed code, passkeys, or WorkOS). Until it is, the Worker secret
// PANDO_BOOTSTRAP makes users here. Every sign-in route lives in this module,
// so the method can change without touching the rest of the Worker: whatever
// it is, it ends by making a user (accounts.createUser) and handing the
// machine a credential (accounts.addCredential).

import { Hono } from "hono";
import type { Env } from "../env";
import { credential, HttpError, toErrorResponse } from "../http";
import { hashToken, isBootstrap, newToken } from "../monorepo/session";
import type { Outcome } from "../monorepo/types";
import { accounts } from "./auth";
import type { Credential, User } from "./object";

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
