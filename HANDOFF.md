# Handoff: Pando, to the `pando-ops` session

Date: 2026-10-02. From: the Workspaces overseer (`workspaces-ops`). To: `pando-ops`, the lead coordinator for Pando from now on. The owner's words: "hand off this whole thing to pando-ops, get it in the lead coordinator position, get it all caught up to speed."

## What Pando is, in the owner's words

"Our project is one big monorepo, but it exists only on my Mac. Agents are moving to the cloud; other machines and other teams should work off the same codebase. This codebase is different: a huge monorepo of context, decisions, research, prototypes and code for agents. I want to build the next GitHub platform, based on supporting monorepos. One monorepo per project. I want the file system as if it were live syncing: update a decision file and it updates on someone else's laptop in real time (Markdown especially; code may have different rules). A smart mount where the repo appears almost instantly because nothing is downloaded up front. Protected main that is never overwritten and needs a review. CI through webhooks out to Blacksmith or Depot; we will not run actions ourselves. An agent works on a branch, pushes; you review a pull request or the branch itself; you accept with Merge on either. I don't want to over-engineer; a hackathon-grade MVP, real, performant, on Cloudflare." Later: "the meta layer auto-updates; only protected repos/code go through a process"; "I don't want the whole macFUSE friction"; "need a way to look at a branch's changes before merging, and diff commands and APIs so even AI agents can review"; "we could adopt the Plannotator UI for review."

## The occasion

Cloudflare's "Build the next-gen git platform" competition on Artifacts (open beta). Submit by October 14, 2026, 11:59 PM PDT: a 5 to 10 minute video, a public open-source repository (MIT, Apache 2.0 or BSD), run instructions. Entrants must be US or Canada residents; the winner must be in San Francisco on October 21. Local copies of the page, the pricing page and the terms PDF are in the research folder below.

## Where everything is

- Research folder (meta layer, not a git repo): `/Users/ramos/workspaces/research/plans/pando-2026-10-02/`
  - `PROPOSAL.md` (round 1: the problem, three architecture shapes, the mount, branching, the MVP, risks, eight questions)
  - `PROPOSAL-round-2.md` (what Oak is, the two-tier rule, the diff API and the review surface, nine questions)
  - `PROPOSAL-round-3.md` (the Mac mount decided with evidence, the build spike, hooks, diffs, the worktrees model, section 1a after the DriveLikeApp read, seven questions)
  - `DRIVELIKEAPP-READ-2026-10-02.md` (an installed drive-like Mac app read from its bundle: FSKit plus a loopback SMB fallback; the product is not named, by the owner's wish)
  - the saved competition page, pricing page, terms PDF and the Oak docs pages
- The public build repository: `/Users/ramos/pando` (git, `main`, two commits: README and ignore file; `REFERENCES.md` with licences; `spikes/oakfs/` the Oak macOS mount app and FSKit extension built under Pando names, Apache 2.0 with notices; the 250 MB of build output is ignored). No licence file yet (a question for the owner). No GitHub remote yet: creating the public repo is the owner's call.
- The owner's rounds: he answered none of the questions in rounds 1 and 2 on purpose ("avoiding answering for now to enable more research") and left notes, all folded into the next round. Round 3 is the one he will answer; it is to be reopened by you (last step below).
- The running log: `/Users/ramos/workspaces/research/operational/deviations/DEVIATIONS-2026-10.md`; rows 4464 to 4473 are Pando (OWNER ASK, OWNER LOOK, FINDING, SPEC). The header lists the six columns and the closed kinds.
- The board: `/Users/ramos/workspaces/backlog/active-checklist.md`, the Pando lines dated 2026-10-02.

## What is settled by research (do not re-ask)

- Oak (oak.space) is its own VCS, not git; client, core and macOS mount app are Apache 2.0; its server is closed and it stores on its own backend, not Artifacts. We take its approach (lazy mount: manifest first, hydrate on open, a local edit layer, push uploads) and its four rules (no direct push to main, CI must pass to merge, squash-only, permission changes through a branch), with credit.
- ArtifactFS (Cloudflare, Apache 2.0) is the lazy git mount engine; on Linux it works as is; on a Mac it needs macFUSE's kernel extension, which the owner refuses. macFUSE and FUSE-T have licence terms that rule them out of a public repo anyway.
- The Mac mount is an FSKit app extension of our own, forked from Oak's (`spikes/oakfs/`), macOS 26 minimum, needing the `com.apple.developer.fskit.fsmodule` entitlement through the owner's paid Apple Developer account (an ordinary capability, no approval wait; the round 2 claim that Apple grants it on request was withdrawn in round 3). The spike builds on this Mac; signing stops only on two missing provisioning profiles. This Mac holds a Developer ID Application identity for the owner's team.
- Fallbacks for a Mac without the extension: a sparse checkout (pick folders, downloaded whole; no install) and a loopback SMB mount (lazy, no install, share-like); the engine lives in the daemon with FSKit and SMB as two thin faces on it. Round 3 question 7 asks which.
- The two tiers: the meta layer (Markdown, decisions, research, boards) updates live everywhere with no process; protected code repos follow Oak's four rules; the line is declared per repo in a protected file.
- Judges: the floor needs no Mac mount (Linux mount in a container or cloud sandbox, the Mac sparse client, the video); the stretch is a signed, notarized download with one System Settings switch.
- Artifacts caps a repo at 1 GB and a file at 32 MB: one repo per project plus a live meta repo, not one repo for everything.
- Review: branch diffs served as patch, JSON and per-file hunks so an agent reviews by API; Plannotator (`plannotator review --patch-file`) as the human surface; webhooks out with a status API CI services post back to.

## What only the owner can do

- Answer round 3 (seven questions).
- Choose the licence (Apache 2.0 is the natural match) and create the public GitHub repository.
- In his Apple developer account: two App IDs with the FSKit Module capability, two provisioning profiles, a notarization key; sign Xcode into his Apple ID; later switch PandoFS on in System Settings. No agent ever sees a key or touches System Settings.

## Rules that carry over (from `/Users/ramos/workspaces/AGENTS.md`; read it once)

- Plain writing, no em dashes, no effort in days; concrete names over umbrella words.
- Do not over-engineer; propose the smaller launch-shaped version and say so.
- Secrets never pass through a session or an agent; the owner types them himself. Never print a key, a token, a provisioning profile or a `.env`.
- Worktrees: one branch, one worktree, one agent; the integration checkout is never edited by an agent; the coordinator merges.
- Every agent launched is Opus 5.5 (owner ruling 2026-09-23), Sonnet for searches.
- Limits a person can hit are owner items, never invented.
- A document the owner must answer opens in Plannotator Annotate with `--gate --json`, run in the background, one session at a time, in the `:::question` block format (`~/.claude/skills/plannotator/SKILL.md`, "Asking the reviewer questions"); about eight questions a round; when he skips with "I don't understand", re-present with a concrete story next round.
- Deliverables for his look are files on disk opened with `open` or `code`, never published artifacts.
- Log rulings and deviations as they happen in the monthly log, one row per PR landing and one per ruling, with a kind from the closed list; read `date -u` before every stamp; read the last numeric row immediately before appending.
- The owner's style: terse, speech-to-text, plain questions; answer plainly first, own mistakes plainly, ask decisions short.

## The last step of this handoff

Close any Plannotator session the overseer left open on round 3, then reopen `PROPOSAL-round-3.md` yourself with the gate and JSON output so the owner's answers reach you; he takes over there.
