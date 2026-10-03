// The merge engine (docs/contracts/gitwrite.md), owned by the merge-engine
// lane in worker/src/gitwrite/. The merge endpoint and the branch list's
// `mergeable` field reach it only through this file.

import { GitWriteError, mergeCommit, type MergeOptions, type MergeResult } from "../gitwrite";

export type { MergeOptions, MergeResult as MergeOutcome };

export interface GitWrite {
  mergeCommit(
    repo: { artifacts: Artifacts; name: string; write?: { remote?: string; token: (fresh: boolean) => Promise<string> } },
    opts: MergeOptions,
  ): Promise<MergeResult>;
}

/** The `code` of a GitWriteError, or null for any other error. */
export function gitWriteCode(err: unknown): string | null {
  return err instanceof GitWriteError ? err.code : null;
}

export const gitwrite: GitWrite | null = { mergeCommit };
