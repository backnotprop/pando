# Contracts between lanes

Each contract has one owner. Others read it and ask the owner (through
pando-ops) for changes.

| Contract | File | Owner |
| --- | --- | --- |
| The /v1 API (OpenAPI) | `api-v1.yaml` | server-git |
| Server-side git writes | `gitwrite.md` | merge-engine |
| Meta layer sync over WebSocket | `meta-sync.md` | live |
| `.pando/pando.toml`, reference and large-file pointers | `formats.md` | cli |
| The Mac mount wire, version 3 | in the fork: `projects/artifact-fs`, `docs/pando-fskit-wire-v3.md` | fskit |

Shared files: `worker/src/index.ts` and `worker/wrangler.jsonc` belong to
server-git; `cli/cmd/pando/main.go` belongs to cli. Other lanes expose a
package or module and ask for the wiring in their report.
