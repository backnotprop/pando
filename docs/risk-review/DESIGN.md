# Risk-based review: design (risk-review lane, 2026-10-13)

The owner: "Changes are classified by risk. Every merge or every branch has a
risk meter. As risk goes up, the need for human review is called, or any
review, even AI reviewers, which you can set thresholds against." And: reuse
the agent system Pando already has; reviewers are agents that do real code
review, on Cloudflare.

## The flow, per branch head

0. **Comments and docs only: auto by rule, no clef call** (policy.ts
   `commentsAndDocsOnly`). Every changed file is `.md`, `.mdx` or `.txt`,
   or a modified file of a known language whose changed lines are all
   comments (`//`, `#`, `/* */`, `<!-- -->` by file type) or blank. A new,
   deleted, renamed or binary code file, a shebang, an unknown file type, and
   a hunk that starts inside a comment it does not show are code. Sensitive
   paths count for code only, so a comment fix in `payments/` is auto. The
   owner: "low risk things like comments only never get flagged".
1. **A push to a branch that is not main** writes a `review` job to the
   monorepo object's facts outbox, in the same step as the push (the path the
   branch facts already take). One job per (repo, branch, head): a new head
   starts over, the same head again does nothing, nothing is cancelled.
2. **The drain (Worker side) classifies the head with clef**
   (`@cf/cloudflare/clef` through the AI binding): one call, the state and
   five questions below. It stores the score, level, tier, reasons, model,
   tokens and cost on the head's row.
3. **Policy (pure) turns the answers into a tier:** `auto`, `ai` or `human`.
4. **The tier runs:** `ai` launches the reviewer profiles as review sessions
   in pando-agents (the existing "Review with agent" launch, one session per
   profile, in parallel). `human` does the same and also writes the guided
   review, an artifact `guided-review.html` on the branch.
5. **The merge gate** (the merge route, so the MCP and agents' merge tools
   too) reads the head's row in the same object step as the checks.

## clef call

- `state`: the branch title and description, the author kind (person, or
  the agent and its machine), the commit messages, every changed file with
  `+added -removed`, the first 20 lines of each hunk, the repo's sensitive
  paths and which changed files match them.
- Cap: about 24,000 tokens, taken as 96,000 characters (4 per token); hunks
  are cut first, then the file list (at most 300 files named), then the
  commit messages (at most 50, 500 characters each). Why 24,000: a third of
  clef's 65,536-token window, and a ceiling of $0.0058 a call.
- `questions`: `risk` (score; levels low, medium, high with the owner's
  criteria), `review_path` (choice auto / ai / human, stored and shown, not
  the decider), `sensitive` (noul: touches auth, payments, secrets, infra,
  data), `destructive` (noul: deletes or rewrites more than it adds),
  `critical` (noul: changes who can do what, moves money, deletes stored
  data, handles secrets, changes a schema or migration, or the rules for
  merging or deploying). The risk question names those critical kinds so
  the model weighs them wherever they are (the owner: "critical types of
  functionality accurately get flagged").
- One call per head. Cost: input tokens x $0.24 per million; output free.
- clef fails, times out (20 s) or is rate limited: the row says
  `unknown`, the tier is `human`. Never `auto` on unknown. No retry: the next
  push classifies again.

## Policy (worker/src/review/policy.ts, pure, unit-tested)

- `score` = clef's probability-weighted level / 2 (0 to 1).
- `score < auto_below` (default 0.35): `auto`. Most weight on "low": docs,
  tests, small isolated changes.
- `score >= human_above` (default 0.70): `human`. Most weight on "high".
- Between: `ai`.
- `human_for_sensitive` (default on): a changed file under a sensitive path
  makes it `human`, whatever the score. Pando matches the paths itself
  (deterministic); clef's `sensitive` answer is a reason shown, not the rule.
- Sensitive paths: `[review] sensitive = [...]` in `.pando/pando.toml` on
  main (where `required_checks` lives); default `auth/`, `payments/`,
  `billing/`, `infra/`, `.github/`, `migrations/`, `.pando/`, `.env`,
  `secrets`. A pattern ending in `/` is a folder anywhere in the path; any
  other is a file name or the start of one.
- The level word follows the score band (low, medium, high), so "Medium,
  human review" can only come from a sensitive path, which the reasons say.

## Reviewer profiles (worker/src/review/profiles.ts)

Data, not code: `{ name, label, instructions }`. Defaults: `correctness`,
`security`, `tests`, `docs`. A session's prompt is `reviewPrompt()` plus the
profile's instructions. The `ai` and `human` tiers launch `correctness` and
`security` (two sessions per head: each is a container). "Review with
agent" gains an optional profile. Per-repo profile lists later. Each review
a session posts is stored with its session number, so the gate and the page
know which profile said what.

## The gate (worker/src/review/gate.ts, read by mergeNow)

- `auto`: green checks, as today.
- `ai`: passes when every launched reviewer posted a review on this head and
  none asked for changes. A launch that failed (agents unreachable) counts as
  not posted. Refused with 412 `review_required` and the reason.
- `human`: a person's `approve` on this head (a review not posted by an
  agent session). AI reviews are advice here.
- Any tier: a person's approval on this head passes it. An owner's force
  (`?force=1`, not from an agent session) passes it and is recorded as
  forced. Agents never force.
- No row yet (classifying): 412 `risk_pending` (shaped as checks_not_green, shown as a wait), retried by the agents'
  merge tool (2 s, 5 s, 10 s). A row missing for 60 s counts as `unknown`
  (`human`).

## State

In the monorepo object's SQLite, beside reviews, statuses and merges (not
D1): the gate runs inside the object, one merge at a time; reading its own
table in the same step has no race and no extra network hop. D1 holds
accounts only.

- `branch_reviews(repo, branch, head, score, level, tier, reasons,
  answers, model, tokens, cost_usd, error, sessions, guide, created_at,
  classified_at)`, key (repo, branch, head).
- `review_settings(repo, enabled, auto_below, human_above,
  human_for_sensitive)`; read by `GET .../repos/{r}`, changed by owners with
  `PATCH .../repos/{r}` `{review: {...}}`.
- `reviews` gains `session` (the agent session that posted it, or null).

The server's default for a repo with no setting is `RISK_REVIEW` ("on" or
off). Deployed: `--var RISK_REVIEW:on` in deploy.sh. Local servers: off, so
other lanes' suites make no clef calls and launch no sessions.

## Calibration: real clef on Pando's own history (2026-10-13)

`worker/test/risk-calibrate.mjs` scores real commits (some cut to the named
files) as a push would, through `/v1/_risk/score` (RISK_TEST only). Default
thresholds and sensitive paths. 9 clef calls, $0.0038 in all, $0.00042 a
call (1,113 to 3,069 tokens).

| Change | Commit | Files, lines | Rule or clef score | critical | Sensitive path | Tier | Expected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Comment fix (a test's note) | 96f8ca6 | 1, 8 | rule: comments and docs |  | no | auto | auto |
| Blank lines only (spacing) | 593d467 | 1, 2 | rule: comments and docs |  | no | auto | auto |
| Docs page (mac/README.md) | 69e1a44 | 1, 9 | rule: comments and docs |  | no | auto | auto |
| Copy change (landing page words) | 321a470 | 1, 2 | 0.05 | 0.01 | no | auto | auto |
| Test only (install.mjs retry) | 1850302 | 1, 13 | 0.20 | 0.02 | no | auto | auto |
| Web styling (artifacts tab on a phone) | 4263e95 | 1, 4 | 0.06 | 0.01 | no | auto | auto |
| Agents' merge tool retries a 503 | 0acf094 | 1, 24 | 0.40 | 0.29 | no | ai | ai |
| WorkOS sign-in (signin.ts as added) | b6f60e5 | 1, 40 | 0.90 | 0.97 | no | human | human |
| Sign-out page removed (logout route) | 1209fbf | 3, 25 | 0.71 | 0.75 | no | human | human |
| MCP OAuth server (oauth, consent, credentials) | 99e5057 | 4, 570 | 0.93 | 0.98 | no | human | human |
| Migration 0010 (MCP OAuth tables) | 99e5057 | 1, 48 | 0.95 | 0.98 | yes | human | human |
| Merge gate fails closed on a broken pando.toml | 86ea53e | 2, 47 | 0.71 | 0.91 | no | human | human |

Every case lands in its expected tier, and no critical change scored
under 0.70. Two critical ones sit just above it (the sign-out change and
the merge-gate change, both 0.71), so the margin is thin. **Proposed, not
built (the owner's call):** a functionality rule, `critical >= 0.8` makes
a head human whatever its score. It would hold the merge-gate change
(critical 0.91) with room, not the sign-out change (0.75), and it moves
none of the low or medium cases (their `critical` is 0.29 or less). The
other lever is `human_above` 0.65, which catches both but pulls more
medium changes to a person.

## Guided review (human tier)

One Workers AI call on the Worker (`@cf/zai-org/glm-5.3-flash`, the
agents' model), not a container session: a guide is one read of the diff.
Plannotator's own pieces from `@plannotator/core` 0.25.12: `GUIDE_REVIEW_PROMPT`,
`GUIDE_SCHEMA_JSON` and `buildGuideUserMessage` for the call;
`validateGuideOutput` (lenient) for coverage; one repair call ("fix the
structure, never the content") if nothing survives, then no guide (recorded,
never blocking); `buildGuideSnapshot` and `createGuideHtml` for one HTML
file, stored as the branch artifact `guided-review.html` by Pando. Guides
run from an outbox of their own (`guides_outbox`, the facts outbox's code
with another table), so branch facts never wait behind one. Measured: 24
to 75 s for one small branch, once over 120 s (the wait is now 180 s). The
branch page's "Guided review" panel opens it in the artifacts viewer
(Plannotator's HtmlViewer). There, page scripts do not run, so it shows the
export's own plain version (title, intent, chapters, each file with its
summary); downloaded, the file loads Plannotator's full viewer from
guides.show. No npm guide viewer exists (packages/guide-viewer is
unpublished). The guide says where the risk sits; it never rates it.

## On screen

- Branch page head: the meter, "Low · auto", "Medium · AI review",
  "High · human review required", "Risk unknown · human review"; the score;
  on hover the top reasons. Under it the reviewers (profile, state,
  verdict) and, on the human tier, Approve (members) and the guide.
- Branches list and the project page's open branches: the level as a badge.
- Settings: Risk-based review on or off, the two thresholds, the
  sensitive-path rule.

## Limits

| Limit | Number | Why |
| --- | --- | --- |
| clef state | 24,000 tokens (96,000 characters) | a third of the 65,536 window; $0.0058 a call at most |
| clef calls | 1 per branch head | a new head classifies again; nothing is retried |
| Lines per hunk sent | 20 | the start of each change; the cap stays for many files |
| Files named | 300 | past that the count and the sensitive matches only |
| Reviewer sessions | 2 per head on ai and human | each is a container; profiles are data, more later |
| Guide diff sent | 200,000 characters (about 50,000 tokens) | inside GLM-5.3 Flash's context with room for the answer; larger diffs get no guide |
| Guide wait | 180 s a call, up to 2 calls | measured 24 to 75 s; one call ran past 120 s |
| clef wait | 20 s | then unknown, human |

## Measured on the lane's server

- clef answers in 0.2 to 0.4 s; 700 to 3,100 input tokens a push here:
  $0.00017 to $0.00074 a classification. The e2e suite's three real calls
  cost $0.0007.
- The suite (agents/test/risk-review.mjs, 35 checks) runs every tier with
  real reviewer sessions on the scripted model in containers, real clef on
  the comment, copy, permission and payments branches, and the real guide.

## Considered, not needed for the 14th

- Cloudflare's Sandbox SDK coding-agent runner and the OpenCodeHarness (an
  experimental Durable Object running OpenCode): the same shape as
  pando-agents, which already runs review sessions in containers.
- A coordinator agent that merges the profiles' reviews into one (as
  Cloudflare's own reviewer does): the next step. For now the page lists
  each profile's review.
- Per-repo profile lists, re-classifying on demand, D1 for review state.
