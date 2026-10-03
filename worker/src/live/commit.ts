// The meta layer object's way to write commits: gitwrite's commitChanges
// (docs/contracts/gitwrite.md, owned by the merge-engine lane).
//
// Until worker/src/gitwrite exports commitChanges, gitWriter() returns null and
// saved versions stay uncommitted (the object still keeps every version). When
// it lands, replace the body of gitWriter() with the commented lines.

// import { commitChanges } from "../gitwrite";

export interface GitPerson {
  name: string;
  email: string;
  date?: Date;
}

export interface FileChange {
  path: string;
  content?: string | Uint8Array;
  delete?: boolean;
  mode?: "100644" | "100755" | "120000";
}

export type CommitResult =
  | { status: "committed"; sha: string; tree: string }
  | { status: "unchanged"; sha: string }
  | { status: "ref_moved"; expected: string | null; actual: string | null };

export interface CommitOptions {
  parent: string | null;
  changes: FileChange[];
  message: string;
  author: GitPerson;
  committer?: GitPerson;
}

export interface GitWriter {
  commit(repoName: string, branch: string, opts: CommitOptions): Promise<CommitResult>;
}

export interface CommitEnv {
  ARTIFACTS?: unknown;
}

export function gitWriter(_env: CommitEnv): GitWriter | null {
  // if (!_env.ARTIFACTS) return null;
  // return {
  //   commit: (name, branch, opts) =>
  //     commitChanges({ artifacts: _env.ARTIFACTS, name }, branch, opts),
  // };
  return null;
}
