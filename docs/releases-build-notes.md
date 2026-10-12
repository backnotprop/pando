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
- Stage 2 (c5aa821 server, 61c1ba4 cli): releases. POST makes a draft at
  main (or the tag's commit, or --target on main); published at once unless
  draft, after the gate (the merge gate's rule: combine() not success and not
  forced is 412 checks_not_green, before anything is made). Publishing makes
  the tag through the repo's write gate (updateRefsQueued) and records it;
  the door then refuses to move or delete it. Notes: releases/notes.ts walks
  the merges rows from the release's commit back to the first other
  published release's commit (no git reads); unit tests in units.test.ts.
- Stage 3: release files in R2 BLOBS at releases/<monorepo id>/<repo>/<release
  id>/<name>; SHA-256 computed on upload (DigestStream on a tee), the CLI
  sends its own and a mismatch is refused; 100,000,000 bytes and 20 files.
  The switch is repos.releases_public, set by PATCH .../repos/{r} (owners);
  the public download handler is registered before the members-only check
  and answers only GET .../releases/{tag}/files/{name}. pando release
  upload | download, and create <tag> <file>... (a draft, its files, then
  published). releases.mjs 87 of 87; contract 157 of 157.
- wrangler dev reads a request body before the Worker sees it, so the 413
  check sends 100,000,001 bytes; on Cloudflare the edge refuses past 100 MB
  itself (Free and Pro plans).
- A run killed outright left two repositories (rel-muw4t956); deleted by
  hand with a local credential. The suite now uses throwaways() (cleans up on
  Ctrl-C and kill).
- Stage 4: mocks at research/design/pando-ui-2026-10-03/releases/INDEX.html
  (built by _tools/build.mjs on the sessions mocks' base, rendered by
  _tools/shoot.mjs; Pando dark and light, 1440 and 390; no ../ paths). The
  strip reads "main passed · pando-ci #142 4 min ago   Latest release v0.3.0
  2 days ago": the branch page's words for states, not a ✓. The web shows
  releases; making, publishing and deleting stay CLI and API (asked in the
  INDEX). The web build waits for the owner's look.
- Stage 5 (295b886 server, c06dfca script): deployments (POST and GET
  .../deployments, members, the release found from the commit), /healthz
  names the commit through the version_metadata binding (VERSION): body
  still "ok" (the docs' Status page compares it), X-Pando-Commit, and JSON
  {ok, commit, version, deployed_at} on Accept: application/json; commit is
  the version's tag when it is a 40-hex sha, else null. tools/release.sh
  builds the four binaries on a Mac (darwin with cgo, linux with cgo off),
  writes SHA256SUMS, and runs pando release create <tag> <files> --target
  <sha> --generate. The binaries are about 22 MB each now (the report's 7.7
  MB was an older, smaller CLI); still far under 100 MB.

### Proposed deploy.sh change (pando-ops applies it)

In research/operational/gates/deploy.sh, the deploy line and two lines after
the smoke:

```
-cd worker && npx wrangler deploy > /tmp/pando-ops/deploy-$S.txt 2>&1; echo "deploy exit=$?"; grep -E 'Total Upload|Uploaded pando-dev|Current Version ID' /tmp/pando-ops/deploy-$S.txt
+SUBJ=$(git -C $M log -1 --format=%s $S | cut -c1-100)
+cd worker && npx wrangler deploy --tag $S --message "$SUBJ" > /tmp/pando-ops/deploy-$S.txt 2>&1; echo "deploy exit=$?"; grep -E 'Total Upload|Uploaded pando-dev|Current Version ID' /tmp/pando-ops/deploy-$S.txt
```

after the smoke:

```
+# which commit pando-dev runs now, and the deployment recorded on Pando (pando api signs as this machine: no secret here)
+printf "healthz: "; curl -s -H 'accept: application/json' $U/healthz; echo
+pando api /v1/monorepos/<owner>/<name>/repos/<projects-pando>/deployments -X POST -f environment=pando-dev -f sha=$S -f url=$U -f description=deploy.sh > /dev/null && echo "deployment recorded"
```

`<owner>/<name>/repos/<projects-pando>` is wherever Pando's own code is hosted
on pando-dev (the release script defaults to ramos/pando, projects/pando,
repo name projects-pando). The deployment's release is filled in by the
server when a published release sits at $S. The version_metadata binding
needs no new resource; the first deploy with this branch adds it.
- Stage 6 (6bccdd7): site/docs Releases page, Get started's install command
  (from ramos/pando projects/pando's latest release; works once v0.1.0 is
  published there and its switch is on), release limits, pando release in
  the CLI page, the changelog. New Buildkite hooks default to push and
  merged (pando ci pipeline add, the CI tab's Add pipeline); hooks made
  before keep push only (the docs say to add the pipeline again).
- Final run on 6bccdd7: releases.mjs 99/99, e2e.mjs 94/94, ci.mjs 112/112,
  hooks.mjs 22/22, vitest 107/107, contract 159/159, lint clean, docs check
  clean, web tsc clean. Dev server stopped.
- Waiting: the owner's look at research/design/pando-ui-2026-10-03/releases/
  INDEX.html, then the web build (Releases tab, release page, strip,
  Settings switch, Routes in packages/contract/src/routes.ts, a Playwright
  slice).
- Not built (after the cut, as decided): Cloudflare's own CI runner, "Deploy
  this release", CI uploading files with its token, the deployments strip,
  mirroring tags to GitHub (a gap for the mirror lane), `pando version`.
- 2026-10-12: stage 4, the web (owner: "the release mocks is probably approved
  as shown, let's go ahead and get it done and we can iterate from there").
  Branch at main 59ecd7f. Built as the mocks show, with the app's own parts:
  - Contract: routes.ts gets getRepoSummary, listReleases, getRelease,
    releaseFilePath and setReleasesPublic. Their answers were recorded in
    stages 1 to 3 (repo-summary*.json, releases.json, release.json,
    release-draft.json, release-with-file.json, repo-releases-public.json),
    so no new recording; contract check 159 of 159.
  - web/src/api/releases.ts (queries under the repo's key), the Releases tab
    (projects/<p>/releases and a plain repo's /releases; -project/Releases.tsx),
    a release's page (.../releases/<tag>: files with size, SHA-256 and
    Download, notes through the issue page's Markdown, which is Plannotator's
    viewer, its commit on main and the branch page's CheckRows, now exported
    and given a branch name and sha), the strip (-project/Strip.tsx, on the
    default branch's root folder only, read with the tree so the files do
    not move), the Settings switch (-settings/Releases.tsx, the Mirror
    section's Toggle), a Releases tab with its count on RepoHead, crumbs
    "Releases / v0.3.0" (a tag crumb in mono), TagIcon and DownloadIcon.
  - Live: the tab and the page follow release.created, updated, published
    and deleted on the page's row socket (live/rows.ts RELEASE_TOPICS), and
    poll every 5 s while it is down (the app's fallback). The strip is read
    on load, not live.
  - No Publish or Delete buttons (the mocks' INDEX): CLI and API only.
  - web/e2e/slice8.spec.ts: a project built by the Buildkite stand-in, a
    release with a file and a draft made through the API, the strip, the
    tab, the page, Download (bytes checked), the public URL refused, the
    switch turned on in Settings and the URL then answering without signing
    in (code still refused), a live publish, 390 px fit, a plain repo's
    empty tab and switch. PANDO_E2E_RELEASE_SHOTS=1 saves dark and light at
    1440 and 390 in web/e2e/shots/releases (gitignored).
  - Docs: releases.mdx "In the web app"; changelog 2026-10-12.
- Final run on fb83c56 (ports 8867, stand-in 8868, inspector 9367): web
  e2e 8 of 8 (slices 1 to 7 and slice 8), slice 8 again with shots;
  contract 159 of 159; npm run lint clean; web typecheck clean; docs check
  clean. The built pages, dark and light at 1440 and 390, are in
  research/design/pando-ui-2026-10-03/releases/built/ beside the mocks.
  Dev server stopped.
- Limits chosen in the web (for the board): the tab shows 30 releases a
  page, the server's page (Older loads more) and counts "30+" past the
  first page; a SHA-256 shows its first 12 characters (all 64 on hover);
  sizes are decimal (1 MB = 1,000,000 bytes), as the 100,000,000-byte limit
  is written; Settings reads each project's switch with one request per
  project (the repos list does not carry it), fine for tens of projects;
  the strip shows on the default branch's root folder only and is read on
  load, not live.
- Not built: Publish and Delete buttons (CLI and API only, as the mocks
  show); the strip live on new builds (a reload shows them).
