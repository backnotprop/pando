// The merge gate: required checks from .pando/pando.toml on main, and
// GitHub's combined status over the latest status per context.

import { parse as parseToml } from "smol-toml";
import type { Env } from "../env";
import { withRepo } from "./artifacts";
import { metaArtifactsName } from "./names";
import type { Checks, Kind, RepoRecord, StatusRecord } from "./types";

// Read on every check, uncached: a merge into main can change it, and the
// gate must see the change at once.
async function readConfig(env: Env, artifactsName: string): Promise<Record<string, unknown> | null> {
  try {
    const blob = await withRepo(env, artifactsName, (repo) => repo.readFile({ ref: "main", path: ".pando/pando.toml" }));
    return blob ? (parseToml(await blob.text()) as Record<string, unknown>) : null;
  } catch (err) {
    // An empty repo, a missing file or a bad file all mean "no required checks".
    console.warn(`pando.toml in ${artifactsName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** `repos."<repo path>".required_checks` from the right pando.toml (formats.md, section 2). */
export async function requiredChecks(env: Env, monorepo: { id: string; kind: Kind }, repo: RepoRecord): Promise<string[]> {
  const source = monorepo.kind === "repo" ? repo.artifacts_name : metaArtifactsName(monorepo.id);
  const toml = await readConfig(env, source);
  const repos = toml?.repos as Record<string, { required_checks?: unknown }> | undefined;
  const list = repos?.[repo.path]?.required_checks;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/** The latest status per context, then the gate's verdict. */
export function combine(sha: string | null, required: string[], all: StatusRecord[]): Checks {
  const latest = new Map<string, StatusRecord>();
  for (const s of all) latest.set(s.context, s); // `all` is oldest first
  const statuses = [...latest.values()];
  const missing = required.filter((c) => !latest.has(c));
  const considered = required.length ? statuses.filter((s) => required.includes(s.context)) : statuses;
  let state: Checks["state"] = "success";
  if (considered.some((s) => s.state === "failure")) state = "failure";
  else if (considered.some((s) => s.state === "error")) state = "error";
  else if (missing.length) state = "missing";
  else if (considered.some((s) => s.state === "pending")) state = "pending";
  return { sha, state, required, missing, statuses };
}

/**
 * Required checks as the monorepo object keeps them (C3): read from
 * pando.toml only when the object has none, which is after a merge or main's
 * first push in the repo that holds the file.
 */
export async function requiredKept(env: Env, monorepo: { id: string; kind: Kind }, repo: RepoRecord): Promise<string[]> {
  const stub = env.MONOREPO.getByName(monorepo.id);
  const kept = await stub.storedRequired(repo.name);
  if (kept) return kept;
  const list = await requiredChecks(env, monorepo, repo);
  await stub.setRequiredChecks(repo.name, list);
  return list;
}
