// Artifacts' reads and writes (packages/contract/src/artifact.ts): a branch's
// documents, each version's document with its images written in, and their
// comment threads. Every key sits under ["m", owner, name, "artifacts"], so an
// artifact's or a comment's event on the page's socket reads them again
// (live/rows.ts).
import { type ArtifactThread, type RepoName, Routes } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import { get, getText, remove, sendForm, write } from "./client";
import type { JsonBody } from "./json";
import type { MonorepoRef } from "./names";
import type { Group } from "../routes/$owner/$name/-artifacts/group";

export const artifactsKey = (m: MonorepoRef) => ["m", m.owner, m.name, "artifacts"] as const;

/** A branch's artifacts: its Artifacts tab, and the tab's count. */
export const artifactListQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...artifactsKey(m), "list", repo, branch],
    queryFn: () => {
      const route = Routes.listArtifacts(m.owner, m.name, repo, branch);

      return get(route.response, route.path);
    },
  });

/** One artifact with every version. */
export const artifactQuery = (m: MonorepoRef, id: string) =>
  queryOptions({
    queryKey: [...artifactsKey(m), "one", id],
    queryFn: () => {
      const route = Routes.getArtifact(m.owner, m.name, id);

      return get(route.response, route.path);
    },
  });

/** A version's Markdown or HTML, its images already written in as data: addresses (the server's). A version never changes. */
export const documentQuery = (m: MonorepoRef, id: string, n: number) =>
  queryOptions({
    queryKey: [...artifactsKey(m), "document", id, n],
    queryFn: () => getText(Routes.artifactDocumentPath(m.owner, m.name, id, n)).then((f) => f.text ?? ""),
    staleTime: Infinity,
  });

/** A version's main file's bytes (Raw, Download, an image's picture). */
export const fileHref = (m: MonorepoRef, id: string, n: number, path: string) => Routes.artifactFilePath(m.owner, m.name, id, n, path);

/** An artifact's threads, every version, open and resolved. */
export const threadsQuery = (m: MonorepoRef, id: string) =>
  queryOptions({
    queryKey: [...artifactsKey(m), "threads", id],
    queryFn: () => {
      const route = Routes.listArtifactThreads(m.owner, m.name, id);

      return get(route.response, route.path);
    },
  });

/** Every artifact's threads on the branch: the panel's All files. */
export const branchThreadsQuery = (m: MonorepoRef, repo: RepoName, branch: string) =>
  queryOptions({
    queryKey: [...artifactsKey(m), "branch-threads", repo, branch],
    queryFn: () => {
      const route = Routes.listBranchArtifactThreads(m.owner, m.name, repo, branch);

      return get(route.response, route.path);
    },
  });

// ── Writes ────────────────────────────────────────────────────────────────

/** One artifact, or its next version: the main file as `file`, each image as `image` named by its path from the document. */
export function addArtifact(m: MonorepoRef, repo: RepoName, branch: string, g: Group) {
  const form = new FormData();

  form.append("file", g.main.file, g.name);

  for (const i of g.images) form.append("image", i.picked.file, i.path);

  return sendForm(Routes.addArtifact(m.owner, m.name, repo, branch), form);
}

export const deleteArtifact = (m: MonorepoRef, id: string) => remove(Routes.deleteArtifact(m.owner, m.name, id));

/** A new thread on a version: Plannotator's anchor, or none for the whole artifact. */
export const addThread = (m: MonorepoRef, id: string, version: number, anchor: JsonBody | null, body: string, idempotencyKey: string) =>
  write(Routes.addArtifactComment(m.owner, m.name, id), anchor ? { body, version, anchor } : { body, version }, idempotencyKey);

/** A reply to a thread (its root). */
export const addReply = (m: MonorepoRef, id: string, root: string, body: string, idempotencyKey: string) =>
  write(Routes.addArtifactComment(m.owner, m.name, id), { body, in_reply_to: root }, idempotencyKey);

export const editComment = (m: MonorepoRef, id: string, body: string, baseVersion: number) => write(Routes.updateArtifactComment(m.owner, m.name, id), { body, base_version: baseVersion });

/** Resolves or reopens a thread (any member). */
export const setThreadState = (m: MonorepoRef, id: string, state: "open" | "resolved") => write(Routes.updateArtifactComment(m.owner, m.name, id), { state });

export const deleteComment = (m: MonorepoRef, id: string) => remove(Routes.deleteArtifactComment(m.owner, m.name, id));

/** A key made once per attempt, kept across its retries, so a lost answer never makes a second comment. */
export const newKey = () => crypto.randomUUID();

export type { ArtifactThread };
