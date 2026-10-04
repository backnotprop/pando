// Organizations: whose namespace `/{name}` is (a person or an org), an org's
// people and invites, the orgs you are in, and the writes on them. Keys:
// ["owner", name] the header (GET /v1/users/{name}), ["org", org, ...] its
// people and invites, ["orgs"] yours, ["activity", {owner}] its log.
import { ApiError, type Login, Routes } from "@pando/contract";
import { infiniteQueryOptions, queryOptions, skipToken } from "@tanstack/react-query";
import type * as Schema from "effect/Schema";
import { get, remove, write } from "./client";
import type { MonorepoRef } from "./names";

/** Reads a route the contract names: its path and the schema of its answer. */
const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

/** A person or an org; 404 when the name is neither. */
export const ownerQuery = (name: Login) => queryOptions({ queryKey: ["owner", name], queryFn: () => read(Routes.getOwner(name)), staleTime: 60_000 });

/** Whether a name is taken, as New organization asks while you type; null (not a possible name) asks nothing. */
export const nameQuery = (name: Login | null) =>
  queryOptions({ queryKey: ["owner", name ?? ""], queryFn: name ? () => read(Routes.getOwner(name)) : skipToken, retry: false, staleTime: 60_000 });

/** The orgs you are in, with your role in each. */
export const myOrgsQuery = queryOptions({ queryKey: ["orgs"], queryFn: () => read(Routes.listMyOrgs).then((r) => r.orgs), staleTime: 60_000 });

/** An org's people (its people only may ask). */
export const orgMembersQuery = (org: Login) => queryOptions({ queryKey: ["org", org, "members"], queryFn: () => read(Routes.listOrgMembers(org)).then((r) => r.members) });

export const orgInvitesQuery = (org: Login) => queryOptions({ queryKey: ["org", org, "invites"], queryFn: () => read(Routes.listOrgInvites(org)).then((r) => r.invites) });

/** Your activity log narrowed to one owner's monorepos, newest first, a page at a time. */
export const ownerActivityQuery = (owner: Login) =>
  infiniteQueryOptions({
    queryKey: ["activity", { owner }],
    queryFn: ({ pageParam }) => read(Routes.listActivity(pageParam || null, null, owner)),
    initialPageParam: "",
    getNextPageParam: (page) => page.next ?? undefined,
  });

/** The server's limits on an org's details (worker/src/accounts/org-routes.ts), in characters; a website is an https URL. */
export const ORG_LIMITS = { name: 100, description: 160, website: 2048 } as const;

/** A new org: its login (the namespace rule) and an optional display name. You are its first owner. */
export const createOrg = (login: string, name: string) => write(Routes.createOrg, name ? { login, name } : { login });

/** An org's display name, description and website (owners); an empty field is cleared. */
export const updateOrg = (org: Login, fields: { name: string; description: string; website: string }) =>
  write(Routes.updateOrg(org), { name: fields.name || null, description: fields.description || null, website: fields.website || null });

/** By email: someone with an account is added at once, anyone else when they first sign in. */
export const inviteToOrg = (org: Login, email: string, role: "member" | "owner") => write(Routes.orgInvite(org), { email, role });

/** Adds a person by login, or changes their role. */
export const putOrgMember = (org: Login, login: Login, role: "member" | "owner") => write(Routes.putOrgMember(org, login), { role });

/** Removes a person (owners), or yourself (Leave). */
export const removeOrgMember = (org: Login, login: Login) => remove(Routes.removeOrgMember(org, login));

export const revokeOrgInvite = (org: Login, email: string) => remove(Routes.revokeOrgInvite(org, email));

/** Moves a monorepo to another owner (you, or an org you are in); the old address keeps leading to it. */
export const transfer = (m: MonorepoRef, owner: Login) => write(Routes.transferMonorepo(m.owner, m.name), { owner });

/** The server's refusal to leave an org, or a role change, that would leave it without an owner. */
export const isLastOwner = (error: Error | null) => error instanceof ApiError && error.code === "last_owner";
