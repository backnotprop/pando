// Risk-based review's work off the push (the facts drain, monorepo/facts.ts):
// read the change, score it with clef, decide the tier, launch the reviewer
// agents (ai and human tiers), and queue the guided review (human tier).
// Each head runs once; the object refuses a second write (store.ts).

import type { Env } from "../env";
import { putBytes } from "../hashput";
import { HttpError } from "../http";
import { reviewPrompt } from "../agents/review";
import { launchAs } from "../agents/routes";
import { withRepo } from "../monorepo/artifacts";
import { sensitivePatterns } from "../monorepo/checks";
import { toPatch, treeDiff, type DiffResult } from "../monorepo/diff";
import { commitReader, compareWith } from "../monorepo/graph";
import type { MonorepoObject } from "../monorepo/object";
import type { Identity, ObjectInfo, Outcome, RepoRecord } from "../monorepo/types";
import { DEFAULT_MODEL } from "../../../agents/src/protocol";
import { GUIDE_ARTIFACT, writeGuide } from "./guide";
import { DEFAULT_SENSITIVE, SENSITIVE_SHOWN, sensitiveOf, tierOf } from "./policy";
import { AUTO_PROFILES, profileOf } from "./profiles";
import { classify, reasonsOf, scripted, stateOf, type ChangedFile, type Scored } from "./risk";
import type { BranchReviewOut, Launched } from "./store";

type Stub = DurableObjectStub<MonorepoObject>;

/** Who pushed the head: the reviewer agents act as them. */
export interface Pusher {
  login: string;
  name: string | null;
  email: string | null;
  /** The agent (X-Pando-Agent) or the cloud session's machine that pushed; null for a person. */
  agent: string | null;
  machine: string | null;
}

export interface ReviewJob {
  repo: string;
  branch: string;
  head: string;
  pusher: Pusher | null;
}

/** The pusher as the job keeps it. */
export function pusherOf(i: Identity | null): Pusher | null {
  if (!i) return null;
  const agent = i.agent ?? (i.credential_kind === "sandbox" ? `cloud agent ${i.credential_name}` : null);

  return { login: i.login, name: i.name, email: i.email, agent, machine: i.credential_name };
}

/** Files read for the state: at most this many, in path order; the rest are counted. */
const FILES_READ = 1_000;

/** Patches read, in bytes: enough for the state's hunk starts and the guide's diff. */
const PATCH_BYTES = 2 << 20;

interface Change {
  commits: string[];
  diff: DiffResult;
}

/** The branch's own commits (newest first, their messages) and its diff against the merge base with main. */
async function readChange(env: Env, r: RepoRecord, main: string, head: string): Promise<Change> {
  return withRepo(env, r.artifacts_name, async (repo) => {
    const read = commitReader(repo);
    const c = await compareWith(read, main, head);

    if (!c.mergeBase) throw new HttpError(409, "no_merge_base", "the branch shares no history with main");
    const [from, to] = await Promise.all([read(c.mergeBase), read(head)]);
    const commits = await Promise.all(c.aheadCommits.slice(0, 50).map(async (sha) => (await read(sha)).message ?? ""));
    const diff = await treeDiff(repo, from.tree, to.tree, { hunks: true, maxBytes: PATCH_BYTES, paths: [], maxFiles: FILES_READ });

    return { commits, diff };
  });
}

const changedOf = (d: DiffResult): ChangedFile[] =>
  d.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary, hunks: (f.hunks ?? []).map((h) => h.lines) }));

/** "a person, ramos" or "an agent (claude-code on ramos-mac), for ramos". */
function authorOf(p: Pusher | null, creator: string | null): string {
  if (!p) return `unknown (the branch was made by ${creator ?? "someone"})`;

  return p.agent ? `an agent (${p.agent}${p.machine ? ` on ${p.machine}` : ""}), acting for ${p.login}` : `a person, ${p.login}${p.machine ? ` on ${p.machine}` : ""}`;
}

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message);
}

/** The change read, or why it could not be. */
type Read = { ok: true; change: Change } | { ok: false; why: string };

async function readSafely(env: Env, r: RepoRecord, main: string | null, head: string): Promise<Read> {
  if (!main) return { ok: false, why: "main does not exist yet" };

  try {
    return { ok: true, change: await readChange(env, r, main, head) };
  } catch (err) {
    return { ok: false, why: `the change could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One head: score it, decide its tier, start its reviewers and its guide. Never throws for clef or the agents: those are recorded. */
export async function runReview(env: Env, stub: Stub, r: RepoRecord, info: ObjectInfo, m: ReviewJob): Promise<void> {
  const job = await stub.reviewJob(m.repo, m.branch, m.head);

  if (!job) return; // off, or scored already
  const [main, branch, patterns] = await Promise.all([stub.currentMain(m.repo), stub.branchRecord(m.repo, m.branch), sensitivePatterns(env, info, r, DEFAULT_SENSITIVE)]);
  const read = await readSafely(env, r, main, m.head);
  let scored: Scored = read.ok ? { ok: false, why: "not scored" } : read;
  let hits: string[] = [];
  let reasons: string[] = [];

  if (read.ok) {
    const { diff, commits } = read.change;
    const files = changedOf(diff);
    hits = sensitiveOf(files.map((f) => f.path), patterns);

    const state = stateOf({
      repo: r.name, branch: m.branch, title: branch?.title ?? null, description: branch?.description ?? null, author: authorOf(m.pusher, branch?.creator ?? null),
      commits, files, files_total: diff.files_total, sensitive_patterns: patterns, sensitive_hits: hits,
    });

    const test = job.test;

    if (test && test.fail > 0) scored = { ok: false, why: "clef failed (the test switch)" };
    else if (test && test.score !== null) scored = { ok: true, c: scripted(test.score, state.length) };
    else scored = await classify(env, state);

    const facts = { sensitive_hits: hits, files_total: diff.files_total, additions: diff.stats.additions, deletions: diff.stats.deletions, deleted_files: files.filter((f) => f.status === "deleted").length };
    reasons = reasonsOf(scored.ok ? scored.c : null, facts);
  }

  const c = scored.ok ? scored.c : null;
  const error = scored.ok ? null : scored.why;
  const tier = tierOf(c?.score ?? null, hits.length, job.settings);

  if (error) reasons = [`Risk unknown: ${error}`, ...reasons].slice(0, 6);
  console.log(JSON.stringify({ msg: "pando.risk", repo: m.repo, branch: m.branch, head: m.head, tier, score: c?.score ?? null, tokens: c?.tokens ?? null, cost_usd: c?.cost_usd ?? null, ms: c?.ms ?? null, error }));

  const first = await stub.reviewClassified(m.repo, m.branch, m.head, {
    patterns,
    score: c?.score ?? null, tier, reasons, sensitive: hits.slice(0, SENSITIVE_SHOWN),
    answers: c ? { levels: c.levels, path: c.path, sensitive: c.sensitive, destructive: c.destructive, ms: c.ms } : null,
    model: c?.model ?? null, tokens: c?.tokens ?? null, cost_usd: c?.cost_usd ?? null, error,
  });

  if (!first || tier === "auto") return;

  if (tier === "human") await stub.reviewGuideQueue(m.repo, m.branch, m.head);
  await launchReviewers(env, stub, r, info, m, branch?.creator ?? null, job.test);
}

/** The ai and human tiers' reviewer agents, one review session per profile, in parallel; recorded even when a launch fails. */
async function launchReviewers(env: Env, stub: Stub, r: RepoRecord, info: ObjectInfo, m: ReviewJob, creator: string | null, test: { model: string | null; script: string | null } | null): Promise<void> {
  const login = m.pusher?.login ?? creator;

  if (!login) {
    await stub.reviewReviewers(m.repo, m.branch, m.head, AUTO_PROFILES.map((profile) => ({ profile, session: null })));

    return;
  }

  const launcher = { env, stub, info: { id: info.id, full_name: info.label, kind: info.kind }, identity: { login, name: m.pusher?.name ?? null, email: m.pusher?.email ?? null } };

  const launched: Launched[] = await Promise.all(
    AUTO_PROFILES.map(async (name): Promise<Launched> => {
      try {
        const s = await launchAs(launcher, {
          kind: "review", repo: r.name, branch: m.branch, issue: null, model: test?.model ?? DEFAULT_MODEL,
          prompt: reviewPrompt(info.label, r.name, m.branch, test?.script ?? null, profileOf(name)),
        });

        return { profile: name, session: s.number };
      } catch (err) {
        console.warn(`reviewer ${name} on ${m.repo}/${m.branch}: not launched: ${err instanceof Error ? err.message : String(err)}`);

        return { profile: name, session: null };
      }
    }),
  );

  await stub.reviewReviewers(m.repo, m.branch, m.head, launched);
}

/** Pando, as the guided review's uploader. */
const PANDO: Identity = { login: "pando", name: "Pando", email: null, credential_id: "pando", credential_name: "pando", credential_kind: "pando", role: "owner", agent: null };

const pagePath = (full: string, r: RepoRecord, branch: string) => `/${full}${r.path === "." ? "" : `/projects/${r.path.replace(/^projects\//, "")}`}/branches/${branch}`;

/** The guided review of a human-tier head, kept as the branch's artifact guided-review.html. */
export async function runGuide(env: Env, stub: Stub, r: RepoRecord, info: ObjectInfo, m: { repo: string; branch: string; head: string }): Promise<void> {
  if ((await stub.reviewGuideState(m.repo, m.branch, m.head)) !== "writing") return;
  const set = (state: BranchReviewOut["guide_state"], guide: BranchReviewOut["guide"], error: string | null) => stub.reviewSetGuide(m.repo, m.branch, m.head, state, guide, error);
  const [main, b] = await Promise.all([stub.currentMain(m.repo), stub.branchRecord(m.repo, m.branch)]);
  const read = await readSafely(env, r, main, m.head);

  if (!read.ok) {
    await set("failed", null, read.why);

    return;
  }

  const { diff, commits } = read.change;

  const out = await writeGuide(env, {
    url: `${(env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "")}${pagePath(info.label, r, m.branch)}`,
    repo: r.name, branch: m.branch, head: m.head, title: b?.title ?? null, description: b?.description ?? null, commits, patch: toPatch(diff, (f) => f.hunks).text,
    stats: diff.files.map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
  });

  console.log(JSON.stringify({ msg: "pando.guide", repo: m.repo, branch: m.branch, head: m.head, ok: out.ok, ms: out.ok ? out.ms : null, calls: out.ok ? out.calls : null, error: out.ok ? null : out.why }));

  if (!out.ok) {
    await set("failed", null, out.why);

    return;
  }

  try {
    const slot = unwrap(await stub.artifactSlot(r.name, m.branch, GUIDE_ARTIFACT));
    const prefix = `artifacts/${info.id}/${r.name}/${slot.id}/guide_${m.head.slice(0, 12)}/`;
    const bytes = new TextEncoder().encode(out.html);
    // SAFETY: TextEncoder's output is backed by a plain ArrayBuffer of exactly its bytes.
    const sha256 = await putBytes(env.BLOBS, prefix + GUIDE_ARTIFACT, bytes.buffer as ArrayBuffer, "text/html");

    const added = unwrap(await stub.artifactAddVersion(r.name, m.branch, {
      id: slot.id, branch_created_at: slot.branch_created_at, name: GUIDE_ARTIFACT, kind: "html", title: out.title,
      files: [{ path: GUIDE_ARTIFACT, size: bytes.byteLength, sha256, type: "text/html" }], prefix, machine: null, via: "cli",
    }, PANDO));

    await set("ready", { artifact: added.artifact.id, version: added.artifact.latest.n, title: out.title }, null);
  } catch (err) {
    await set("failed", null, `the guide could not be kept: ${err instanceof Error ? err.message : String(err)}`);
  }
}
