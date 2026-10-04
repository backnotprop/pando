// What the monorepo object hands the mirror drain, and what it gets back.

import type { ArtifactsRef } from "../monorepo/artifacts";

export type MirrorMode = "projects" | "whole";

/** A repo whose main is mirrored: a project, a plain repo, or the files outside projects/ (`meta`). */
export interface MirrorSource {
  repo: string;
  /** Its path in the repository: projects/<name>, "." for a plain repo, "" for the files outside projects/. */
  path: string;
  ref: ArtifactsRef;
  /** Its main's name (refs/heads/<branch>). */
  branch: string;
  meta: boolean;
}

/** {source repo: sha}: each source's main as last confirmed on GitHub. */
export type SentHeads = Record<string, string>;

/** One run for one GitHub repository: everything the drain needs, so it never calls back. */
export interface MirrorJob {
  monorepo: string;
  /** owner/name, for the first whole-repository commit's message. */
  label: string;
  target: string;
  mode: MirrorMode;
  installation: number;
  github: { id: number; full_name: string };
  sources: MirrorSource[];
  sent: SentHeads;
  /** Whole repository mode: the last commit Pando wrote on GitHub's main. */
  composed: string | null;
}

/** Why a run did not land: passing (tried again on the backoff) or one a person fixes (tried again on the next change, or Retry). */
export interface MirrorProblem {
  code: "retrying" | "no_access" | "not_found" | "refused";
  message: string;
  /** Seconds GitHub asked to wait, if it said. */
  retry_after_s: number | null;
}

export interface MirrorResult {
  ok: boolean;
  sent: SentHeads;
  composed: string | null;
  /** The commit now on GitHub's main (a Pando commit, or the composed one). */
  last_sha: string | null;
  problem: MirrorProblem | null;
  /** Receive-packs sent this run (0 when GitHub was already up to date). */
  pushes: number;
  ms: number;
}
