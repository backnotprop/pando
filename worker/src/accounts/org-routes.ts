// Organizations (profile SPEC section 5), and whose `/{name}` is. Signed in
// (cookie or Bearer), registered on the signed-in person's routes (api.ts):
//   GET    /v1/users/{name}                 a person or an org; 404 for neither
//   GET    /v1/user/orgs                    the orgs you are in, with your role
//   POST   /v1/orgs {login, name?}          make one; you are its first owner
//   GET    /v1/orgs/{org}                   its header (anyone signed in)
//   PATCH  /v1/orgs/{org}                   its name, description, website (owners)
//   GET    /v1/orgs/{org}/members           its people (its people)
//   PUT    /v1/orgs/{org}/members/{login}   add by login, or change a role (owners)
//   DELETE /v1/orgs/{org}/members/{login}   remove someone (owners), or leave (yourself); their sockets
//                                           on the org's monorepos they had only through it close
//   POST   /v1/orgs/{org}/invites           by email: added now, or at that email's first sign-in (owners)
//   GET    /v1/orgs/{org}/invites           invites still waiting (its people)
//   DELETE /v1/orgs/{org}/invites/{email}   withdraw one (owners)
// A membership change drops this isolate's cached sign-ins (others see it
// within 15 s) and tells the home's feed once per (org monorepo, person).

import type * as Contract from "@pando/contract";
import { hasControl, HttpError } from "../http";
import { isRecord, isText, type Json, type JsonObject } from "../parse";
import { namespaceProblem, validNamespace } from "../monorepo/names";
import type { UserApp, UserContext as C } from "../monorepo/api";
import { feedOrgMembership } from "../feed/membership";
import { closeAfterOrgLeave } from "../monorepo/access";
import { accounts, forgetCachedAuth } from "./auth";
import type { Accounts, MemberRole, Org, OrgPatch } from "./store";

/** An org's display name and a person's name: the profile spec's limit. */
const NAME_MAX = 100;

/** An org's description: GitHub's bio length, as the profile's. */
const DESCRIPTION_MAX = 160;

/** A website: an https URL, as long as a picture URL may be. */
const URL_MAX = 2048;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

export async function jsonBody(c: C): Promise<JsonObject> {
  const b = await c.req.json<Json>().catch(() => null);

  if (!isRecord(b)) bad("the body must be a JSON object");

  return b;
}

/** An optional text field: undefined when left out, null when null or empty. */
export function text(v: Json | undefined, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;

  if (v === null || v === "") return null;

  if (!isText(v) || v.length > max || hasControl(v)) bad(`${field}: text of at most ${max} characters`);

  return v;
}

function website(v: Json | undefined): string | null | undefined {
  const t = text(v, "website", URL_MAX);

  if (!t) return t;

  try {
    if (new URL(t).protocol === "https:") return t;
  } catch {
    // not a URL
  }

  bad("website: an https URL");
}

function role(v: Json | undefined, dflt?: MemberRole): MemberRole {
  const r = v ?? dflt;

  if (r !== "owner" && r !== "member") bad("role is owner or member");

  return r;
}

/** The org in the path as the caller sees it, if they may do `need` there. */
async function orgFor(c: C, need: "anyone" | "member" | "owner", what = ""): Promise<{ acc: Accounts; org: Org; me: string }> {
  const name = c.req.param("org")?.toLowerCase() ?? "";
  const me = c.get("auth").user.login;
  const acc = accounts(c.env);
  const org = validNamespace(name) ? await acc.getOrg(name, me) : null;

  if (!org) throw new HttpError(404, "not_found", `no organization ${name}`);

  if (need === "member" && !org.role) throw new HttpError(403, "not_a_member", `${me} is not in ${org.login}`);

  if (need === "owner" && org.role !== "owner") throw new HttpError(403, "owner_only", `only an owner of ${org.login} can ${what}`);

  return { acc, org, me };
}

/** After someone joined or left: this isolate forgets cached sign-ins, and their feed hears about each org monorepo. */
async function changed(c: C, org: string, login: string): Promise<void> {
  forgetCachedAuth();
  await feedOrgMembership(c.env, org, login);
}

export function orgRoutes(app: UserApp): void {
  app.get("/v1/users/:name", async (c) => {
    const name = c.req.param("name").toLowerCase();
    const owner = validNamespace(name) ? await accounts(c.env).owner(name, c.get("auth").user.login) : null;

    if (!owner) throw new HttpError(404, "not_found", `no person or organization ${name}`);

    return c.json(owner satisfies typeof Contract.Owner.Encoded);
  });

  app.get("/v1/user/orgs", async (c) => c.json({ orgs: await accounts(c.env).orgsOf(c.get("auth").user.login) } satisfies typeof Contract.OrgList.Encoded));

  app.post("/v1/orgs", async (c) => {
    const b = await jsonBody(c);
    const login = isText(b.login) ? b.login.toLowerCase() : null;
    const problem = namespaceProblem(login);

    if (problem === "reserved") throw new HttpError(400, "reserved_name", `${login} is reserved`);

    if (problem || !login) bad("login: letters, digits and single hyphens, at most 39, no hyphen at either end");
    const name = text(b.name, "name", NAME_MAX) ?? null;
    const me = c.get("auth").user.login;
    const acc = accounts(c.env);

    if (!(await acc.createOrg(login, name, me))) throw new HttpError(409, "namespace_taken", `${login} is taken (a person or an organization)`);
    forgetCachedAuth();

    return c.json((await acc.getOrg(login, me))! satisfies typeof Contract.Org.Encoded, 201);
  });

  app.get("/v1/orgs/:org", async (c) => c.json((await orgFor(c, "anyone")).org satisfies typeof Contract.Org.Encoded));

  app.patch("/v1/orgs/:org", async (c) => {
    const { acc, org, me } = await orgFor(c, "owner", "change its details");
    const b = await jsonBody(c);
    const patch: OrgPatch = { name: text(b.name, "name", NAME_MAX), description: text(b.description, "description", DESCRIPTION_MAX), website: website(b.website) };
    await acc.updateOrg(org.login, patch);

    return c.json((await acc.getOrg(org.login, me))! satisfies typeof Contract.Org.Encoded);
  });

  app.get("/v1/orgs/:org/members", async (c) => {
    const { acc, org } = await orgFor(c, "member");

    return c.json({ members: await acc.orgMembers(org.login) } satisfies typeof Contract.OrgMemberList.Encoded);
  });

  app.put("/v1/orgs/:org/members/:login", async (c) => {
    const { acc, org, me } = await orgFor(c, "owner", "add people or change their role");
    const login = c.req.param("login").toLowerCase();
    const out = await acc.putOrgMember(org.login, login, role((await jsonBody(c)).role), me);

    if (!out.ok) throw new HttpError(out.status, out.code, out.message);
    await changed(c, org.login, login);

    return c.json(out.value satisfies typeof Contract.OrgMember.Encoded);
  });

  app.delete("/v1/orgs/:org/members/:login", async (c) => {
    const login = c.req.param("login").toLowerCase();
    const { acc, org } = await orgFor(c, login === c.get("auth").user.login ? "member" : "owner", "remove people");
    const out = await acc.removeOrgMember(org.login, login);

    if (!out.ok) throw new HttpError(out.status, out.code, out.message);
    await changed(c, org.login, login);
    await closeAfterOrgLeave(c.env, org.login, login);

    return c.body(null, 204);
  });

  app.post("/v1/orgs/:org/invites", async (c) => {
    const { acc, org, me } = await orgFor(c, "owner", "invite people");
    const b = await jsonBody(c);
    const email = isText(b.email) ? b.email : "";

    if (email.length > 200 || !EMAIL_RE.test(email)) bad("email is not an email address");
    const out = await acc.orgInvite(org.login, email, role(b.role, "member"), me);

    if (!out.ok) throw new HttpError(out.status, out.code, out.message);

    if (out.value.status === "added") await changed(c, org.login, out.value.member.login);

    return c.json(out.value satisfies typeof Contract.OrgInviteResult.Encoded, out.value.status === "added" ? 200 : 201);
  });

  app.get("/v1/orgs/:org/invites", async (c) => {
    const { acc, org } = await orgFor(c, "member");

    return c.json({ invites: await acc.orgInvites(org.login) } satisfies typeof Contract.InviteList.Encoded);
  });

  app.delete("/v1/orgs/:org/invites/:email", async (c) => {
    const { acc, org } = await orgFor(c, "owner", "withdraw invites");

    if (!(await acc.revokeOrgInvite(org.login, decodeURIComponent(c.req.param("email"))))) throw new HttpError(404, "not_found", "no such invite");

    return c.body(null, 204);
  });
}
