# gitwrite test harness

Tests `mergeCommit` and `commitChanges` against real Artifacts and checks
the results with the real git client. There are no git mocks.

```sh
cd worker
npm install --no-save wrangler typescript @cloudflare/workers-types   # until package.json lists them
node src/gitwrite/harness/run.mjs
```

`run.mjs`:

1. starts `index.ts` under `wrangler dev` on port 8799, with the Artifacts
   binding on the remote `pando-spike` namespace (your `wrangler login`);
2. makes `gw-test-*` repos, pushes a base, branches and moves main with
   `git push`;
3. calls `mergeCommit` and `commitChanges` through the harness;
4. clones with `git` and checks parents, trees (against `git merge`'s own
   result), modes, contents and `git fsck --full --strict`;
5. deletes every repo it made, pass or fail.

The harness Worker is never deployed. It only accepts repo names that start
with `gw-test-`. Write tokens stay in memory and in the git child process
environment; nothing prints them.

Set `GW_HARNESS_URL=http://localhost:8799` to reuse a harness you started
yourself with `npx wrangler dev -c src/gitwrite/harness/wrangler.jsonc --port 8799`.
