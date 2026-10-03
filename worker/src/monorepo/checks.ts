// The merge gate: required checks from .pando/pando.toml on main, and
// GitHub's combined status over the latest status per context.

import { parse as parseToml } from "smol-toml";
import type { Env } from "../env";
import { withRepo } from "./artifacts";
import { metaArtifactsName } from "./names";
import type { Checks, Kind, RepoRecord, StatusRecord } from "./types";

const CACHE_MS = 15_000;
const configCache = new Map<string, { at: number; toml: Record<string, unknown> | null }>();

async function readConfig(env: Env, artifactsName: string): Promise<Record<string, unknown> | null> {
  const hit = configCache.get(artifactsName);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.toml;
  let toml: Record<string, unknown> | null = null;
  try {
    const blob = await withRepo(env, artifactsName, (repo) => repo.readFile({ ref: "main", path: ".pando/pando.toml" }));
    if (blob) toml = parseToml(await blob.text()) as Record<string, unknown>;
  } catch (err) {
    // An empty repo, a missing file or a bad file all mean "no required checks".
    console.warn(`pando.toml in ${artifactsName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  configCache.set(artifactsName, { at: Date.now(), toml });
  return toml;
}

/** `repos."<repo path>".required_checks` from the right pando.toml (formats.md, section 2). */
export async function requiredChecks(env: Env, monorepo: { name: string; kind: Kind }, repo: RepoRecord): Promise<string[]> {
  const source = monorepo.kind === "repo" ? repo.artifacts_name : metaArtifactsName(monorepo.name);
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
