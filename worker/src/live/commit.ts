// The meta layer object's way to write commits: gitwrite's commitChanges
// (docs/contracts/gitwrite.md, owned by the merge-engine lane), on the meta
// layer's Artifacts repo `<monorepo>--meta`.
import { commitChanges, type Change, type CommitOptions, type CommitResult } from "../gitwrite";
import { timedArtifacts } from "../timing";
import { repoToken } from "../monorepo/artifacts";

export type { Change as FileChange };

export interface GitWriter {
  commit(repoName: string, branch: string, opts: CommitOptions): Promise<CommitResult>;
}

export interface CommitEnv {
  ARTIFACTS?: Artifacts;
  BLOBS?: R2Bucket;
  /** The monorepo object, which holds the repo's write token (absent in the live lane's test Worker). */
  MONOREPO?: DurableObjectNamespace<import("../monorepo/object").MonorepoObject>;
  // How meta layer saves become commits (meta-sync.md, "Commits after quiet"):
  // "author" (default): what is due together and shares an author, machine
  //   and agent is one commit;
  // "window": everything due is one commit; the last saver is its author and
  //   the others are Co-authored-by trailers (ARCHITECTURE C7, owner question 8).
  META_COMMIT_SHAPE?: string;
}

// gitWriter is null when the Worker has no Artifacts binding (a local test
// Worker without one): versions are then kept but not committed.
export function gitWriter(env: CommitEnv): GitWriter | null {
  const artifacts = env.ARTIFACTS;

  if (!artifacts) return null;

  return {
    commit: (name, branch, opts) =>
      commitChanges(
        {
          artifacts: timedArtifacts(artifacts),
          name,
          // The monorepo object's cached write token for this repo, when there is a monorepo object to ask.
          write: env.MONOREPO ? { token: (fresh) => repoToken(env as never, name, "write", "", "object", fresh) } : undefined,
        },
        branch,
        opts,
      ),
  };
}
