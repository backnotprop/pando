// Issues, end to end (research/plans/issues-2026-10-04/SPEC.md section 9): real git through the door, real
// Artifacts, the monorepo object, its event stream and the home's feed, against wrangler dev.
//
//   npx wrangler dev --port 8797 --persist-to <dir> --var DOOR_TEST:1 --var FACTS_TEST:1 --var FEED_TICK_MS:500
//   PANDO_URL=http://localhost:8797 node test/issues.mjs
//
// Credentials stay in memory and are never printed; git never reaches the keychain. It deletes its monorepo.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers });

const work = mkdtempSync(join(tmpdir(), "pando-issues-"));

const gitAs = (secret) => (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "", GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@pando.invalid" },
  });

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.replace(/pando_[a-f0-9]+/g, "<credential>") };
};

async function waitFor(pred, ms = 15_000) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(200);
  }

  return null;
}

/** An event socket that collects frames. */
function socket(path, secret) {
  const frames = [];
  const ws = new WebSocket(`${WS_}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  ws.onmessage = (m) => {
    try {
      frames.push(JSON.parse(m.data));
    } catch {}
  };

  return { ws, frames, events: () => frames.filter((f) => f.type === "event") };
}

const id = Date.now().toString(36);

const ana = `is-a-${id}`;

const bo = `is-b-${id}`;

const cy = `is-c-${id}`;

const M = `is-${id}`;

const O = ana;

const mb = `/v1/monorepos/${O}/${M}`;

let A = null;

let made = false;

const sockets = [];

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, A)).status);

try {
  // ── Setup: ana owns the monorepo, bo is a member, cy is not; projects/a and projects/b ──
  A = (await call("POST", "/v1/users", BOOT, { login: ana, name: "Ana Lima" })).json?.credential?.secret;
  const B = (await call("POST", "/v1/users", BOOT, { login: bo })).json?.credential?.secret;
  const Cy = (await call("POST", "/v1/users", BOOT, { login: cy })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", A, { name: M });
  made = r.status === 201;

  if (made) tw.add(`${O}/${M}`);
  const MID = r.json?.monorepo?.id;
  const repos = {};

  for (const path of ["projects/a", "projects/b"]) {
    r = await call("POST", `${mb}/repos`, A, { path });
    repos[path] = { name: r.json?.name, url: r.json?.clone_url };
  }

  r = await call("PUT", `${mb}/members/${bo}`, A, { role: "member" });
  check("a monorepo with two projects, an owner and a member", made && !!MID && r.status === 200 && !!repos["projects/a"].url && !!repos["projects/b"].url, `${r.status}`);

  if (!MID) throw new Error("no monorepo to test with");
  const git = gitAs(A);
  const clones = {};

  for (const [path, rp] of Object.entries(repos)) {
    const dir = join(work, path.replace("/", "-"));
    mkdirSync(dir);
    git(["init", "-q"], dir);
    writeFileSync(join(dir, "README.md"), `# ${path}\n`);
    git(["add", "-A"], dir);
    git(["commit", "-qm", "first"], dir);
    git(["remote", "add", "origin", rp.url], dir);
    git(["push", "-q", "origin", "main"], dir);
    clones[path] = dir;
  }

  const issue = async (n, as = A) => (await call("GET", `${mb}/issues/${n}`, as)).json;
  const create = async (body, as = A, headers = {}) => call("POST", `${mb}/issues`, as, body, headers);
  const patch = async (n, body, as = A) => call("PATCH", `${mb}/issues/${n}`, as, body);
  const timeline = async (n, q = "") => (await call("GET", `${mb}/issues/${n}/timeline${q}`, A)).json;
  const eventsOf = async (q) => (await call("GET", `${mb}/events?since=0&limit=500${q ? `&${q}` : ""}`, A)).json?.events ?? [];

  /** A branch with one commit on main's head, pushed; its head. */
  const pushBranch = (path, branch, file, message) => {
    const dir = clones[path];
    git(["checkout", "-q", "main"], dir);
    git(["pull", "-q", "origin", "main"], dir);
    git(["checkout", "-qB", branch], dir);
    writeFileSync(join(dir, file), `${branch} ${Date.now()}\n`);
    git(["add", "-A"], dir);
    git(["commit", "-qm", message], dir);
    const pushed = git(["push", "-qf", "origin", branch], dir);

    return pushed.ok ? git(["rev-parse", "HEAD"], dir).out.trim() : null;
  };

  const merge = (repo, branch, head, headers = {}, force = false) => call("POST", `${mb}/repos/${repo}/branches/${encodeURIComponent(branch)}/merge?force=${force ? 1 : 0}`, A, { expected_head: head }, headers);

  // ── Labels: a new monorepo's four ──
  r = await call("GET", `${mb}/labels`, A);
  check("a new monorepo starts with four labels", JSON.stringify(r.json?.labels?.map((l) => `${l.name}:${l.color}`)) === JSON.stringify(["bug:orange", "documentation:teal", "enhancement:blue", "question:purple"]), JSON.stringify(r.json?.labels?.map((l) => l.name)));

  // ── 1. Numbering: 100 creates at once from 10 credentials, then 20 retried with their keys ──
  const creds = [];

  for (let i = 0; i < 10; i++) {
    const as = i % 2 ? B : A;
    creds.push({ login: i % 2 ? bo : ana, secret: (await call("POST", "/v1/user/credentials", as, { name: `agent-${i}`, kind: "sandbox" })).json?.secret });
  }

  const made100 = await Promise.all(Array.from({ length: 100 }, (_, i) => create({ title: `Parallel ${i}` }, creds[i % 10].secret, { "idempotency-key": `k-${i}` })));
  const numbers = made100.map((x) => x.json?.number);
  check("100 creates at once: numbers 1 to 100, each once", made100.every((x) => x.status === 201) && [...numbers].sort((a, b) => a - b).every((n, i) => n === i + 1), `${new Set(numbers).size} distinct, statuses ${[...new Set(made100.map((x) => x.status))]}`);
  const again = await Promise.all(Array.from({ length: 20 }, (_, i) => create({ title: `Parallel ${i}` }, creds[i % 10].secret, { "idempotency-key": `k-${i}` })));
  r = await call("GET", `${mb}/issues?state=all&limit=1`, A);
  check("20 retried with their keys: the same issues (200, Pando-Replayed), still 100", again.every((x, i) => x.status === 200 && x.headers.get("pando-replayed") === "true" && x.json?.number === numbers[i]) && r.json?.counts?.open === 100, `${again.map((x) => x.status).join(",").slice(0, 40)} open ${r.json?.counts?.open}`);
  const first = await issue(1);
  check("an issue: body_version 1, the machine that opened it, its author as participant", first?.body_version === 1 && /^agent-\d$/.test(first?.machine ?? "") && first?.participants?.[0] === first?.author && first?.reactions?.length === 0, JSON.stringify({ m: first?.machine, p: first?.participants }));

  // ── Comments, reactions, timeline ──
  const k1 = await call("POST", `${mb}/issues/1/comments`, B, { body: "Seen it too." }, { "idempotency-key": "c-1" });
  const k2 = await call("POST", `${mb}/issues/1/comments`, B, { body: "Seen it too." }, { "idempotency-key": "c-1" });
  check("a comment, and its retry with the key: the same comment", k1.status === 201 && k2.status === 200 && k1.json?.id === k2.json?.id && !!k1.json?.machine, `${k1.status} ${k2.status} machine ${k1.json?.machine}`);
  r = await call("GET", `${mb}/issues/1/comments/${k1.json?.id}`, A);
  check("GET a comment whole", r.status === 200 && r.json?.body === "Seen it too.");
  r = await call("PATCH", `${mb}/issues/1/comments/${k1.json?.id}`, A, { body: "not yours" });
  check("someone else's comment cannot be edited (403)", r.status === 403, `${r.status}`);
  r = await call("PATCH", `${mb}/issues/1/comments/${k1.json?.id}`, B, { body: "Seen it twice.", base_version: 1 });
  const stale = await call("PATCH", `${mb}/issues/1/comments/${k1.json?.id}`, B, { body: "Older edit", base_version: 1 });
  check("a comment edit, then one from the old version: 409 edited with the comment now", r.status === 200 && r.json?.body_version === 2 && stale.status === 409 && stale.json?.error?.code === "edited" && stale.json?.error?.current?.body === "Seen it twice.", `${r.status} ${stale.status}`);

  for (const [as, content] of [[A, "+1"], [B, "+1"], [B, "+1"], [B, "heart"]]) await call("PUT", `${mb}/issues/1/reactions/${encodeURIComponent(content)}`, as);
  r = await call("DELETE", `${mb}/issues/1/reactions/heart`, B);
  const cr = await call("PUT", `${mb}/issues/1/comments/${k1.json?.id}/reactions/rocket`, A);
  check(
    "reactions: two +1 (each person once), a heart taken back, a rocket on the comment",
    JSON.stringify(r.json?.reactions) === JSON.stringify([{ content: "+1", count: 2, by: [ana, bo] }]) && cr.json?.reactions?.[0]?.content === "rocket" && (await issue(1))?.reactions?.[0]?.count === 2,
    JSON.stringify(r.json?.reactions),
  );
  const own = await call("POST", `${mb}/issues/1/comments`, B, { body: "Delete me." });
  r = await call("DELETE", `${mb}/issues/1/comments/${own.json?.id}`, A);
  const t1 = await timeline(1);
  check("an owner deletes a member's comment: it leaves the timeline", r.status === 204 && t1?.items?.every((x) => x.comment?.id !== own.json?.id) && t1?.total === 1 && (await issue(1))?.comments === 1, `${r.status} total ${t1?.total}`);
  r = await call("GET", `${mb}/issues/1`, Cy);
  check("a non-member sees nothing (403, as every monorepo route answers)", r.status === 403 && !r.json?.title, `${r.status}`);

  // ── Body race: two edits from the same version ──
  const [e1, e2] = await Promise.all([patch(2, { body: "First body", base_version: 1 }), patch(2, { body: "Second body", base_version: 1 }, B)]);
  const won = e1.status === 200 ? e1 : e2;
  const lost = e1.status === 200 ? e2 : e1;
  check("two body edits from version 1: one 200, one 409 edited carrying the first's body", won.status === 200 && lost.status === 409 && lost.json?.error?.code === "edited" && lost.json?.error?.current?.body === won.json?.body, `${e1.status} ${e2.status}`);

  // ── Labels and permissions; filters, search and paging ──
  r = await call("POST", `${mb}/labels`, B, { name: "area/web", color: "teal" });
  const lab = await call("POST", `${mb}/labels`, A, { name: "area/web", color: "teal", description: "The web app" });
  check("a member cannot make a label (403); an owner can", r.status === 403 && lab.status === 201 && lab.json?.color === "teal", `${r.status} ${lab.status}`);
  const zz = await create({ title: "Zanzibar crash", body: "It crashes in zanzibar mode.\n\n- [x] repro\n- [ ] fix", labels: ["bug", "area/web"], assignees: [bo], project: repos["projects/a"].name }, B);
  const zn = zz.json?.number;
  check("an issue with labels, an assignee, a project and a task list", zz.status === 201 && zz.json?.labels?.length === 2 && zz.json?.assignees?.[0] === bo && zz.json?.project_path === "projects/a" && zz.json?.tasks?.done === 1 && zz.json?.tasks?.total === 2, JSON.stringify(zz.json?.tasks));
  r = await create({ title: "x", assignees: [cy] });
  check("an assignee must be a member (400 not_a_member)", r.status === 400 && r.json?.error?.code === "not_a_member", `${r.status} ${r.json?.error?.code}`);
  r = await call("GET", `${mb}/issues?label=bug&label=area/web&assignee=@me&project=${repos["projects/a"].name}&state=open`, B);
  const q = await call("GET", `${mb}/issues?q=zanzib&state=all`, A);
  check("filters combine (labels, @me, project, state), and search finds a body word by its prefix", r.json?.issues?.map((x) => x.number).join() === String(zn) && r.json?.counts?.open === 1 && q.json?.issues?.map((x) => x.number).join() === String(zn), `${r.json?.issues?.length} ${q.json?.issues?.length}`);
  r = await call("PATCH", `${mb}/labels/area%2Fweb`, A, { name: "area/app" });
  check("an owner's rename moves the label on every issue", r.status === 200 && (await issue(zn))?.labels?.some((l) => l.name === "area/app"), `${r.status}`);
  const p1 = await call("GET", `${mb}/issues?state=all&limit=30`, A);
  await create({ title: "Arrives while paging" });
  const p2 = await call("GET", `${mb}/issues?state=all&limit=30&cursor=${encodeURIComponent(p1.json?.next_cursor ?? "")}`, A);
  const p3 = await call("GET", `${mb}/issues?state=all&limit=30&cursor=${encodeURIComponent(p2.json?.next_cursor ?? "")}`, A);
  const pages = [p1, p2, p3].flatMap((p) => p.json?.issues?.map((x) => x.number) ?? []);
  check("three pages by cursor: newest first, none twice, stable while an issue arrives", pages.length === 90 && new Set(pages).size === 90 && pages.every((n, i) => i === 0 || n < pages[i - 1]), `${pages.length} rows`);

  // ── Live: topics issues and issue:<n> ──
  const one = socket(`${mb}/events?topics=issue:${zn}`, A);
  const all = socket(`${mb}/events?topics=issues`, A);
  sockets.push(one, all);
  await waitFor(() => one.frames.some((f) => f.type === "caught_up") && all.frames.some((f) => f.type === "caught_up"), 10_000);
  await call("POST", `${mb}/issues/${zn}/comments`, A, { body: "Live comment" });
  await call("POST", `${mb}/issues/3/comments`, A, { body: "Elsewhere" });
  await call("PUT", `${mb}/issues/${zn}/reactions/eyes`, B);
  await waitFor(() => all.events().length >= 3, 5_000);
  await sleep(300);
  const mine = one.events();
  check(
    "issue:<n> gets only that issue's events (a comment item, then reactions); issues gets both",
    mine.length === 2 && mine[0].kind === "issue.commented" && mine[0].items?.[0]?.comment?.body === "Live comment" && mine[0].row?.number === zn && mine[1].reactions?.[0]?.content === "eyes" && all.events().some((e) => e.number === 3),
    mine.map((e) => e.kind).join(","),
  );

  // ── Needs you: issues assigned to bo ──
  const needs = await waitFor(async () => (await call("GET", "/v1/branches", B)).json?.issues?.find((x) => x.monorepo_id === MID && x.count >= 1), 20_000);
  check("Needs you: bo's assigned issues in this monorepo, with the newest", !!needs && needs.newest?.number === zn, JSON.stringify(needs));

  // ── 2. Close on merge, every source: the title, a commit, a link; a mention and an unknown number do not ──
  const [tA, tB, tC, tD] = await Promise.all(["By the title", "By a commit", "By a link", "Only mentioned"].map(async (title) => (await create({ title })).json?.number));
  const pa = repos["projects/a"].name;
  r = await call("POST", `${mb}/repos/${pa}/branches`, A, { name: "fix-all", title: `Fixes #${tA}`, description: "And `fixes #${tD}` in code." });
  git(["fetch", "-q", "origin"], clones["projects/a"]);
  const headAll = pushBranch("projects/a", "fix-all", "all.txt", `Make it work (fixes #${tB})\n\nSee #${tD}. Fixes #999.`);
  await patch(tC, { link: [{ repo: pa, branch: "fix-all" }] }, B);

  const linkedAll = await waitFor(async () => {
    const x = (await call("GET", `${mb}/issues?linked=${pa}:fix-all&state=all`, A)).json?.issues?.map((i) => i.number).sort((a, b) => a - b);

    return x?.length === 3 ? x : null;
  });

  const viaCommit = (await issue(tB))?.links?.[0];
  check("the branch is linked three ways: title, commit (with the facts) and link", JSON.stringify(linkedAll) === JSON.stringify([tA, tB, tC].sort((a, b) => a - b)) && viaCommit?.sources?.includes("commit") && viaCommit?.sha === headAll, JSON.stringify(viaCommit?.sources));
  const seqBefore = (await call("GET", `${mb}/events?limit=1`, A)).json?.seq ?? 0;
  r = await merge(pa, "fix-all", headAll);
  check("the merge answers the issues it closes", r.status === 200 && JSON.stringify(r.json?.closes) === JSON.stringify([tA, tB, tC].sort((a, b) => a - b)), `${r.status} ${JSON.stringify(r.json?.closes)}`);

  const closed = await waitFor(async () => {
    const xs = await Promise.all([tA, tB, tC].map((n) => issue(n)));

    return xs.every((x) => x?.state === "closed") ? xs : null;
  }, 8_000);

  check("about a second later each is closed as completed, by the merge", !!closed && closed.every((x) => x.state_reason === "completed" && x.closed_by === ana && x.closed_by_merge?.branch === "fix-all" && x.closed_by_merge?.repo_path === "projects/a"), JSON.stringify(closed?.map((x) => x.closed_by_merge?.branch)));
  check("the mentioned issue stays open", (await issue(tD))?.state === "open");
  const evs = (await eventsOf("")).filter((e) => e.seq > seqBefore);
  const mergedSeq = evs.find((e) => e.kind === "merged")?.seq ?? 0;
  const closedEvs = evs.filter((e) => e.kind === "issue.closed");
  check("one issue.closed each, after the merged event, naming the merge", closedEvs.length === 3 && closedEvs.every((e) => e.seq > mergedSeq && e.items?.[0]?.merge?.branch === "fix-all"), `${closedEvs.length} after ${mergedSeq}`);
  const line = await waitFor(async () => (await call("GET", `/v1/events?in=${O}/${M}&limit=50`, A)).json?.events?.find((e) => e.kind === "merged" && e.branch === "fix-all"));
  check("the home's merged line carries the issues it closes", JSON.stringify(line?.summary?.closes) === JSON.stringify(r.json?.closes), JSON.stringify(line?.summary));
  r = await merge(pa, "fix-all", headAll);
  await sleep(1_500);
  const closedItems = (await timeline(tA))?.items?.filter((x) => x.kind === "closed");
  check("merged again: up_to_date, and nothing closed twice", r.json?.status === "up_to_date" && closedItems?.length === 1, `${r.json?.status} ${closedItems?.length}`);
  check("the Development box: the branch merged, and it closed the issue", (await issue(tA))?.links?.some((l) => l.branch === "fix-all" && l.branch_state === "merged" && l.closed_issue), JSON.stringify((await issue(tA))?.links));

  // ── 3. Stale facts: push "fixes #N" and merge at once: the merge reads the commits itself ──
  const [s1, s2] = await Promise.all(["Stale facts", "Late read"].map(async (title) => (await create({ title })).json?.number));
  await call("POST", "/v1/_facts/test", BOOT, { monorepo: MID, fail: 1 });
  const headS1 = pushBranch("projects/a", "stale-fix", "stale.txt", `Quick fix (fixes #${s1})`);
  r = await merge(pa, "stale-fix", headS1);
  const s1Closed = await waitFor(async () => ((await issue(s1))?.state === "closed" ? true : null), 8_000);
  check("merged before its facts: the merge read its commits, and the issue closes", r.status === 200 && JSON.stringify(r.json?.closes) === `[${s1}]` && !!s1Closed, `${r.status} ${JSON.stringify(r.json?.closes)}`);

  // The read past its time limit (a test switch): the merge goes on; the issue gets a merge_referenced item, not a close.
  await call("POST", "/v1/_facts/test", BOOT, { monorepo: MID, fail: 1 });
  const headS2 = pushBranch("projects/a", "late-fix", "late.txt", `Late fix (fixes #${s2})`);
  r = await merge(pa, "late-fix", headS2, { "x-pando-test-merge-refs-late": "1" });
  const referenced = await waitFor(async () => ((await timeline(s2))?.items?.some((x) => x.kind === "merge_referenced" && x.merge?.branch === "late-fix") ? true : null), 20_000);
  check("a read past its limit: the merge lands, the issue stays open with a merge_referenced item later", r.status === 200 && !r.json?.closes?.includes(s2) && !!referenced && (await issue(s2))?.state === "open", `${r.status} ${JSON.stringify(r.json?.closes)}`);

  // ── 5. Two merges fixing one issue at once, from two projects ──
  const dn = (await create({ title: "Fixed twice" })).json?.number;
  const pb = repos["projects/b"].name;
  const hA = pushBranch("projects/a", "two-a", "two.txt", `Half of it (fixes #${dn})`);
  const hB = pushBranch("projects/b", "two-b", "two.txt", `The other half (fixes #${dn})`);
  await waitFor(async () => ((await issue(dn))?.links?.length === 2 ? true : null));
  const [m1, m2] = await Promise.all([merge(pa, "two-a", hA), merge(pb, "two-b", hB)]);
  await sleep(2_500);
  const dt = (await timeline(dn))?.items ?? [];
  const dClosed = (await eventsOf("kinds=issue.closed")).filter((e) => e.number === dn);
  check("two merges at once: one closed item and one issue.closed, one merge_referenced", m1.status === 200 && m2.status === 200 && dt.filter((x) => x.kind === "closed").length === 1 && dt.filter((x) => x.kind === "merge_referenced").length === 1 && dClosed.length === 1, `${dt.map((x) => x.kind).join(",")}`);

  // ── 7. A revert never closes ──
  const rn = (await create({ title: "Reverted later" })).json?.number;
  const hR1 = pushBranch("projects/a", "rv-fix", "rv.txt", `Fix the thing (fixes #${rn})`);
  r = await merge(pa, "rv-fix", hR1);
  await waitFor(async () => ((await issue(rn))?.state === "closed" ? true : null), 8_000);
  await patch(rn, { state: "open" });
  const dir = clones["projects/a"];
  // A real `git revert` of the merged commit: its tree is main's from before, which Artifacts refused until the door
  // sent such a push again with its trees whole (research/operational/artifacts-delta-cycle-2026-10-04.md).
  git(["checkout", "-q", "main"], dir);
  git(["pull", "-q", "origin", "main"], dir);
  git(["checkout", "-qB", "rv-undo"], dir);
  git(["revert", "--no-edit", hR1], dir);
  const pushedRevert = git(["push", "-qf", "origin", "rv-undo"], dir);
  const hR2 = git(["rev-parse", "HEAD"], dir).out.trim();
  check("a real git revert of the merged commit pushes", pushedRevert.ok, pushedRevert.out.split("\n").filter(Boolean).slice(-2).join(" | "));
  r = await merge(pa, "rv-undo", hR2);
  await sleep(2_000);
  check("a git revert's merge closes nothing (its message quotes \"fixes\")", r.status === 200 && (r.json?.closes ?? []).length === 0 && (await issue(rn))?.state === "open", `${r.status} ${JSON.stringify(r.json?.closes ?? r.json?.error)}`);

  // ── 8. Refused merges close nothing ──
  const fn = (await create({ title: "Refused" })).json?.number;
  const hF = pushBranch("projects/a", "red-fix", "red.txt", `Try (fixes #${fn})`);
  await call("POST", `${mb}/repos/${pa}/statuses/${hF}`, A, { context: "ci", state: "failure" });
  const red = await merge(pa, "red-fix", hF);
  const moved = await merge(pa, "red-fix", "0".repeat(40), {}, true);
  await sleep(1_500);
  check("refused merges (412 red, 409 head moved) close nothing", red.status === 412 && moved.status === 409 && (await issue(fn))?.state === "open", `${red.status} ${moved.status}`);

  // ── 14. Commit links follow the head; title links follow edits ──
  const cn = (await create({ title: "Commit link" })).json?.number;
  pushBranch("projects/a", "cl", "cl.txt", `Work (fixes #${cn})`);
  const linkedC = await waitFor(async () => ((await issue(cn))?.links?.some((l) => l.branch === "cl") ? true : null));
  git(["commit", "-q", "--amend", "-m", "Work"], dir);
  git(["push", "-qf", "origin", "cl"], dir);
  const unlinkedC = await waitFor(async () => ((await issue(cn))?.links?.length === 0 ? true : null));
  check("a commit link follows the head: gone after a force-push without the keyword", !!linkedC && !!unlinkedC && (await timeline(cn))?.items?.some((x) => x.kind === "unlinked" && x.source === "commit"));
  r = await call("PATCH", `${mb}/repos/${pa}/branches/cl`, A, { title: `Closes #${cn}` });
  const titled = (await issue(cn))?.links?.[0]?.sources;
  await call("PATCH", `${mb}/repos/${pa}/branches/cl`, A, { title: "Nothing" });
  check("a title link follows the branch's title", JSON.stringify(titled) === '["title"]' && (await issue(cn))?.links?.length === 0, JSON.stringify(titled));

  // ── A person closes as not planned; the timeline pages ──
  r = await patch(cn, { state: "closed", state_reason: "not_planned" }, B);
  const act = await waitFor(async () => (await call("GET", `/v1/events?in=${O}/${M}&limit=100`, A)).json?.events?.find((e) => e.kind === "issue.closed" && e.summary?.number === cn));
  check("closed as not planned by a person: an activity line with the reason", r.json?.state_reason === "not_planned" && act?.summary?.reason === "not_planned" && act?.actor === bo, JSON.stringify(act?.summary));
  const tl = await timeline(cn);
  const last2 = await timeline(cn, "?last=2");
  const page1 = await timeline(cn, "?limit=2");
  const page2 = await timeline(cn, `?limit=2&cursor=${page1?.next_cursor}`);
  check("the timeline: total, the newest by last=, pages by cursor", last2?.items?.length === 2 && last2.items[1].id === tl.items.at(-1).id && tl.total === tl.items.length && page2?.items?.[0]?.id === tl.items[2]?.id, `total ${tl?.total}`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const s of sockets) s.ws.close();

  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
