// The merge gate: required checks from .pando/pando.toml on main, and
// GitHub's combined status over the latest status per context.

import { parse as parseToml, TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import type { Env } from "../env";
import { HttpError } from "../http";
import { isRecord, isText, isWholeNumber, type Json } from "../parse";
import { withRepo } from "./artifacts";
import { metaArtifactsName } from "./names";
import type { Checks, Kind, RepoRecord, StatusRecord } from "./types";

/** pando.toml could not be read: the required checks are unknown, never taken as none (the gate fails closed). */
export const checksUnknown = (): HttpError => new HttpError(503, "checks_unknown", "Pando couldn't read this monorepo's required checks; try again");

export function isChecksUnknown(err: unknown): err is HttpError {
  return err instanceof HttpError && err.code === "checks_unknown";
}

// Read whenever the monorepo object keeps no list: a merge into main can
// change it, and the gate must see the change at once.
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
    // A file that is not TOML: no required checks.
    console.warn(`pando.toml in ${artifactsName}: ${err instanceof Error ? err.message : String(err)}`);

    return null;
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
 * first push in the repo that holds the file. A failed read throws
 * checks_unknown (503) and keeps nothing.
 */
export async function requiredKept(env: Env, monorepo: { id: string; kind: Kind }, repo: RepoRecord): Promise<string[]> {
  const stub = env.MONOREPO.getByName(monorepo.id);
  const kept = await stub.storedRequired(repo.name);

  if (kept) return kept;
  const failRead = env.CHECKS_TEST === "1" && (await stub.takeConfigFail());
  const list = await requiredChecks(env, monorepo, repo, failRead);
  await stub.setRequiredChecks(repo.name, list);

  return list;
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
