// The web's writes (POST, PATCH, DELETE), each checked by the Worker for Pando's own Origin.
import { post, postOrRefused, write } from "./client";
import type { MonorepoRef } from "./names";
import * as Pending from "./pending";
import { ErrorBody, type Login, type RepoName, Routes } from "@pando/contract";

/** Ends this browser's session, then WorkOS's (its logout page returns to /). */
export async function signOut(): Promise<void> {
  const out = await post(Routes.logout.response, Routes.logout.path, {});
  location.assign(out.logout_url);
}

/** Writes a root file back as it was at `version`, as a new version every machine receives. */
export const restore = (m: MonorepoRef, path: string, version: number) => {
  const route = Routes.restore(m.owner, m.name);

  return post(route.response, route.path, { path, version, machine: "the web" });
};

/**
 * Merges the branch with a merge commit, exactly at `head` (409 `head_moved`
 * if it moved since the page showed it). `force` goes past red or missing
 * checks. A refusal (conflicts, checks, the head moved) is an answer.
 */
export const merge = (m: MonorepoRef, repo: RepoName, branch: string, head: string, force: boolean) => {
  const route = Routes.mergeBranch(m.owner, m.name, repo, branch, force);

  return postOrRefused(route.response, ErrorBody, route.path, { expected_head: head }, [409, 412]);
};

// ── Slice 3: members, settings, your machines, CI ──────────────────────────

/** Invites by email: a person with an account joins at once (`added`); anyone else gets an invite. */
export const invite = (m: MonorepoRef, email: string, role: "member" | "owner") => write(Pending.invite(m.owner, m.name), { email, role });

export const revokeInvite = (m: MonorepoRef, email: string) => write(Pending.revokeInvite(m.owner, m.name, email));

export const removeMember = (m: MonorepoRef, login: Login) => write(Pending.removeMember(m.owner, m.name, login));

/** A new name within the same owner; the old one keeps leading here. */
export const rename = (m: MonorepoRef, name: string) => write(Pending.renameMonorepo(m.owner, m.name), { name });

/** Deletes the monorepo, its repos and their history: the full owner/name is the confirmation. */
export const deleteMonorepo = (m: MonorepoRef) => write(Pending.deleteMonorepo(m.owner, m.name));

export const revokeCredential = (id: string) => write(Pending.revokeCredential(id));

export const rebuild = (m: MonorepoRef, build: string) => write(Pending.rebuild(m.owner, m.name, build));

export const cancelBuild = (m: MonorepoRef, build: string) => write(Pending.cancel(m.owner, m.name, build));

export const retryJob = (m: MonorepoRef, build: string, job: string) => write(Pending.retry(m.owner, m.name, build, job));

/** A build of the branch's head, with fresh tokens. */
export const newBuild = (m: MonorepoRef, pipeline: string, branch: string) => write(Pending.newBuild(m.owner, m.name, pipeline), { branch });

export const disconnect = (m: MonorepoRef, connection: string) => write(Pending.disconnect(m.owner, m.name, connection));
