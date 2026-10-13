// The merge gate: required checks from .pando/pando.toml on main, and
// GitHub's combined status over the latest status per context.

import { parse as parseToml, TomlDate, TomlError, type TomlTable, type TomlValue } from "smol-toml";
import type { Env } from "../env";
import { HttpError } from "../http";
import { isRecord, isText, isWholeNumber, type Json } from "../parse";
import { withRepo } from "./artifacts";
import { metaArtifactsName } from "./names";
import type { Checks, Kind, RepoRecord, StatusRecord } from "./types";

/**
 * pando.toml could not be read, or does not parse: the required checks are
 * unknown, never taken as none (the gate fails closed). `why` says what is
 * wrong with the file; without it, the read failed and a retry may work.
 */
export const checksUnknown = (why: string | null = null): HttpError =>
  new HttpError(503, "checks_unknown", why ? `${why}; fix it on main, or merge with force` : "Pando couldn't read this monorepo's required checks; try again");

export function isChecksUnknown(err: unknown): err is HttpError {
  return err instanceof HttpError && err.code === "checks_unknown";
}

// Read whenever the monorepo object keeps no list: a merge into main can
// change it, and the gate must see the change at once. A file that does not
// parse is never kept either: each read tries it again, so the fix's merge
// counts at once.
async function readConfig(env: Env, artifactsName: string, failRead = false): Promise<TomlTable | null> {
  let text: string | null;

  try {
    if (failRead) throw new Error("checks test: the config read failed");
    const blob = await withRepo(env, artifactsName, (repo) => repo.readFile({ ref: "main", path: ".pando/pando.toml" }));
    text = blob ? await blob.text() : null;
  } catch (err) {
    // Artifacts failed: unknown. Nothing is kept, so the next read tries again.
    console.warn(`pando.toml in ${artifactsName} not read: ${err instanceof Error ? err.message : String(err)}`);
    throw checksUnknown();
  }

  // An empty repo (no main) or no file: no required checks.
  if (text === null) return null;

  try {
    return parseToml(text);
  } catch (err) {
    // "Invalid TOML document: <what>", then the lines around it.
    const what = (err instanceof Error ? err.message : String(err)).split("\n")[0].replace(/^Invalid TOML document: /, "");

    throw checksUnknown(err instanceof TomlError ? `pando.toml line ${err.line}: ${what}` : `pando.toml: ${what}`);
  }
}

/** A TOML table (`[section]` or an inline `{ }`), not a list, a date or a plain value. */
function isTomlTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === "object" && !Array.isArray(v) && !(v instanceof TomlDate);
}

/** `repos."<repo path>".required_checks` from the right pando.toml (formats.md, section 2); throws checks_unknown when it cannot be read. */
export async function requiredChecks(env: Env, monorepo: { id: string; kind: Kind }, repo: RepoRecord, failRead = false): Promise<string[]> {
  const source = monorepo.kind === "repo" ? repo.artifacts_name : metaArtifactsName(monorepo.id);
  const toml = await readConfig(env, source, failRead);
  const repos = toml?.repos;
  const entry = isTomlTable(repos) ? repos[repo.path] : undefined;
  const list = isTomlTable(entry) ? entry.required_checks : undefined;

  return Array.isArray(list) ? list.filter(isText) : [];
}

/** The required checks, or (list null) why they are unknown: pando.toml could not be read or does not parse. */
export interface Required {
  list: string[] | null;
  unknown: string | null;
}

/** The latest status per context, then the gate's verdict: `unknown` while the required checks are. */
export function combine(sha: string | null, req: Required, all: StatusRecord[]): Checks {
  const latest = new Map<string, StatusRecord>();

  for (const s of all) latest.set(s.context, s); // `all` is oldest first
  const statuses = [...latest.values()];
  const required = req.list;

  if (required === null) return { sha, state: "unknown", required: null, missing: [], statuses, checks_unknown: req.unknown };
  const missing = required.filter((c) => !latest.has(c));
  const considered = required.length ? statuses.filter((s) => required.includes(s.context)) : statuses;
  let state: Checks["state"] = "success";

  if (considered.some((s) => s.state === "failure")) state = "failure";
  else if (considered.some((s) => s.state === "error")) state = "error";
  else if (missing.length) state = "missing";
  else if (considered.some((s) => s.state === "pending")) state = "pending";

  return { sha, state, required, missing, statuses, checks_unknown: null };
}

/** A commit's state where a build state is shown: combine()'s, or "not_built" when nothing reported on it. */
export type BuildState = Checks["state"] | "not_built";

/**
 * The build state a page shows (the project page's main): a commit with no
 * statuses and no required checks reads "not_built", never green. The merge
 * gate and the release gate keep combine()'s state (success there), so a repo
 * with no CI still merges as before.
 */
export function buildState(c: Checks): BuildState {
  return c.state === "success" && c.statuses.length === 0 ? "not_built" : c.state;
}

/**
 * Required checks as the monorepo object keeps them (C3): read from
 * pando.toml only when the object has none, which is after a merge or main's
 * first push in the repo that holds the file. When it cannot be read or does
 * not parse, the list is null with the reason, and nothing is kept: reads
 * show it, and only the merge refuses (object.ts mergeNow).
 */
export async function requiredKept(env: Env, monorepo: { id: string; kind: Kind }, repo: RepoRecord): Promise<Required> {
  const stub = env.MONOREPO.getByName(monorepo.id);
  const kept = await stub.storedRequired(repo.name);

  if (kept) return { list: kept, unknown: null };
  const failRead = env.CHECKS_TEST === "1" && (await stub.takeConfigFail());

  try {
    const list = await requiredChecks(env, monorepo, repo, failRead);
    await stub.setRequiredChecks(repo.name, list);

    return { list, unknown: null };
  } catch (err) {
    if (isChecksUnknown(err)) return { list: null, unknown: err.message };
    throw err;
  }
}

/**
 * Tests only (CHECKS_TEST=1 and the bootstrap secret): POST /v1/_checks/test
 * {monorepo, fail} makes the next `fail` reads of pando.toml fail, as an
 * Artifacts error would. The monorepo is its id.
 */
export async function checksTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.CHECKS_TEST !== "1") return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  const { credential } = await import("../http");
  const { isBootstrap } = await import("./session");

  if (!(await isBootstrap(env, credential(request)))) return Response.json({ error: { code: "unauthorized", message: "the bootstrap secret only" } }, { status: 401 });
  const b = request.method === "POST" ? await request.json<Json>().catch(() => null) : null;

  if (!isRecord(b) || !isText(b.monorepo) || !isWholeNumber(b.fail)) return Response.json({ error: { code: "bad_request", message: "monorepo (its id) and fail" } }, { status: 400 });

  return Response.json(await env.MONOREPO.getByName(b.monorepo).testChecks(b.fail));
}

/**
 * Risk-based review's sensitive paths: `[review] sensitive = [...]` in the
 * same pando.toml, paths from each project's root; the defaults when the file
 * names none. When the file cannot be read or does not parse, the defaults
 * too (a sensitive change still reaches a person).
 */
export async function sensitivePatterns(env: Env, monorepo: { id: string; kind: Kind }, repo: RepoRecord, defaults: readonly string[]): Promise<string[]> {
  const source = monorepo.kind === "repo" ? repo.artifacts_name : metaArtifactsName(monorepo.id);
  const toml = await readConfig(env, source).catch(() => null);
  const review = toml?.review;
  const list = isTomlTable(review) ? review.sensitive : undefined;

  return Array.isArray(list) ? list.filter(isText) : [...defaults];
}
