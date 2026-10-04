// The web's writes (POST, PATCH, DELETE), each checked by the Worker for Pando's own Origin.
import { post, postOrRefused, remove, write } from "./client";
import type { MonorepoRef } from "./names";
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
export const invite = (m: MonorepoRef, email: string, role: "member" | "owner") => write(Routes.invite(m.owner, m.name), { email, role });

export const revokeInvite = (m: MonorepoRef, email: string) => remove(Routes.revokeInvite(m.owner, m.name, email));

export const removeMember = (m: MonorepoRef, login: Login) => remove(Routes.removeMember(m.owner, m.name, login));

/** A new name within the same owner; the old one keeps leading here. */
export const rename = (m: MonorepoRef, name: string) => write(Routes.renameMonorepo(m.owner, m.name), { name });

/** Its one-line description, under its name (owners); an empty one clears it. */
export const describe = (m: MonorepoRef, description: string) => write(Routes.describeMonorepo(m.owner, m.name), { description: description.trim() || null });

/** Deletes the monorepo, its repos and their history: the full owner/name is the confirmation. */
export const deleteMonorepo = (m: MonorepoRef) => remove(Routes.deleteMonorepo(m.owner, m.name));

export const revokeCredential = (id: string) => remove(Routes.revokeCredential(id));

export const rebuild = (m: MonorepoRef, build: string) => write(Routes.rebuildCiBuild(m.owner, m.name, build));

export const cancelBuild = (m: MonorepoRef, build: string) => write(Routes.cancelCiBuild(m.owner, m.name, build));

export const retryJob = (m: MonorepoRef, build: string, job: string) => write(Routes.retryCiJob(m.owner, m.name, build, job));

/** A build of the branch's head, with fresh tokens. */
export const newBuild = (m: MonorepoRef, pipeline: string, branch: string) => write(Routes.startCiBuild(m.owner, m.name, pipeline), { branch });

/** A pipeline for a project: its Buildkite hook, so each push starts a build of it (owners). */
export const addPipeline = (m: MonorepoRef, repo: RepoName, organization: string, pipeline: string) =>
  write(Routes.addHook(m.owner, m.name, repo), { type: "buildkite", buildkite: { organization, pipeline } });

export const disconnect = (m: MonorepoRef, connection: string) => remove(Routes.disconnectCi(m.owner, m.name, connection));
