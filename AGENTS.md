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

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
