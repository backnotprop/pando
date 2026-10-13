// End to end: risk-based review (docs/risk-review/DESIGN.md) on the agents'
// local server (Pando's Worker with its own pando-agents and real Workers AI),
// started with RISK_REVIEW=on and RISK_TEST=1 in worker/.dev.vars:
//
//   AGENTS_PORT=8919 ... agents/test/serve.sh start
//   AGENTS_URL=http://127.0.0.1:8919 node agents/test/risk-review.mjs     (RECORD=1 also writes the contract's recordings)
//
// Real clef scores the docs-only and the payments branches (each a real
// Workers AI call, counted at the end with its cost); the test switch
// (/v1/_risk/test) stands in for clef where a given score is needed, fails it
// once, and runs the reviewer agents on the scripted model. The guided review
// is written by the real model (GLM-5.3 Flash).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOOT, call, check, done, git, makeRepo, scrub, sleep, tool } from "./lib.mjs";

const RECORD = process.env.RECORD === "1";

const clef = { calls: 0, tokens: 0, cost: 0 };

function record(file, schema, route, status, body) {
  if (!RECORD) return;
  writeFileSync(new URL(`../../packages/contract/recorded/${file}`, import.meta.url), scrub(JSON.stringify({ schema, route, status, body }, null, 2)) + "\n");
}

const t = await makeRepo("risk", {
  "README.md": "# Shop\n",
  "docs/guide.md": "# Guide\n\nHow to run the shop.\n",
  "src/app.ts": "export const app = () => 1;\n",
  "src/util.ts": "export const add = (a: number, b: number) => a + b;\n",
  "payments/charge.ts": "export function charge(cents: number) {\n  return { cents, currency: 'usd' };\n}\n",
  ".pando/pando.toml": '[review]\nsensitive = ["payments/", "deploy/"]\n',
});

const src = join(t.work, "src");

let r = await call("GET", `/v1/monorepos/${t.full}/repos`, t.secret);

const repo = r.json.repos[0].name;

const R = `/v1/monorepos/${t.full}/repos/${repo}`;

const risk = (body) => call("POST", "/v1/_risk/test", BOOT, { monorepo: t.monorepoId, ...body });

/** A branch from main with one changed file, pushed by the person; its head. */
function push(branch, path, text, message) {
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-q", "-b", branch], src);
  writeFileSync(join(src, path), text);
  git(["commit", "-qam", message], src);
  const g = git(["push", "-q", t.cloneUrl, branch], src, t.secret);

  if (!g.ok) throw new Error(scrub(g.out));

  return git(["rev-parse", "HEAD"], src).out.trim();
}

/** The branch row once `done(review)` holds (default: scored), or the last one. */
async function until(branch, done = (v) => v?.state === "done", ms = 60_000) {
  const end = Date.now() + ms;
  let b;

  do {
    b = (await call("GET", `${R}/branches/${branch}`, t.secret)).json;

    if (done(b?.review)) return b;
    await sleep(500);
  } while (Date.now() < end);

  return b;
}

function counted(v) {
  if (v?.model !== "@cf/cloudflare/clef") return;
  clef.calls++;
  clef.tokens += v.tokens ?? 0;
  clef.cost += v.cost_usd ?? 0;
}

const merge = (branch, force = false) => call("POST", `${R}/branches/${branch}/merge${force ? "?force=1" : ""}`, t.secret);

const reviewer = (verdict, body) => tool("post_review", { verdict, body });

try {
  // ── Settings ──
  r = await call("GET", R, t.secret);
  check("a repo's review settings: on (the server's default), 0.35 and 0.70, sensitive asks a person", r.json?.review?.enabled === true && r.json.review.auto_below === 0.35 && r.json.review.human_above === 0.7 && r.json.review.human_for_sensitive === true, JSON.stringify(r.json?.review));
  record("repo-review.json", "Repo", "GET .../repos/{repo} (risk-based review on)", r.status, r.json);
  r = await call("PATCH", R, t.secret, { review: { auto_below: 0.9, human_above: 0.5 } });
  check("thresholds that cross: 400", r.status === 400 && /auto_below/.test(r.json?.error?.message), JSON.stringify(r.json));
  r = await call("PATCH", R, t.secret, { review: { colour: "red" } });
  check("an unknown setting: 400", r.status === 400, r.status);

  // ── Docs only: real clef, low, auto ──
  let head = push("docs-1", "docs/guide.md", "# Guide\n\nHow to run the shop.\n\nRun `npm start`, then open the shop on port 3000.\n", "docs: say how to start the shop");
  let b = await until("docs-1");
  counted(b?.review);
  check("a docs-only change: real clef scores it low, tier auto, on its head", b?.review?.head === head && b.review.level === "low" && b.review.tier === "auto" && b.review.model === "@cf/cloudflare/clef" && b.review.tokens > 0, JSON.stringify(b?.review));
  check("its meter's reasons say the score in words", b?.review?.reasons?.some((x) => /^Risk 0\.\d\d: mostly low/.test(x)), JSON.stringify(b?.review?.reasons));
  record("branch-review-auto.json", "Branch", "GET .../branches/{branch} (risk low, auto)", 200, b);
  r = await merge("docs-1");
  check("auto merges on green checks as before", r.status === 200 && r.json?.status === "merged", JSON.stringify(r.json));

  // ── Payments: real clef, sensitive (pando.toml's own list), human; reviewers and a guide; a person approves ──
  await risk({ model: "scripted", script: reviewer("comment", "Looks fine.") });
  head = push("pay-1", "payments/charge.ts", "export function charge(cents: number, currency = 'usd') {\n  if (cents <= 0) throw new Error('nothing to charge');\n  return { cents, currency };\n}\n", "payments: refuse empty charges, take a currency");
  b = await until("pay-1");
  counted(b?.review);
  check("a payments change: sensitive by pando.toml's [review] list, tier human", b?.review?.tier === "human" && b.review.sensitive_paths?.[0] === "payments/charge.ts" && b.review.reasons[0]?.startsWith("Touches sensitive paths: payments/charge.ts"), JSON.stringify(b?.review));
  r = await merge("pay-1");
  check("its merge is refused: 412 review_required, with the review state", r.status === 412 && r.json?.error?.code === "review_required" && r.json.error.review?.tier === "human" && /approval/.test(r.json.error.message), JSON.stringify(r.json));
  record("error-review-required.json", "ErrorBody", "POST .../branches/{branch}/merge (412 review_required)", r.status, r.json);

  // Its two reviewer agents run once, each posting a review tagged with its session.
  b = await until("pay-1", (v) => v?.reviewers?.length === 2 && v.reviewers.every((x) => x.state !== "running"), 240_000);
  check("two reviewer agents ran on it (correctness, security), each posted", b?.review?.reviewers?.map((x) => `${x.profile}:${x.state}`).join() === "correctness:posted,security:posted", JSON.stringify(b?.review?.reviewers));
  r = await call("GET", `${R}/branches/pay-1/reviews`, t.secret);
  const sessions = r.json?.reviews?.map((x) => x.session);
  check("each review names its session; AI reviews do not pass the human tier", sessions?.length === 2 && sessions.every((n) => n > 0) && b?.review?.passes === false, JSON.stringify(sessions));
  record("reviews-sessions.json", "ReviewList", "GET .../branches/{branch}/reviews (reviewer agents' reviews)", r.status, r.json);
  r = await call("GET", `/v1/monorepos/${t.full}/agents?repo=${repo}&branch=pay-1&kind=review`, t.secret);
  const first = r.json?.sessions?.length;
  git(["push", "-q", "-f", t.cloneUrl, "pay-1"], src, t.secret); // the same head again
  await sleep(3_000);
  r = await call("GET", `/v1/monorepos/${t.full}/agents?repo=${repo}&branch=pay-1&kind=review`, t.secret);
  check("once per head: the same head pushed again launches nothing", first === 2 && r.json?.sessions?.length === 2, `${first} then ${r.json?.sessions?.length}`);

  // An agent's merge gets the refusal with its reason, and stops.
  r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { branch: "pay-1", model: "scripted", prompt: tool("merge", {}) });
  const n = r.json?.number;
  let tr;

  for (let i = 0; i < 120; i++) {
    tr = (await call("GET", `/v1/monorepos/${t.full}/agents/${n}/transcript`, t.secret)).json;

    if (tr?.messages?.some((m) => m.role === "tool")) break;
    await sleep(1000);
  }

  const said = tr?.messages?.find((m) => m.role === "tool")?.parts?.[0];
  check("an agent's merge tool is told review_required and why", said?.error === true && /Pando refused \(412\) review_required: a person's approval is needed/.test(said?.text ?? ""), scrub(said?.text));

  // The guided review: Plannotator's export, kept as the branch's artifact.
  const t0 = Date.now();
  b = await until("pay-1", (v) => v?.guide_state === "ready" || v?.guide_state === "failed", 300_000);
  check("the guided review is written before anyone looks: guided-review.html on the branch", b?.review?.guide_state === "ready" && !!b.review.guide?.artifact, `${JSON.stringify({ state: b?.review?.guide_state, guide: b?.review?.guide })} after ${Math.round((Date.now() - t0) / 1000)} s`);
  record("branch-review-human.json", "Branch", "GET .../branches/{branch} (risk high or sensitive: human, reviewers posted, guide ready)", 200, b);

  if (b?.review?.guide) {
    r = await call("GET", `/v1/monorepos/${t.full}/artifacts/${b.review.guide.artifact}/versions/1/document`, t.secret);
    check("the artifact is Plannotator's guided review export, covering the changed file", r.status === 200 && /<meta name="plannotator-guided-review" content="v1">/.test(r.text) && r.text.includes("payments/charge.ts"), `${r.status} ${r.text.slice(0, 120)}`);
  }

  r = await call("POST", `${R}/branches/pay-1/reviews`, t.secret, { verdict: "approve", body: "Read it with the guide." });
  b = await until("pay-1", (v) => v?.passes === true, 10_000);
  check("a person's approval on the head passes it", b?.review?.approved_by === t.login && b.review.why === null, JSON.stringify(b?.review));
  r = await merge("pay-1");
  check("then it merges", r.status === 200 && r.json?.status === "merged", JSON.stringify(r.json));

  // ── Medium (scripted score): reviewer agents; one asks for changes ──
  await risk({ score: 0.5, model: "scripted", script: reviewer("comment", "No problems found.") });
  push("mid-1", "src/app.ts", "export const app = () => 2;\n", "app: answer 2");
  b = await until("mid-1", (v) => v?.state === "done" && v.reviewers.length === 2 && v.reviewers.every((x) => x.state !== "running"), 240_000);
  check("a medium score: tier ai, two reviewer agents posted, the gate passes", b?.review?.level === "medium" && b.review.tier === "ai" && b.review.passes === true, JSON.stringify(b?.review));
  record("branch-review-ai.json", "Branch", "GET .../branches/{branch} (risk medium: reviewer agents)", 200, b);
  r = await merge("mid-1");
  check("and it merges without a person", r.status === 200 && r.json?.status === "merged", JSON.stringify(r.json));

  await risk({ score: 0.5, model: "scripted", script: reviewer("request_changes", "This drops the old answer callers rely on.") });
  push("mid-2", "src/app.ts", "export const app = () => 3;\n", "app: answer 3");
  b = await until("mid-2", (v) => v?.state === "done" && v.reviewers.length === 2 && v.reviewers.every((x) => x.state !== "running"), 240_000);
  r = await merge("mid-2");
  check("a reviewer agent asking for changes holds the merge: 412 review_required", r.status === 412 && r.json?.error?.code === "review_required" && /asked for changes/.test(r.json.error.message), JSON.stringify(r.json?.error?.message));

  // ── clef fails: unknown, a person; an owner may force ──
  await risk({ fail: 1, score: null, model: "scripted", script: reviewer("comment", "Fine.") });
  push("fail-1", "src/util.ts", "export const add = (a: number, b: number) => b + a;\n", "util: swap");
  b = await until("fail-1");
  check("clef failing: risk unknown, tier human, the reason shown", b?.review?.level === "unknown" && b.review.tier === "human" && b.review.score === null && /clef failed/.test(b.review.error ?? ""), JSON.stringify(b?.review));
  r = await merge("fail-1");
  check("unknown is never auto: 412 review_required", r.status === 412 && r.json?.error?.code === "review_required", r.status);
  r = await merge("fail-1", true);
  check("an owner's force goes past it, recorded as forced", r.status === 200 && r.json?.forced === true, JSON.stringify(r.json));

  // ── Thresholds in Settings change the tier at once ──
  r = await call("PATCH", R, t.secret, { review: { auto_below: 0.6 } });
  check("PATCH review.auto_below (owners)", r.status === 200 && r.json?.review?.auto_below === 0.6, JSON.stringify(r.json?.review));
  await risk({ score: 0.5, model: null, script: null });
  push("thr-1", "src/util.ts", "export const add = (a: number, b: number) => a + b + 0;\n", "util: add zero");
  b = await until("thr-1");
  check("0.5 under auto_below 0.6: auto", b?.review?.tier === "auto" && b.review.level === "low" && b.review.reviewers.length === 0, JSON.stringify(b?.review));
  r = await call("PATCH", R, t.secret, { review: { auto_below: 0.3, human_above: 0.45 } });
  b = (await call("GET", `${R}/branches/thr-1`, t.secret)).json;
  check("human_above 0.45: the same head is human now, and its merge is refused", b?.review?.tier === "human" && (await merge("thr-1")).status === 412, JSON.stringify(b?.review?.tier));
  r = await call("PATCH", R, t.secret, { review: { auto_below: 0.35, human_above: 0.7 } });

  // ── Off, then on: a head pushed while off is scored at its merge (412 risk_pending first) ──
  r = await call("PATCH", R, t.secret, { review: { enabled: false } });
  push("off-1", "README.md", "# Shop\n\nA small shop.\n", "readme: one line");
  b = (await call("GET", `${R}/branches/off-1`, t.secret)).json;
  check("off: no review on the branch", r.json?.review?.enabled === false && b?.review === null, JSON.stringify(b?.review));
  await call("PATCH", R, t.secret, { review: { enabled: true } });
  await risk({ score: 0.1 });
  r = await merge("off-1");
  check("turned on, a head never scored: 412 risk_pending, as a wait", r.status === 412 && r.json?.error?.code === "risk_pending" && r.json.error.review?.state === "classifying", JSON.stringify(r.json?.error));
  record("error-risk-pending.json", "ErrorBody", "POST .../branches/{branch}/merge (412 risk_pending)", r.status, r.json);
  b = await until("off-1");
  r = await merge("off-1");
  check("scored a moment later: it merges", b?.review?.tier === "auto" && r.status === 200, `${b?.review?.tier} ${r.status}`);
  await risk({ score: null, model: null, script: null });
} catch (err) {
  check("no error", false, err instanceof Error ? err.stack : String(err));
} finally {
  await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret).catch(() => null);
}

console.log(`clef: ${clef.calls} real calls, ${clef.tokens} input tokens, $${clef.cost.toFixed(6)} in all, $${clef.calls ? (clef.cost / clef.calls).toFixed(6) : "0"} a call`);

done();
