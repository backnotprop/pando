// Mirror to GitHub, the Settings section's reads and writes (SPEC 5.3). Keys
// sit under ["m", owner, name, "mirror"]. The page's socket (kind
// mirror.updated, live/rows.ts) reads the section again when a run or a
// setting changes; while a row is on its way it is also read every 3 s.
import { type MirrorMode, type MirrorStateName, Routes } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import type * as Schema from "effect/Schema";
import { get, type JsonBody, remove, write } from "./client";
import type { MonorepoRef } from "./names";

const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

export const mirrorKey = (m: MonorepoRef) => ["m", m.owner, m.name, "mirror"] as const;

/** A row on its way to GitHub: worth asking again soon. */
export const moving = (state: MirrorStateName) => state === "waiting" || state === "mirroring" || state === "not_started";

/** How often the section is read while a row is on its way. */
export const MOVING_MS = 3000;

/** The connection, the mode, the switch, and one row per source. */
export const mirrorQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...mirrorKey(m), "section"],
    queryFn: () => read(Routes.getMirror(m.owner, m.name)),
  });

/** The installation's repositories, for Change. Read again when the tab regains focus (a person may have added one on GitHub). */
export const githubReposQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...mirrorKey(m), "github-repos"],
    queryFn: () => read(Routes.listGithubRepos(m.owner, m.name)),
    staleTime: 0,
  });

/** The installations this browser proved at GitHub, when there were several to choose from. */
export const githubChoicesQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...mirrorKey(m), "choices"],
    queryFn: () => read(Routes.getGithubChoices(m.owner, m.name)).then((r) => r.installations),
    staleTime: Infinity,
  });

/** Where the browser goes to connect GitHub (Pando's address, which sends it on to GitHub). */
export const connectPath = (m: MonorepoRef) => Routes.mirrorConnectPath(m.owner, m.name, "connect");

/** One source's GitHub repository: an existing one by id, or one Pando creates (private) by name. Off needs neither. */
export interface TargetChoice {
  repo: string;
  on: boolean;
  github_id: number | null;
  create: string | null;
}

function targetBody(t: TargetChoice): JsonBody {
  if (t.on && t.create !== null) return { repo: t.repo, on: true, create: { name: t.create } };

  return t.github_id === null ? { repo: t.repo, on: t.on } : { repo: t.repo, on: t.on, github_id: t.github_id };
}

/** The section's switch: off pauses, on sends everything. */
export const setMirrorOn = (m: MonorepoRef, on: boolean) => write(Routes.setMirrorOn(m.owner, m.name), { on });

/** Start mirroring, Change, or a row's switch: the mode and the full list. An answer with authorize_url sends the browser to GitHub first. */
export const saveMirrorTargets = (m: MonorepoRef, mode: MirrorMode, targets: readonly TargetChoice[]) =>
  write(Routes.saveMirrorTargets(m.owner, m.name), { mode, targets: targets.map(targetBody) });

/** A row's Retry: now, with its backoff reset. */
export const retryMirror = (m: MonorepoRef, repo: string) => write(Routes.retryMirror(m.owner, m.name), { repos: [repo] });

/** Disconnect: the rows and the link go; GitHub is never touched. */
export const disconnectMirror = (m: MonorepoRef) => remove(Routes.disconnectMirror(m.owner, m.name));

/** One of the installations this browser proved. */
export const chooseInstallation = (m: MonorepoRef, installation: number) => write(Routes.chooseGithubInstallation(m.owner, m.name), { installation_id: installation });
