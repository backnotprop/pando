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
- Stage 1 (server and contract): the merged hook builds main's merge commit
  on main (hooks.ts buildTarget; its status token and PANDO_HEAD, PANDO_BRANCH,
  PANDO_STATUS_URL are for the merge commit). "Not built": checks.ts
  buildState(), used only by GET .../repos/{r}/summary; combine() is
  unchanged, so the merge gate still reads a commit with no statuses and no
  required checks as success (a repo with no CI merges as before). Tags:
  recorded by the door (door.ts peelTags: one info/refs read per push with
  tags, annotated tags peeled from the `^{}` lines), listed (GET tags),
  tag.created and tag.deleted on the stream, hook event `tag` (web hooks
  default to all four events now). The freeze rule is in checkPush
  (releases/store.ts frozenRefusals); it bites once releases exist (stage 2).
  Tests: worker/test/releases.mjs 23 of 23; hooks.mjs 22 of 22; ci.mjs 112 of
  112; contract 149 of 149. The project page strip waits for stage 4's mocks.
- Gap for the mirror lane: tags are not mirrored to GitHub (mirror SPEC 2.4
  mirrors main only).
- Gap: a tag push whose record fails is not kept for the reconcile
  (markUnrecorded keeps branches only); the tag stays in Artifacts and
  GET tags does not show it until it is pushed again or a release names it.
