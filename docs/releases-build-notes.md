# Releases lane: build notes

Running notes for the "releases" build lane (branch `releases`, worktree
projects/pando/worktrees/releases). The design: research/plans/releases-2026-10-04/
(REPORT.md, DESIGN.html, QUESTIONS.md, approved as recommended; cut B).

## Setup

- Dev server: `/Users/ramos/.cache/pando-releases/serve.sh` (port 8867,
  inspector 9367, state in /Users/ramos/.cache/pando-releases/state), started
  in the background; log in serve.log beside it. Stop it by its folder:
  `pkill -f "worktrees/releases/worker/node_modules"`.
- Port 8868 is the second server, if one is needed.

## Stages

1. Main's merge commit built at merge; "not built"; latest build of main on
   the project page. Tags recorded, listed, events, hook, frozen tag.
2. Releases: server, contract, CLI, notes generation.
3. Release files in R2; the per-project download switch.
4. Web: mocks first, then the build.
5. Deployments; pando-dev's commit on /healthz; deploy.sh change proposed;
   the release script and docs for Pando releasing Pando.
6. Docs and `pando help`; limits for the board.

## Log

- 2026-10-05: merged main (1126be9) into `releases` (206c47a).
