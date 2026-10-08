# The living leaf: notes (lane "leaf", branch leaf)

The owner, 2026-10-07, after seeing a character rebuilt in real-time 3D for
another project: "pando's leaf needs a similar upgrade." This lane rebuilds the
Quaking leaf (the mark of the assistant and of Cloudflare-run agents) in
three.js, keeps the 16 px pixel leaf for small sizes, and brings it into the
product where it is big enough to matter.

## Where things are

| Path | What it is |
|---|---|
| `web/src/ui/leaf3d/motion.ts` | Easings, bumps, blinks, settles. Pure functions of time. |
| `web/src/ui/leaf3d/pose.ts` | The acting: a pose (a flat set of numbers) per moment for each state, the blend between states, the one-colour poses. |
| `web/src/ui/leaf3d/rig.ts` | The body, face, lights and contact shadow in three.js. The blade flexes in its vertex shader; the face follows the same flex on the CPU. |
| `web/src/ui/leaf3d/stage.ts` | One shared WebGL renderer for every leaf on a page. |
| `research/design/pando-ui-2026-10-03/assistant-icon/living/` | The preview for the owner: `INDEX.html`, `render.html`, `renders/`, and `_src/` (the bundle build, capture, perf and shot scripts). |

## Decisions

- **three.js 0.186.1, MIT, as an npm dependency of web** (not a vendored
  script). Vite bundles it with the leaf code into its own chunk that loads
  after the page, the first time a leaf of 24 px or more appears; the pixel
  leaf shows until it is ready. A vendored script would be the same bytes
  without tree-shaking, versioning or types (`@types/three` 0.186.0, dev).
  The preview bundles the same source files (`living/_src/build.mjs`, the
  worktree's rolldown) into one classic script so it opens from disk.
- **One renderer, tiles, 2D canvases.** Each leaf is its own small `<canvas>`
  (2D) in the page, so it sits in the layout like the SVG did (popovers and
  dialogs cover it as usual). Every frame the stage draws the leaves that are
  on screen into tiles of one hidden WebGL canvas, then copies each tile into
  its leaf's canvas. One WebGL context however many leaves (browsers allow
  about 16 a page). An IntersectionObserver skips leaves off screen; nothing
  runs while the tab is hidden; still leaves (reduced motion, the stopped and
  failed tones) are drawn once. On a lost WebGL context the stage tells the
  leaves, which go back to the pixels.
- **Deterministic time.** Every pose is a function of the state's own time.
  Loops repeat exactly; any frame can be drawn in any order (the renders and
  the scrubber rely on it). A page of leaves starts each at its own offset so
  they do not move in step.
- **Done plays its flourish once**, when an agent becomes done while the leaf
  is on screen; a leaf that mounts already done starts in the satisfied loop.
- **Optical sizing.** Under 64 px the leaf is framed tight like the pixels,
  straight on, with its moves through space scaled down; the eyes are drawn
  1.2 times larger at 32 to 63 px and 1.4 times at 24 to 28 px, the badge a
  little larger too, so they read.
- **Tones.** One colour (the product's `--ash` or `--rust`), eyes as holes
  (they write a clear pixel), held still: stopped dozes, failed droops.

## Sizes in the product today (before integration)

| Place | File | Size now |
|---|---|---|
| Floating assistant button | `-agents/Assistant.tsx` | 28 (in a 56 px circle) |
| Chat panel header | `-agents/Assistant.tsx` | 28 |
| Chats list rows | `-agents/Assistant.tsx` | 16 |
| Agents tab rows | `-agents/List.tsx` | 16 (default) |
| Agents tab empty state | `-agents/List.tsx` | 32 |
| Agent page header | `-agents/Session.tsx` | 32 |
| Issue's Agents block | `-agents/IssueAgents.tsx` | 16 |
| Review with agent | `-agents/ReviewAgent.tsx` | 14, 16 |
| Address with agent dialog | `-agents/Dialog.tsx` | 20 |
| Issue page | `-issues/Issue.tsx` | 16 |
| Conversation, Thread | `conversation/` | 12 |

Integrated after the owner's approval ("cool, approved", 2026-10-07): the
floating button is 40, the Agents tab's empty state 160 (the hero, with its
contact shadow); the chat header (28) and the agent page header (32) draw
living without a change. Everything at 20 and below stays pixels.

`Leaf` (web/src/ui/Leaf.tsx) keeps its props. At 24 px and up, when the
browser can draw WebGL, it shows a canvas the page's one stage draws into,
with the pixel leaf in its place until the first frame; the stage's chunk is
imported only then. A lost WebGL context sends every leaf back to its
pixels. A tone's colour is read from the theme's `--ash` or `--rust` (some
themes write them in oklch, so they are resolved to rgb first) and follows a
theme change. Reduced motion holds each state's still. A leaf mounted
already done starts in its satisfied loop; the flourish plays when the state
changes to done while it is on screen.

## Measured (2026-10-07, this Mac, headless Chrome with Metal, 60 Hz)

`node living/_src/perf.mjs 30 24` (30 rows like the Agents tab, mixed states):

| Case | Frame gap mean / p95 / max | Leaf work per frame mean / p95 |
|---|---|---|
| 30 leaves at 24 px | 16.65 / 16.80 / 16.80 ms | 0.75 / 0.90 ms |
| 30 leaves at 40 px | 16.64 / 16.80 / 16.80 ms | 0.72 / 0.80 ms |
| 120 leaves at 24 px, about 32 on screen | 16.66 / 16.80 / 16.80 ms | 1.05 / 1.60 ms |
| 1 leaf at 160 px | 16.65 / 16.80 / 16.80 ms | 0.20 ms |

No dropped frames. "Leaf work" is the main-thread time of posing, drawing and
copying; GPU time is not in it, but the frame gap shows it fits.

Bundle: three.js plus the leaf code, in a chunk of its own
(`dist/assets/stage-*.js`): 560 KB minified, **141.7 KB gzipped** as Vite
reports it. The app's main chunk does not carry it.

## Tests (2026-10-07, ports 8875 to 8876, inspector 9375)

- `npx playwright test --project=sessions`: 5 passed.
- `npx playwright test -c playwright.agents.config.ts` (Colima profile
  cloud-agents, stopped after): agents, agents-assistant, agents-issue,
  agents-review, 4 passed.
- The agents shots (`PANDO_AGENTS_SHOTS=1`) show the living leaf in the
  floating button, the chat header and the agent page header.
- `npm run lint`, `npm run typecheck`: clean.

## Renders

`node living/_src/capture.mjs` (about 30 s for all): 1080 x 1080, 60 fps,
10 s per state (the tour 15 s), H.264 MP4 and a 480 px 25 fps GIF.
`node living/_src/shot.mjs "render.html?mode=contact&size=220" renders/contact-sheet.png 1300 1400 2`.

## Tuning pass after the owner's look (2026-10-07)

The owner: "all pretty good, working is a bit rapid/edgy, needs you is too. the
others are nice and subtle but maybe a bit too much... the accenture ones are a
bit more fluid." Timing and ease only, not the design:

- Every channel now follows its written targets through a damped spring
  (low stiffness, well damped), stepped at a fixed 240 Hz from t = 0 and
  baked once per state into a loop table (the first pass, then the steady
  loop), as the reference rig does. Softer springs down the chain: the blade
  lags the body and overshoots a little, the stem lags the blade, the eyes
  lead. The tremble is layered on after the springs; blinks stay crisp.
- A new ease, `glide`, leaves gently and arrives on a long tail; sways carry
  a second harmonic so they linger at one side. No move is linear or
  symmetric.
- Working: one beat a second (was two), a long rise, an eased fall, a gentle
  press on landing, no hard accent beat.
- Needs you: one gentle hop and a settle; the badge fades in and pulses
  slowly.
- Idle, thinking, done: amplitudes down about a third, slower sways; done
  keeps its full turn with a longer wind-up and a softer landing.
- Every loop is 5 s (done: 2.5 s flourish, then a 2.5 s loop), so the 10 s
  renders and the preview's 10 s timeline loop without a seam. A change of
  state blends over 0.7 s.

Then the owner: "working is now a bit too subtle." Working sits halfway
between the two: the springs and eases stay, the beat is 1.6 a second (eight
to the 5 s loop), with more height in the rise, a firmer press with a clearer
squash and nod, and a larger blade follow-through. It reads at 40 px.

## How close to the bar

The reference (a character animation the owner loved) has: real volume, key
and rim light, contact shadow, glossy eyes with lids and brows that look at
targets, anticipation, squash and stretch with volume kept, follow-through,
settle, deterministic time. This leaf has all of those except brows (the
pixel leaf has none, so none were added) and gaze at world targets (its
eyes look by direction; there is nothing in the frame to look at). It is
procedural keys, not hand-keyed acting; the reference is the same. What an
animator would push further: stronger extremes in the done flourish, a
mouth with more shapes when the assistant speaks, eye darts in holds, and a
hand-tuned tremble per size.
