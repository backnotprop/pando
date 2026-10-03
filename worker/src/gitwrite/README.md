Server-side git writes (merge commits for code repos, commits for meta layer
saves), owned by the merge-engine lane. Its interface is in
docs/contracts/gitwrite.md.

- `index.ts`: what callers import.
- `merge.ts`: `mergeCommit`, the merge base walk and the tree-level merge.
- `commit.ts`: `commitChanges`.
- `objects.ts`, `pack.ts`: git objects and a PACK v2, built in the Worker.
- `repo.ts`: reads through the Artifacts binding, the push to receive-pack.
- `harness/`: a test Worker run under `wrangler dev` against the real
  `pando-spike` namespace, and `run.mjs`, which checks the results with the
  real git client. See `harness/README.md`.
