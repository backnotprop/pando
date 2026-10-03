# Pando code repo: agent notes

The meta layer's `AGENTS.md` (two folders up from `projects/pando`) holds the
rules for working here. This file adds the code repo's tooling.

# Lint

From `projects/pando`, after `npm install` once:

- `npm run lint` lints `worker/src`, `worker/test`, `web` and `packages`
  with oxlint and the vendored anti-slop plugin (`tools/oxlint/anti-slop`,
  config in `.oxlintrc.json`). Warnings fail it too.
- `npx oxlint --deny-warnings <files>` lints just the files you touched.

New TypeScript must lint clean. Existing files carry a baseline of findings;
do not add to it. Do not run `oxlint --fix` across the repo: the
`require-readable-spacing` fix touches nearly every file, and the
coordinator lands it as one commit. Do not disable or weaken a rule to pass.

# The API contract

`packages/contract` (`@pando/contract`, an npm workspace) holds Effect Schema
for the /v1 API. `web` imports it as `@pando/contract`. When you change a
response the contract covers, change its schema too, re-record
(`packages/contract/scripts/record.mjs`, against a local wrangler dev) and run
`npm run check -w @pando/contract` and `npm run typecheck -w @pando/contract`.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
