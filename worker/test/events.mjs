// The event stream and the data the web screens need, end to end: real git
// through the door, real Artifacts, the meta layer object, against
// `wrangler dev` (bootstrap secret from worker/.dev.vars) or a deployed Worker.
//
//   PANDO_URL=http://localhost:8797 node test/events.mjs
//
// Credentials stay in memory and are never printed. Git never reaches the
// macOS keychain. It deletes the monorepos it made.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

let BOOT = process.env.PANDO_BOOTSTRAP;

if (!BOOT) BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

// The event stream can be switched off on the server (worker/src/monorepo/stream.ts).
let STREAM = true;

let skipped = 0;

const checkS = (name, ok, detail = "") => {
  if (STREAM) return check(name, ok, detail);
  skipped++;
  console.log(`SKIP  ${name}  (the event stream is on hold)`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers });

const work = mkdtempSync(join(tmpdir(), "pando-events-"));

const git = (args, cwd, secret) => {
  const r = spawnSync("git", ["-c", "credential.helper=", ...(secret ? ["-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'] : []), "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "", GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@pando.invalid" },
  });

  return { ok: r.status === 0, out: scrub((r.stdout || "") + (r.stderr || "")) };
};

/** An event socket that collects frames. */
function openEvents(m, secret, since = null, topics = null) {
  const frames = [];
  const q = [since === null ? null : `since=${since}`, topics ? `topics=${topics}` : null].filter(Boolean).join("&");
  const url = `${WS_}/v1/monorepos/${O}/${m}/events${q ? `?${q}` : ""}`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
  const state = { ws, frames, open: false, closed: null, error: null };
  ws.onopen = () => (state.open = true);
  ws.onmessage = (e) => {
    if (e.data === "pong") return frames.push({ type: "pong" });

    try {
      frames.push(JSON.parse(e.data));
    } catch {
      frames.push({ type: "unparsed", data: String(e.data) });
    }
  };

  ws.onclose = (e) => (state.closed = e.code);
  ws.onerror = (e) => (state.error = e.message ?? "error");

  return state;
}

async function waitFor(pred, ms = 20_000) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = pred();

    if (v) return v;
    await sleep(100);
  }

  return null;
}

const eventsOf = (s) => s.frames.filter((f) => f.type === "event");

const find = (s, pred) => (STREAM ? waitFor(() => eventsOf(s).find(pred)) : Promise.resolve(null));

const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

const id = Date.now().toString(36);

const M = `ev-${id}`;

const O = `ana-${id}`; // the owner (namespaces: owner/name)

const made = [];

let A = null;

const sockets = [];

try {
  // ── Setup: two users, a monorepo with one project repo ──
  A = (await call("POST", "/v1/users", BOOT, { login: `ana-${id}`, name: "Ana Lima", email: `ana-${id}@pando.invalid`, credential_name: "ana-mbp" })).json?.credential?.secret;
  const B = (await call("POST", "/v1/users", BOOT, { login: `bo-${id}` })).json?.credential?.secret;
  check("two users", !!A && !!B);
  let r = await call("POST", "/v1/users", BOOT, { login: "settings" });
  check("a reserved name (settings) is refused as a login (a namespace)", r.status === 400 && r.json?.error?.code === "reserved_name", `${r.status}`);
  r = await call("POST", "/v1/monorepos", A, { name: M });
  made.push(M);
  check("make a monorepo", r.status === 201);
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos`, A, { path: "projects/web" });
  const url = r.json?.clone_url;
  const repo = r.json?.name;
  r = await call("GET", `/v1/monorepos/${O}/${M}/events?limit=1`, A);
  STREAM = r.status !== 501;
  console.log(STREAM ? "The event stream is on." : "The event stream is on hold (501): its checks are skipped.");
  r = await call("GET", `/v1/monorepos/${O}/${M}/members`, A);
  check("members carry display names", r.json?.members?.[0]?.name === "Ana Lima", JSON.stringify(r.json?.members?.[0]));

  // ── The socket: members only ──
  const outsider = openEvents(M, B);

  if (STREAM) await waitFor(() => outsider.closed !== null || outsider.error, 10_000);
  checkS("a non-member cannot open the event socket", !outsider.open || outsider.closed !== null, `open=${outsider.open} closed=${outsider.closed} error=${outsider.error}`);
  const ev = openEvents(M, A);
  sockets.push(ev);
  const mainOnly = openEvents(M, A, null, "main");
  sockets.push(mainOnly);
  const caught = STREAM ? await waitFor(() => ev.frames.find((f) => f.type === "caught_up")) : null;
  checkS("the owner opens the event socket and is caught up (caught_up carries seq, a number)", !!caught && Number.isInteger(caught.seq), JSON.stringify(caught));

  if (STREAM && ev.ws.readyState === 1) ev.ws.send("ping");
  checkS("ping gets pong", STREAM && !!(await waitFor(() => ev.frames.find((f) => f.type === "pong"), 5000)));

  r = await call("GET", `/v1/monorepos/${O}/${M}/heads`, A);
  check("GET heads: an empty repo's main is null", r.status === 200 && r.json?.heads?.length === 1 && r.json.heads[0].repo === repo && r.json.heads[0].head === null, JSON.stringify(r.json));
  // ── push main, then a branch ──
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# web\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push main through the door", git(["push", "-q", url, "main"], src, A).ok);
  const mainHead = git(["rev-parse", "HEAD"], src).out.trim();
  r = await call("GET", `/v1/monorepos/${O}/${M}/heads`, A);
  check("GET heads: main after its first push, with no Artifacts read", r.json?.heads?.[0]?.head === mainHead && r.json.heads[0].path === "projects/web" && !!r.json.heads[0].updated_at);
  let e = await find(ev, (x) => x.collection === "default_heads" && x.row?.default_head === mainHead);
  checkS("event: push of main (default_heads upsert)", e?.kind === "push" && e?.key === repo && e?.machine === "ana-mbp" && e?.actor === `ana-${id}`, scrub(JSON.stringify(e)).slice(0, 200));
  // The first push's title arrives with its numbers (the facts job), so poll.
  let title = null;

  for (let i = 0; STREAM && i < 80 && title !== "first"; i++) {
    title = (await call("GET", `/v1/monorepos/${O}/${M}/heads`, A)).json?.heads?.[0]?.head_title ?? null;

    if (title !== "first") await sleep(250);
  }

  checkS("GET heads: main's head_title is its first push's commit title (no Artifacts read)", title === "first", JSON.stringify(title));

  git(["checkout", "-qb", "feat/a"], src);
  writeFileSync(join(src, "a.txt"), "a\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "Add a\n\nPando-Agent: agent-1\nPando-Worktree: projects/web/worktrees/feat-a\nPando-Machine: ana-mbp"], src);
  writeFileSync(join(src, "a.txt"), "a\nb\n");
  git(["commit", "-qam", "More a\n\nPando-Agent: agent-1\nPando-Worktree: projects/web/worktrees/feat-a\nPando-Machine: ana-mbp"], src);
  check("push a branch", git(["push", "-q", url, "feat/a"], src, A).ok);
  const headA = git(["rev-parse", "HEAD"], src).out.trim();

  if (STREAM) {
    const now = await call("GET", `/v1/monorepos/${O}/${M}/events?limit=5`, A);
    checkS("record before ack: the push's event exists as soon as git push returns", now.json?.events?.some((x) => x.kind === "branch.opened" && x.row?.head === headA));
  }

  e = await find(ev, (x) => x.kind === "branch.opened" && x.row?.name === "feat/a");
  checkS("event: branch.opened with the stored Branch fields (partial)", e?.collection === "branches" && e?.op === "upsert" && e?.key === `${repo}/feat/a` && e?.partial === true && e?.row?.head === headA && e?.row?.author === `ana-${id}` && !("ahead" in (e?.row ?? {})), scrub(JSON.stringify(e?.row)).slice(0, 200));
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa`, A);
  const same = Object.keys(e?.row ?? {}).filter((k) => k !== "repo").every((k) => JSON.stringify(r.json?.[k]) === JSON.stringify(e?.row?.[k]));
  checkS("the event's fields equal the same fields of GET getBranch", same, Object.keys(e?.row ?? {}).join(","));

  // ── commits with trailers ──
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa/commits`, A);
  const cm = r.json?.commits ?? [];
  check("GET .../commits lists the branch's 2 commits, newest first", r.status === 200 && cm.length === 2 && cm[0].sha === headA && cm[0].title === "More a" && r.json?.total === 2, `${r.status} ${cm.map((x) => x.title).join(" | ")}`);
  check("trailers parsed (agent, worktree, machine)", cm[0]?.trailers?.agent === "agent-1" && cm[0]?.trailers?.worktree === "projects/web/worktrees/feat-a" && cm[0]?.trailers?.machine === "ana-mbp" && cm[0]?.author?.name === "Ana");

  // ── branch.updated: title; status; review ──
  r = await call("PATCH", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa`, A, { title: "Feature A" });
  e = await find(ev, (x) => x.kind === "branch.updated" && x.row?.title === "Feature A");
  checkS("event: branch.updated after PATCH", !!e);
  await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/statuses/${headA}`, A, { state: "success", context: "ci" }, { "x-pando-agent": "ci-bot" });
  e = await find(ev, (x) => x.kind === "status" && x.row?.sha === headA);
  checkS("event: status (Status row, agent from X-Pando-Agent)", e?.collection === "statuses" && e?.key === `${repo}/${headA}/ci` && e?.row?.state === "success" && e?.agent === "ci-bot", scrub(JSON.stringify(e)).slice(0, 160));
  // The status changes feat/a's gate: its full row follows, with the checks the server computed (the web never recomputes them).
  e = await find(ev, (x) => x.kind === "branch.updated" && x.partial === false && x.row?.name === "feat/a" && x.row?.checks?.statuses?.some((s) => s.context === "ci" && s.state === "success"));
  const gate = (await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa`, A)).json?.checks;
  checkS("a status publishes its branch's full row (branch.updated, partial false) with the new checks, as GET branch computes them", !!e && e.row.checks.sha === headA && e.row.checks.state === gate?.state && e.row.repo === repo, `${e?.row?.checks?.state} vs ${gate?.state}`);
  await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa/reviews`, A, { verdict: "comment", body: "ok" });
  e = await find(ev, (x) => x.kind === "review");
  checkS("event: review (Review row)", e?.collection === "reviews" && e?.row?.verdict === "comment" && e?.row?.branch === "feat/a");

  // ── worktrees ──
  await call("PUT", `/v1/monorepos/${O}/${M}/worktrees/wt_${id}`, A, { repo: "projects/web", branch: "feat/a", path: "projects/web/worktrees/feat-a", machine: "ana-mbp", agent: "agent-1", kind: "sparse" });
  e = await find(ev, (x) => x.kind === "worktree.reported");
  checkS("event: worktree.reported (Worktree row)", e?.collection === "worktrees" && e?.key === `wt_${id}` && e?.row?.agent === "agent-1");
  await call("DELETE", `/v1/monorepos/${O}/${M}/worktrees/wt_${id}`, A);
  e = await find(ev, (x) => x.kind === "worktree.removed");
  checkS("event: worktree.removed (op delete)", e?.op === "delete" && e?.key === `wt_${id}`);

  // ── a second branch, then merge the first ──
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "feat/b"], src);
  writeFileSync(join(src, "b.txt"), "b\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "Add b"], src);
  git(["push", "-q", url, "feat/b"], src, A);
  await find(ev, (x) => x.kind === "branch.opened" && x.row?.name === "feat/b");
  // feat/b's first facts (from its one-branch job) before the merge, so "last known" is defined.
  {
    const until = Date.now() + 30_000;

    while (Date.now() < until) {
      const b = (await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches?state=open`, A)).json?.branches?.find((x) => x.name === "feat/b");

      if (b && !b.stale) break;
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  // Lists go newest push first (feat/b was pushed after feat/a, though it sorts after it by name), one per page across the cursor.
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches?state=open&limit=1`, A);
  const page1 = r.json;
  r = page1?.next_cursor ? await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches?state=open&limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`, A) : null;
  const page2 = r?.json;
  check(
    "branches are listed newest push first, and the next page continues after the cursor",
    page1?.branches?.[0]?.name === "feat/b" && page2?.branches?.[0]?.name === "feat/a" && page2?.next_cursor === null,
    `${page1?.branches?.map((b) => b.name)} | ${page2?.branches?.map((b) => b.name)}`,
  );

  // The branch moved since the caller looked: a merge naming the older head is refused.
  const parentA = git(["rev-parse", "HEAD~1"], src).out.trim();
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa/merge`, A, { expected_head: parentA });
  check("a merge naming an older head is refused (409 head_moved)", r.status === 409 && r.json?.error?.code === "head_moved", `${r.status} ${r.json?.error?.code}`);
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa/merge`, A, { expected_head: "0".repeat(40) });
  check("and one naming a head the branch never had", r.status === 409 && r.json?.error?.code === "head_moved");
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa/merge`, A, { expected_head: headA }, { "x-pando-agent": "agent-1" });
  const mergeSha = r.json?.sha;
  check("merge feat/a (as agent-1)", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  e = await find(ev, (x) => x.kind === "merged");
  checkS("event: merged, with merge facts on the Branch row", e?.row?.state === "merged" && e?.row?.merge_commit === mergeSha && e?.row?.merged_by === `ana-${id}` && e?.row?.merged_machine === "ana-mbp" && e?.row?.merged_agent === "agent-1" && e?.row?.forced === false && !!e?.row?.merged_at, scrub(JSON.stringify(e?.row)).slice(0, 260));
  // These reads go back to back: the sweep's facts land about 0.3 s after a merge (git subprocesses wait until after them).
  const headsAfter = await call("GET", `/v1/monorepos/${O}/${M}/heads`, A);

  if (STREAM) {
    const latest = await call("GET", `/v1/monorepos/${O}/${M}/events?limit=1`, A);
    checkS("GET heads carries the stream's seq to resume from", headsAfter.json?.seq === latest.json?.seq, `${headsAfter.json?.seq} vs ${latest.json?.seq}`);
  }

  e = await find(ev, (x) => x.kind === "default_head.updated");
  checkS("event: default_head.updated to the merge commit", e?.row?.default_head === mergeSha);
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches?state=open`, A);
  const atOnce = r.json?.branches?.find((b) => b.name === "feat/b");
  check("right after the merge, the list answers at once with feat/b pending (last answer kept)", atOnce?.stale === true && atOnce?.mergeable === "pending" && atOnce?.last_mergeable === "clean", JSON.stringify({ m: atOnce?.mergeable, last: atOnce?.last_mergeable, stale: atOnce?.stale }));
  git(["fetch", "-q", url, "main"], src, A);
  const mergeTitle = git(["log", "-1", "--format=%s", mergeSha], src).out.trim();
  check("GET heads: main is the merge commit after a merge, head_title its title as git reads it", headsAfter.json?.heads?.[0]?.head === mergeSha && !!mergeTitle && headsAfter.json.heads[0].head_title === mergeTitle, `${JSON.stringify(headsAfter.json?.heads?.[0]?.head_title)} vs ${JSON.stringify(mergeTitle)}`);
  e = await find(ev, (x) => x.kind === "branch.updated" && x.row?.name === "feat/b" && x.partial === false && x.row?.behind === 3 && x.row?.stale === false);
  checkS("the queue's sweep publishes feat/b's full row (behind 3, mergeable, checks)", !!e && !!e.row?.mergeable && !!e.row?.checks, e ? `mergeable ${e.row.mergeable}` : "no event");

  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/feat%2Fa/commits`, A);
  check("a merged branch still lists its 2 commits", r.json?.commits?.length === 2 && r.json.commits[0].sha === headA, `${r.json?.commits?.length}`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches?state=merged`, A);
  const mb = r.json?.branches?.[0];
  check("GET listBranches has the merge facts too", mb?.merged_by === `ana-${id}` && mb?.merged_machine === "ana-mbp" && mb?.forced === false && mb?.merged_agent === "agent-1");

  // ── the meta layer: connections, saves, tree, references ──
  const meta = new WebSocket(`${WS_}/v1/monorepos/${O}/${M}/meta/socket`, { headers: { authorization: `Bearer ${A}` } });
  const metaFrames = [];
  meta.onmessage = (m) => metaFrames.push(JSON.parse(m.data));
  await waitFor(() => meta.readyState === 1, 10_000);
  meta.send(JSON.stringify({ type: "hello", since: 0, machine: "ana-mbp", agent: "agent-2", client: "events-test/1" }));
  await waitFor(() => metaFrames.find((f) => f.type === "caught_up"), 10_000);
  e = await find(ev, (x) => x.kind === "machine.connected");
  checkS("event: machine.connected carries the whole presence snapshot", e?.collection === "presence" && e?.key === "meta" && e?.row?.connections?.some((c) => c.machine === "ana-mbp" && c.agent === "agent-2" && c.client === "events-test/1" && !!c.connected_at) && e?.connection?.machine === "ana-mbp");
  r = await call("GET", `/v1/monorepos/${O}/${M}/meta/status`, A);
  check("meta/status lists who is connected now", r.json?.connections?.some((x) => x.machine === "ana-mbp" && x.agent === "agent-2"), JSON.stringify(r.json?.connections));
  const bytes = Buffer.from("# Notes\nhello\n");
  meta.send(JSON.stringify({ type: "save", id: "s1", path: "notes/today.md", base_version: 0, sha: blobSha(bytes), bytes: bytes.toString("base64") }));
  e = await find(ev, (x) => x.kind === "meta.saved" && x.key === "notes/today.md");
  checkS("event: meta.saved (history entry row, no bytes)", e?.collection === "meta_files" && e?.op === "upsert" && e?.row?.size === bytes.length && e?.row?.agent === "agent-2" && !("bytes" in (e?.row ?? {})), scrub(JSON.stringify(e)).slice(0, 220));
  r = await call("GET", `/v1/monorepos/${O}/${M}/meta/tree`, A);
  check("meta/tree lists the file in one call", r.json?.files?.some((f) => f.path === "notes/today.md" && f.size === bytes.length && f.version >= 1), `${r.status} ${(r.json?.files ?? []).map((f) => f.path).join(",")}`);
  // login beside the display name: on the event, the history and the tree
  checkS("meta.saved carries the saver's login beside the name", e?.row?.login === `ana-${id}` && (e?.row?.author ?? "").startsWith("Ana Lima"), `${e?.row?.login} / ${e?.row?.author}`);
  {
    // The home's line for that save names the person by login, as every other line does.
    const until = Date.now() + 10_000;
    let line = null;

    while (!line && Date.now() < until) {
      line = (await call("GET", `/v1/events?in=${O}/${M}&limit=50`, A)).json?.events?.find((x) => x.kind === "meta.saved" && x.summary?.path === "notes/today.md") ?? null;

      if (!line) await sleep(200);
    }

    checkS("the home's meta.saved line has the saver's login as actor", line?.actor === `ana-${id}`, `${line?.actor}`);
  }

  const v1 = (await waitFor(() => metaFrames.find((f) => f.type === "accepted" && f.id === "s1"), 10_000))?.version;
  r = await call("GET", `/v1/monorepos/${O}/${M}/meta/history?path=notes/today.md`, A);
  check("meta history entries carry login", r.json?.versions?.[0]?.login === `ana-${id}`, JSON.stringify(r.json?.versions?.[0]?.login));
  // a second file and folder, so each folder's last change is its own
  const plan = Buffer.from("plan\n");
  meta.send(JSON.stringify({ type: "save", id: "s2", path: "plans/q4/plan.md", base_version: 0, sha: blobSha(plan), bytes: plan.toString("base64") }));
  const v2 = (await waitFor(() => metaFrames.find((f) => f.type === "accepted" && f.id === "s2"), 10_000))?.version;
  r = await call("GET", `/v1/monorepos/${O}/${M}/meta/tree?dir=`, A);
  const fNotes = r.json?.folders?.find((f) => f.name === "notes");
  const fPlans = r.json?.folders?.find((f) => f.name === "plans");
  check("meta/tree?dir= gives each folder its last change (who, what, when, version)", fNotes?.files === 1 && fNotes?.last?.version === v1 && fNotes?.last?.path === "notes/today.md" && fNotes?.last?.login === `ana-${id}` && Number.isInteger(fNotes?.last?.at) && fPlans?.last?.version === v2 && fPlans?.last?.path === "plans/q4/plan.md", JSON.stringify(r.json?.folders));

  // the root raw route: a monorepo's own file, now and at a version
  const rawGet = async (path, secret, headers = {}) => {
    const res = await fetch(`${URL_}/${O}/${M}/raw/${path}`, { headers: { authorization: `Bearer ${secret}`, ...headers } });

    return { status: res.status, headers: res.headers, text: await res.text() };
  };

  let raw = await rawGet("notes/today.md", A);
  const etagOk = (h) => (h ?? "").replace(/^W\//, "") === `"${blobSha(bytes)}"`;
  check("root raw: a meta file's bytes, as text, sandboxed, ETag the blob sha", raw.status === 200 && raw.text === bytes.toString() && raw.headers.get("content-type")?.startsWith("text/plain") && /sandbox/.test(raw.headers.get("content-security-policy") ?? "") && raw.headers.get("x-content-type-options") === "nosniff" && etagOk(raw.headers.get("etag")) && raw.headers.get("cache-control") === "private, no-cache", `${raw.status} ${raw.headers.get("etag")} ${raw.headers.get("cache-control")}`);
  const raw304 = await rawGet("notes/today.md", A, { "if-none-match": raw.headers.get("etag") });
  check("root raw: a repeat with If-None-Match is a 304", raw304.status === 304, `${raw304.status}`);
  const edited = Buffer.from("# Notes\nhello again\n");
  meta.send(JSON.stringify({ type: "save", id: "s3", path: "notes/today.md", base_version: v1, sha: blobSha(edited), bytes: edited.toString("base64") }));
  await waitFor(() => metaFrames.find((f) => f.type === "accepted" && f.id === "s3"), 10_000);
  raw = await rawGet("notes/today.md", A);
  const rawV1 = await rawGet(`notes/today.md?v=${v1}`, A);
  const rawV2 = await rawGet(`notes/today.md?v=${v2}`, A);
  check("root raw: now is the new bytes; ?v= is the file as of that version, cached a year", raw.text === edited.toString() && rawV1.text === bytes.toString() && rawV2.text === bytes.toString() && rawV1.headers.get("cache-control") === "private, max-age=31536000, immutable", `${rawV1.status} ${rawV1.headers.get("cache-control")}`);
  const before = await rawGet(`plans/q4/plan.md?v=${v1}`, A);
  const badV = await rawGet("notes/today.md?v=x", A);
  const none = await rawGet("notes/none.md", A);
  const outsiderRaw = await rawGet("notes/today.md", B);
  check("root raw: 404 before a file existed or when absent, 400 for a bad v, 403 for a non-member", before.status === 404 && none.status === 404 && badV.status === 400 && outsiderRaw.status === 403, `${before.status} ${none.status} ${badV.status} ${outsiderRaw.status}`);
  // a large file: its pointer in the meta layer, its bytes in R2
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`pando-${id}`)]);
  const oid = createHash("sha256").update(png).digest("hex");
  const put = await fetch(`${URL_}/v1/monorepos/${O}/${M}/meta/blobs/${oid}`, { method: "PUT", headers: { authorization: `Bearer ${A}`, "content-length": String(png.length) }, body: png });
  const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${png.length}\n`);
  meta.send(JSON.stringify({ type: "save", id: "s4", path: "art/logo.png", base_version: 0, sha: blobSha(pointer), bytes: pointer.toString("base64") }));
  await waitFor(() => metaFrames.find((f) => f.id === "s4"), 10_000);
  const big = await fetch(`${URL_}/${O}/${M}/raw/art/logo.png`, { headers: { authorization: `Bearer ${A}` } });
  const bigBytes = Buffer.from(await big.arrayBuffer());
  check("root raw: a large file comes from R2, as an image, ETag its SHA-256", put.status === 201 && big.status === 200 && bigBytes.equals(png) && big.headers.get("content-type") === "image/png" && (big.headers.get("etag") ?? "").replace(/^W\//, "") === `"${oid}"`, `${put.status} ${big.status} ${big.headers.get("content-type")} ${bigBytes.length} bytes`);
  meta.close();
  e = await find(ev, (x) => x.kind === "machine.disconnected");
  checkS("event: machine.disconnected, its snapshot without that socket", e?.collection === "presence" && Array.isArray(e?.row?.connections) && !e.row.connections.some((c) => c.id === e.connection?.id));

  // references arrive through a reviewed merge into the meta layer (.pando/** is protected)
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/meta`, A);
  const metaUrl = r.json?.clone_url;
  const mdir = join(work, "meta");
  mkdirSync(mdir);
  git(["init", "-q"], mdir);
  writeFileSync(join(mdir, "AGENTS.md"), "# meta\n");
  git(["add", "-A"], mdir);
  git(["commit", "-qm", "root"], mdir);
  git(["push", "-q", metaUrl, "main"], mdir, A);
  git(["checkout", "-qb", "ref"], mdir);
  mkdirSync(join(mdir, ".pando/references/research/infra"), { recursive: true });
  writeFileSync(join(mdir, ".pando/references/research/infra/oak.toml"), 'url = "https://github.com/example/oak.git"\nref = "refs/heads/main"\ncommit = "0123456789abcdef0123456789abcdef01234567"\n');
  git(["add", "-A"], mdir);
  git(["commit", "-qm", "Add a reference"], mdir);
  git(["push", "-q", metaUrl, "ref"], mdir, A);
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/meta/branches/ref/merge`, A);
  check("merge a reference pointer into the meta layer", r.status === 200, `${r.status} ${r.json?.error?.code ?? ""}`);
  e = await find(ev, (x) => x.kind === "meta.saved" && x.key === ".pando/references/research/infra/oak.toml");
  checkS("event: meta.saved for the merged pointer (source main)", e?.row?.source === "main");
  checkS("a version merged on main carries the merger's login", e?.row?.login === `ana-${id}`, JSON.stringify(e?.row?.login));
  r = await call("GET", `/v1/monorepos/${O}/${M}/meta/references`, A);
  const ref = r.json?.references?.[0];
  check("meta/references lists it, parsed", ref?.path === "research/infra/oak" && ref?.url === "https://github.com/example/oak.git" && ref?.commit === "0123456789abcdef0123456789abcdef01234567", JSON.stringify(r.json));
  r = await call("GET", `/v1/monorepos/${O}/${M}/meta/tree?prefix=.pando/references/`, A);
  check("meta/tree?prefix= narrows to the references", r.json?.files?.length === 1);

  if (!STREAM) {
    r = await call("GET", `/v1/monorepos/${O}/${M}/events`, A);
    check("GET events answers 501 event_stream_on_hold while the stream is off", r.status === 501 && r.json?.error?.code === "event_stream_on_hold");
  }

  // ── reading back: JSON pages, replay, resync ──
  if (STREAM) {
  r = await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500`, A);
  const all = r.json?.events ?? [];
  const seqsOk = all.every((x, i) => i === 0 || x.seq > all[i - 1].seq);
  checkS("GET events?since=0 returns every event in order", r.status === 200 && all.length >= 12 && seqsOk && r.json?.seq === all[all.length - 1]?.seq && r.json?.oldest_seq === all[0]?.seq, `${all.length} events, seq ${r.json?.seq}`);
  const live = eventsOf(ev);
  checkS("the socket got the same events as the JSON page", live.length === all.length && live.every((x, i) => x.seq === all[i].seq), `${live.length} vs ${all.length}`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/events?limit=1`, A);
  checkS("GET events?limit=1 is the latest event (last activity)", r.json?.events?.length === 1 && r.json.events[0].seq === all[all.length - 1].seq);
  // The pull's repo=, kinds= and before= (C4), in SQL on their indexes.
  const page = async (q) => (await call("GET", `/v1/monorepos/${O}/${M}/events?${q}`, A)).json?.events ?? [];
  const sameSeqs = (a, b) => a.length === b.length && a.every((x, i) => x.seq === b[i].seq);
  const ofRepo = all.filter((x) => x.repo === repo);
  checkS("events?repo= is that repo's events, in order", ofRepo.length > 0 && ofRepo.length < all.length && sameSeqs(await page(`since=0&limit=500&repo=${repo}`), ofRepo), `${ofRepo.length} of ${all.length}`);
  const ofKinds = all.filter((x) => x.kind === "status" || x.kind === "merged");
  checkS("events?kinds=status,merged is those kinds only", ofKinds.length > 0 && sameSeqs(await page("since=0&limit=500&kinds=status,merged"), ofKinds), `${ofKinds.length}`);
  const cut = all[10].seq;
  const back = await page(`before=${cut}&limit=4`);
  const back2 = await page(`before=${back[0]?.seq}&limit=4`);
  checkS("events?before= pages back: the 4 before a seq, oldest first, then the 4 before those", sameSeqs(back, all.slice(6, 10)) && sameSeqs(back2, all.slice(2, 6)), `${back.map((x) => x.seq).join(",")} | ${back2.map((x) => x.seq).join(",")}`);
  const both = all.filter((x) => x.repo === repo && x.kind === "push" && x.seq < all[all.length - 1].seq).slice(-2);
  checkS("repo=, kinds= and before= together", both.length > 0 && sameSeqs(await page(`repo=${repo}&kinds=push&before=${all[all.length - 1].seq}&limit=2`), both), `${both.length}`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/events?before=0`, A);
  const r2 = await call("GET", `/v1/monorepos/${O}/${M}/events?kinds=Bad%20Kind`, A);
  check("a bad before= or kinds= answers 400", r.status === 400 && r2.status === 400, `${r.status} ${r2.status}`);
  const mid = all[Math.floor(all.length / 2)].seq;
  const again = openEvents(M, A, mid);
  sockets.push(again);
  await waitFor(() => again.frames.find((f) => f.type === "caught_up"));
  const replay = eventsOf(again);
  checkS("a socket opened with ?since= replays what it missed, then caught_up", replay.length === all.filter((x) => x.seq > mid).length && replay[0]?.seq === mid + 1, `${replay.length} replayed`);
  const mains = all.filter((x) => x.collection === "default_heads");
  const gotMain = eventsOf(mainOnly);
  checkS("a socket on ?topics=main gets only main moves, all of them", gotMain.length === mains.length && gotMain.every((x) => x.collection === "default_heads"), `${gotMain.length} of ${mains.length}`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&topics=main`, A);
  checkS("GET events?topics=main filters the same way", r.json?.events?.length === mains.length);
  const future = openEvents(M, A, all[all.length - 1].seq + 1000);
  sockets.push(future);
  const rs = await waitFor(() => future.frames.find((f) => f.type === "resync"));
  checkS("a ?since= ahead of the stream gets resync, with the stream's seq", rs?.seq === all[all.length - 1].seq && Number.isInteger(rs?.oldest_seq));

  for (const s of [ev, again, future, mainOnly]) s.ws.close();
  }
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const s of sockets) {
    try {
      s.ws.close();
    } catch {}
  }

  for (const m of made) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${m}?confirm=${O}/${m}`, A);
    check(`delete ${m}`, r.status === 204, `${r.status}`);
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed${skipped ? `, ${skipped} skipped (stream on hold)` : ""}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
