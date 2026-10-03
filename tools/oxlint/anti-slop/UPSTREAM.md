# anti-slop (vendored Oxlint plugins)

Vendored code. This repository owns these rules and their configuration
(`.oxlintrc.json` at the repo root). Update with the `install-anti-slop`
skill's update procedure (`references/update.md`), never by replacing the
folder.

## Source

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a` (2026-09-10, "feat(effect):
  prefer Match for literal branches"), the newest commit touching
  `skills/install-anti-slop/` when the skill was last refreshed (2026-09-24).
- Upstream path: `skills/install-anti-slop/assets/anti-slop/`.
- How it was copied: the skill's own installer, fresh install, 2026-10-03:
  `node ~/.claude/skills/install-anti-slop/scripts/install.mjs` from
  `projects/pando`, which wrote `tools/oxlint/anti-slop/`.

## Verification of the copied bytes

Git tree hashes, computed locally with `git write-tree` (`.DS_Store` excluded):

| What | Tree hash |
| --- | --- |
| The installed skill folder (`~/.agents/skills/install-anti-slop`) | `89044d21c75a367eac1ddbaf208e650b1a7d5820` |
| `skills/install-anti-slop` in upstream at `e6676e8` (GitHub contents API) | `89044d21c75a367eac1ddbaf208e650b1a7d5820` |
| The skill's `assets/anti-slop` | `a7831feb0c097943ac813ddcb1367e26eef52da5` |
| This folder as installed, before this file was added | `a7831feb0c097943ac813ddcb1367e26eef52da5` |

So this folder is byte-identical to upstream `e6676e8` at
`skills/install-anti-slop/assets/anti-slop/`, apart from this `UPSTREAM.md`.
That upstream commit is the base for a future three-way update.

## Installed paths

- `index.ts`: the generic plugin, registered as `anti-slop`.
- `effect/index.ts`: the Effect plugin, registered as `anti-slop-effect`
  (the repo depends on `effect` 4.0.0 directly).
- `rules/`, `shared/`, `effect/rules/`, `effect/shared/`: the rules and helpers.
- `vendor/eslint-stylistic/`: the vendored ESLint Stylistic rule behind
  `require-readable-spacing`, with its own `LICENSE` (MIT) and `UPSTREAM.md`,
  kept verbatim.

## Dependencies

At the repo root, pinned exactly, as devDependencies: `oxlint` 1.86.0 and
`@oxlint/plugins` 1.86.0 (move them together).

## Local deviations

None in the plugin source. Configuration choices (in `.oxlintrc.json`):

- every generic rule and every Effect rule at `error`, plus the native
  companion `oxc/no-accumulating-spread`;
- Oxlint's default `correctness` category left at its default (`warn`), and
  `npm run lint` passes `--deny-warnings`, so warnings also fail;
- ignores: the agent folders listed by the skill, this folder,
  `node_modules`, `dist`, `.wrangler`, `spikes/`, and generated files
  (`worker/worker-configuration.d.ts`, `*.gen.ts`).

Upstream tests (`*.test.ts`) are not part of the skill bundle, so none are
vendored here.
