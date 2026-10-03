// The meta layer object's way to write commits: gitwrite's commitChanges
// (docs/contracts/gitwrite.md, owned by the merge-engine lane), on the meta
// layer's Artifacts repo `<monorepo>--meta`.
import { commitChanges, type Change, type CommitOptions, type CommitResult } from "../gitwrite";

export type { Change as FileChange };

export interface GitWriter {
  commit(repoName: string, branch: string, opts: CommitOptions): Promise<CommitResult>;
}

export interface CommitEnv {
  ARTIFACTS?: Artifacts;
}

// gitWriter is null when the Worker has no Artifacts binding (a local test
// Worker without one): versions are then kept but not committed.
export function gitWriter(env: CommitEnv): GitWriter | null {
  const artifacts = env.ARTIFACTS;
  if (!artifacts) return null;
  return {
    commit: (name, branch, opts) => commitChanges({ artifacts, name }, branch, opts),
  };
}
