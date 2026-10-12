# Pando

A git platform for monorepos, built on Cloudflare Workers and Artifacts, for
many agents working at once.

Status: in development for Cloudflare's "Build the next-gen git platform"
competition (October 2026).

To use Pando, start with the docs: install `pando`, sign in, clone a monorepo,
and work on a branch (`site/docs/src/content/docs/get-started.mdx`, published
as the docs site's Get started page). To work on Pando itself, see Developing
below.

Licence: Apache 2.0 (`LICENSE`). Pando builds on and credits other open-source
work; see `REFERENCES.md`.

## Developing

### What you need

- Node 24 and npm; Go 1.26 for the CLI; git.
- A Cloudflare account with Artifacts, signed in with `npx wrangler login`.
  The Worker's Artifacts binding is remote even under `wrangler dev`, so local
  runs make real repos in the namespace named in `worker/wrangler.jsonc`.
  Every suite deletes what it makes.

### Install

```sh
npm install                # at projects/pando: lint tooling, effect, @pando/contract, web
(cd worker && npm ci)      # the Worker keeps its own install
npm run build -w web       # the Worker serves web/dist; wrangler dev will not start without it
```

Make `worker/.dev.vars` (gitignored) with values of your own. None of them is
a real secret; nothing outside your machine sees them.

```sh
PANDO_BOOTSTRAP=...                     # openssl rand -hex 24: makes test users
PANDO_STATUS_SECRET=...                 # openssl rand -hex 32: ci.mjs
BUILDKITE_API_TOKEN=...                 # any text: ci.mjs's local stand-in checks it
HOOK_RETRY_DELAYS=1,1,1,1               # hooks.mjs: retries in seconds
WORKOS_API_BASE=http://127.0.0.1:8799   # browser.mjs: its stand-in WorkOS
WORKOS_API_KEY=...                      # any text: browser.mjs checks the stand-in received one
```

### Checks with no server

```sh
npm run lint                              # oxlint and the anti-slop rules
npm run check -w @pando/contract          # recorded responses against the schemas
npm run typecheck -w @pando/contract
(cd worker && npx tsc --noEmit && npm test)   # types, then vitest
```

Root `npm run lint` is the lint every gate runs, and it stays at 0 findings.

### Suites against wrangler dev

Each suite in `worker/test/*.mjs` drives a running Worker through
`PANDO_URL`. Start one `wrangler dev` with its own state folder, run the
suites, then stop it:

```sh
cd worker
npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to /tmp/pando-a
npx wrangler dev --port 8797 --persist-to /tmp/pando-a > /tmp/pando-a.log 2>&1 &
PANDO_URL=http://localhost:8797 node test/e2e.mjs
```

| Suite | `wrangler dev` flags | Notes |
| --- | --- | --- |
| e2e, events, namespaces, gate, objectinfo, files, facts | none | |
| ci | none | Runs a stand-in Buildkite on a free port. |
| cli | none | Builds the cli and drives it (`pando api`, `ci build`, `monorepo rename`, ...); a stand-in Buildkite on a free port. |
| busy | `--var DOOR_TEST:1` | |
| hooks | `--var HOOKS_TEST:1` | Without it, the crash checks are skipped. |
| facts-outbox | `--var FACTS_TEST:1 --var FACTS_RETRY_MS:300,300` | |
| feed | `--var FEED_FANOUT_MAX:2 --var FEED_TICK_MS:500 --var FEED_TEST:1 --var FEED_RETRY_MS:200,400,600,800` | Set `PANDO_DEV_LOG` to the server's log file: the suite fails on errors logged there. |
| browser | none | Listens on 127.0.0.1:8799 itself; keep that port free. |
| feed-load | `--var FEED_TEST:1` | A measurement (`N=10` monorepos): it prints timings, not checks. |
| machines-load | none | A measurement, like feed-load. |

Each suite prints PASS or FAIL per check and exits non-zero on a failure.
These need a deployed Worker and the credential of a signed-in machine
instead: smoke, edge, login (a person confirms in a browser), burst and
replica-lag.

The meta layer has its own runner, which starts and stops its own server on
port 8850 (`PANDO_LIVE_PORT` to change it) and runs the Go tests in
`cli/internal/meta` against it:

```sh
worker/test/live/run-e2e.sh                # saves, catch-up, conflicts, history, large files
worker/test/live/run-e2e.sh --artifacts    # also the commits, on the namespace in test/live/wrangler.artifacts.jsonc
```

### CLI

```sh
cd cli && GIT_CONFIG_NOSYSTEM=1 go test ./...
cd cli && go build -o ~/.local/bin/pando ./cmd/pando   # install it
```

A worktree is a git clone by default, on every machine (the sparse driver,
`cli/internal/worktree/sparse.go`). The mount (ArtifactFS, `--kind fuse` or
`--kind fskit`) is the default only in Pando's cloud agents' containers
(`PANDO_AGENT_CONTAINER`, set in `agents/container/Dockerfile`). The FUSE
mount is tested only inside a privileged Linux container
(`cli/testbed/run.sh`, on Colima). Never mount FUSE on a Mac host.

`worker/test/clone.mjs` checks the clone end to end against `wrangler dev`
(every file on disk, few requests) and prints its times; `--from <repo>`
measures a real repo.

### Docs site

`site/docs` is the docs site, built with Cloudflare's nimbus (Astro). It keeps
its own install, like the Worker. The API reference is generated at build
from `docs/contracts/api-v1.yaml`, and the home's What's new reads the
newest changelog entry from the built `whats-new.json`.

```sh
cd site/docs && npm ci
npm run dev       # a local server with reload
npm run check     # build to dist/, then fail on any internal link that reaches no page
```

`PANDO_SF_FONTS=1` copies SF Pro Text in, as the web app's build does. The
site deploys as the assets-only Worker `pando-docs` (`npm run deploy`). The
app's `/docs` redirects to it: its address is `DOCS_URL` in
`worker/wrangler.jsonc`.

### Rules for local runs

- **One state folder per server.** Two `wrangler dev` servers on one
  `--persist-to` open the same Durable Object databases and fail at random
  (`SQLITE_BUSY`, `SQLITE_READONLY`).
- **Stop a server by its folder**, not by port or by name, since other
  servers may be running:
  `ps -axo pid,command | grep /tmp/pando-a`, then kill those processes.
- **Keep git away from the keychain.** On macOS, Apple's git stores
  credentials in the keychain on its own. The suites run git with a temporary
  `HOME`, `GIT_CONFIG_NOSYSTEM=1` and an empty `credential.helper` before
  their own. Do the same for any git you point at a local Pando.
- **Ports:** any free ones; every suite takes `PANDO_URL`. Port 8799 belongs
  to the browser suite's stand-in WorkOS.
