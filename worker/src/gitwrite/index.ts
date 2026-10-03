// Server-side git writes without a clone. The contract is
// docs/contracts/gitwrite.md.
export { mergeCommit, mergeBases, type MergeOptions, type MergeResult } from "./merge";
export { commitChanges, type Change, type CommitOptions, type CommitResult } from "./commit";
export { GitWriteError, type GitRepo, type GitWriteErrorCode, type Stats } from "./repo";
export type { Signature as Person } from "./objects";
