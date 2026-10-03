// The merge engine, as docs/contracts/gitwrite.md describes it. The
// merge-engine lane owns worker/src/gitwrite/. Until that module is wired in
// here, `gitwrite` is null: the merge endpoint answers 501 and the branch
// list reports `mergeable: unknown`.
//
// To wire it: replace the last line with
//   import * as engine from "../gitwrite";
//   export const gitwrite: GitWrite | null = engine;

export interface GitPerson {
  name: string;
  email: string;
  date?: Date;
}

export interface GitWriteRepo {
  artifacts: Artifacts;
  name: string;
}

export interface MergeOptions {
  base: string;
  head: string;
  baseSha?: string;
  message: string;
  author: GitPerson;
  committer?: GitPerson;
  dryRun?: boolean;
}

export type MergeOutcome =
  | { status: "merged"; sha: string; tree: string; old: string; mergeBase: string }
  | { status: "mergeable"; tree: string; old: string; mergeBase: string }
  | { status: "up_to_date"; sha: string }
  | { status: "conflict"; paths: string[]; mergeBase: string }
  | { status: "ref_moved"; expected: string; actual: string | null };

export interface GitWrite {
  mergeCommit(repo: GitWriteRepo, opts: MergeOptions): Promise<MergeOutcome>;
}

/** The `code` of a GitWriteError, or null for any other error. */
export function gitWriteCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err && (err as { name?: string }).name === "GitWriteError") {
    return String((err as { code: unknown }).code);
  }
  return null;
}

export const gitwrite: GitWrite | null = null;
