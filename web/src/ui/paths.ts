// The app's addresses, GitHub's shape (owner ruling): /{owner}/{name}, then
// /tree/, /blob/ and /history/ for a monorepo's root files and folders. Each
// helper gives TanStack Router's typed link options; raw files are the
// Worker's, so they are plain URLs.
import { linkOptions } from "@tanstack/react-router";

const split = (full: string) => {
  const [owner = "", name = ""] = full.split("/");

  return { owner, name };
};

export const ownerLink = (owner: string) => linkOptions({ to: "/$owner", params: { owner } });

export const monoLink = (full: string) => linkOptions({ to: "/$owner/$name", params: split(full) });

export const treeLink = (full: string, dir: string) =>
  dir ? linkOptions({ to: "/$owner/$name/tree/$", params: { ...split(full), _splat: dir } }) : monoLink(full);

export const blobLink = (full: string, path: string, version: number | null = null) =>
  linkOptions({ to: "/$owner/$name/blob/$", params: { ...split(full), _splat: path }, search: version ? { v: String(version) } : {} });

export const historyLink = (full: string, path: string) => linkOptions({ to: "/$owner/$name/history/$", params: { ...split(full), _splat: path } });

export const tabLink = (full: string, tab: "activity" | "machines" | "ci" | "members" | "settings") =>
  linkOptions({ to: `/$owner/$name/${tab}`, params: split(full) });

/** A project's page (projects/web); a plain repo's is the monorepo's own. */
export const repoLink = (full: string, repoPath: string) =>
  repoPath === "." ? monoLink(full) : linkOptions({ to: "/$owner/$name/projects/$", params: { ...split(full), _splat: repoPath.replace(/^projects\//, "") } });

/** A branch's page: the pull request (slice 2). */
export const branchLink = (full: string, repoPath: string, branch: string) =>
  repoPath === "."
    ? linkOptions({ to: "/$owner/$name/branches/$", params: { ...split(full), _splat: branch } })
    : linkOptions({ to: "/$owner/$name/projects/$", params: { ...split(full), _splat: `${repoPath.replace(/^projects\//, "")}/branches/${branch}` } });

export type AppLink =
  | ReturnType<typeof ownerLink>
  | ReturnType<typeof monoLink>
  | ReturnType<typeof treeLink>
  | ReturnType<typeof blobLink>
  | ReturnType<typeof historyLink>
  | ReturnType<typeof tabLink>
  | ReturnType<typeof repoLink>
  | ReturnType<typeof branchLink>;

/** The full address, for Copy link and Copy raw link. */
export const absolute = (href: string) => new URL(href, location.origin).toString();

/** Docs, the changelog and the quiet links, until the domain is bought (APPROACH, Docs). */
export const DOCS = "https://pando-docs.plannotator.workers.dev";
