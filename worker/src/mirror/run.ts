// One mirror run, in the Worker (objects order, Workers work): make GitHub's
// main equal Pando's, now. A run converges two states and replays nothing,
// so running it twice, or again after a crash, does the same thing or
// nothing. GitHub is always overwritten (owner, 2026-10-04); each push still
// names what GitHub had when the run read its refs, so a push landing on
// GitHub mid-run makes this one update fail and the next run overwrite it.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { HttpError } from "../http";
import { listRefs } from "../monorepo/artifacts";
import type { PushReport } from "../monorepo/pktline";
import { timed } from "../timing";
import { composeRun } from "./compose";
import { installationToken, remoteFor } from "./github";
import { uploadLfs } from "./lfs";
import { artifactsPack, pushPack, RemoteError, remoteRefs, ZERO, type PushAnswer, type Remote } from "./pipe";
import type { MirrorJob, MirrorProblem, MirrorResult, MirrorSource } from "./types";

export class MirrorDrain extends WorkerEntrypoint<Env> {
  async run(job: MirrorJob): Promise<MirrorResult> {
    const t0 = Date.now();

    return timed("drain", { route: "mirror.run", monorepo_id: job.monorepo, target: job.target, mode: job.mode }, () => runOne(this.env, job)).then(
      (r) => ({ ...r, ms: Date.now() - t0 }),
      (cause) => ({ ok: false, sent: job.sent, composed: job.composed, last_sha: null, problem: problemOf(cause), pushes: 0, ms: Date.now() - t0 }),
    );
  }
}

/** A connected remote: GitHub's refs as the run found them, with a token tried once again if GitHub refused it. */
export interface Connected {
  remote: Remote;
  refs: Map<string, string>;
}

async function connect(env: Env, job: MirrorJob): Promise<Connected> {
  let token = await installationToken(env, job.installation, [job.github.id]);
  let remote = remoteFor(env, job.github.full_name, token);

  try {
    return { remote, refs: await remoteRefs(remote) };
  } catch (err) {
    if (!(err instanceof RemoteError) || (err.status !== 401 && err.status !== 403)) throw err;
    token = await installationToken(env, job.installation, [job.github.id], true);
    remote = remoteFor(env, job.github.full_name, token);

    return { remote, refs: await remoteRefs(remote) };
  }
}

/** A source's main on Pando now (Artifacts' refs, the truth), or null while it has none. */
export async function pandoMain(env: Env, s: MirrorSource): Promise<string | null> {
  return (await listRefs(env, s.ref)).get(`refs/heads/${s.branch}`) ?? null;
}

/** Send one source's main to `ref` on the remote: the LFS objects first (the files outside projects/), then the pack. */
export async function sendSource(env: Env, monorepo: string, c: Connected, s: MirrorSource, sha: string, ref: string): Promise<PushAnswer> {
  if (s.meta) await uploadLfs(env, monorepo, c.remote);
  const pack = await artifactsPack(env, s.ref, [sha], [...new Set(c.refs.values())]);

  return pushPack(c.remote, [{ old: c.refs.get(ref) ?? ZERO, new: sha, ref }], pack);
}

async function runOne(env: Env, job: MirrorJob): Promise<Omit<MirrorResult, "ms">> {
  const c = await connect(env, job);

  if (job.mode === "whole") return composeRun(env, job, c);
  const s = job.sources[0];

  if (!s) return { ok: true, sent: {}, composed: null, last_sha: null, problem: null, pushes: 0 };
  const want = await pandoMain(env, s);
  const ref = `refs/heads/${s.branch}`;

  // Nothing on Pando yet, or GitHub already there: no receive-pack at all.
  if (!want) return { ok: true, sent: job.sent, composed: null, last_sha: null, problem: null, pushes: 0 };

  if (c.refs.get(ref) === want) return { ok: true, sent: { [s.repo]: want }, composed: null, last_sha: want, problem: null, pushes: 0 };
  const answer = await sendSource(env, job.monorepo, c, s, want, ref);
  const problem = refusalOf(answer, ref);

  return problem ? { ok: false, sent: job.sent, composed: null, last_sha: null, problem, pushes: 1 } : { ok: true, sent: { [s.repo]: want }, composed: null, last_sha: want, problem: null, pushes: 1 };
}

// ── What went wrong, for the person ─────────────────────────────────────────

/** A ref update GitHub refused because its value moved during the run: the next run overwrites it. */
const RACED = /stale info|fetch first|failed to lock|cannot lock|reference already exists|non-fast-forward|failed to update ref/i;

/** The push's problem, or null when the ref landed. */
export function refusalOf(a: PushAnswer, ref: string): MirrorProblem | null {
  const r: PushReport = a.report;

  if (r.error) return { code: /busy|try again|timeout/i.test(r.error) ? "retrying" : "refused", message: `GitHub refused the push: ${r.error}`, retry_after_s: null };

  if (r.unpack !== "ok") return { code: "refused", message: `GitHub could not take the objects: ${r.unpack ?? "no answer"}`, retry_after_s: null };
  const reason = r.refs.get(ref);

  if (reason === undefined) return { code: "retrying", message: "GitHub did not say whether main landed", retry_after_s: null };

  if (reason === null) return null;

  if (RACED.test(reason)) return { code: "retrying", message: "A push reached GitHub during the run; overwriting it next", retry_after_s: 0 };

  return { code: "refused", message: plainRefusal(reason, a.messages), retry_after_s: null };
}

/** GitHub's reason for a refused update in one sentence, with its own words where they help. */
function plainRefusal(reason: string, messages: string): string {
  const said = messages.split("\n").find((l) => /error|GH0\d\d|denied|protected|secret|workflow|lfs/i.test(l)) ?? "";
  let plain = reason;

  if (/protected/i.test(reason + said)) plain = "main is protected on GitHub";
  else if (/workflow/i.test(said)) plain = "the GitHub App lacks the Workflows permission to change .github/workflows";
  else if (/secret/i.test(said)) plain = "GitHub's push protection found a secret in the history";
  else if (/lfs/i.test(said)) plain = "GitHub is missing large files the push names";

  return `GitHub refused the push: ${plain}${said && !said.includes(plain) ? ` (${said.replace(/^remote:\s*/i, "").slice(0, 200)})` : ""}`;
}

/** Any failure as a problem: GitHub's answers by status; Pando's and Artifacts' own as passing. */
export function problemOf(cause: unknown): MirrorProblem {
  const err = cause;
  const message = (err instanceof Error ? err.message : String(err)).replace(/ghs_[A-Za-z0-9_.-]+/g, "<token>").slice(0, 300);

  if (err instanceof RemoteError) {
    const after = err.retryAfter ? Number(err.retryAfter) : NaN;
    const retry_after_s = Number.isFinite(after) ? after : null;

    if (err.status === 404) return { code: "not_found", message: "The repository is not on GitHub, or the Pando app was removed from it", retry_after_s: null };

    if (err.status === 401 || err.status === 403 || err.status === 422) {
      if (retry_after_s !== null || /rate limit/i.test(message)) return { code: "retrying", message: "GitHub asked Pando to wait", retry_after_s };

      return { code: "no_access", message: "The Pando app can't reach this repository on GitHub", retry_after_s: null };
    }

    return { code: "retrying", message: err.status ? `GitHub answered ${err.status}` : "GitHub did not answer", retry_after_s };
  }

  if (err instanceof HttpError && err.status === 503 && err.code === "github_app_missing") return { code: "refused", message: err.message, retry_after_s: null };

  return { code: "retrying", message, retry_after_s: null };
}
