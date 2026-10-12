// Artifacts on a branch's page, end to end against `wrangler dev` with real Artifacts, Durable Objects and R2
// (research/plans/artifacts-2026-10-12/SPEC.md):
//   1. upload: a Markdown plan, an HTML page with its images (one artifact), an image alone; the same name again
//      is the next version, every version kept; the bytes in R2 with their SHA-256; a branch with '/' in its name;
//   2. reads: the list with counts, one artifact with every version, a file's bytes under the sandbox policy, the
//      document with its images written in as data: addresses;
//   3. the limits, each with its clear error: 10 MiB in all, 1.5 MiB for the document, 20 files, 100 artifacts on
//      a branch, names and paths, 500 threads on a version, 100 replies, 10 people named, a 16 KiB anchor;
//   4. comments: Plannotator's anchor stored as written, a quote as its external annotation, replies one level
//      deep, @mentions (members only), edit with base_version, resolve and reopen by any member, delete your own
//      (a root with replies keeps its place), the branch's All files, an Idempotency-Key;
//   5. events on the monorepo's stream for each change; 6. delete by any member (bytes and comments go);
//   7. a branch made again starts with no artifacts; 8. people who are not members are refused.
//
//   PANDO_URL=http://localhost:8883 node test/artifacts.mjs
//
// Reads PANDO_BOOTSTRAP from worker/.dev.vars; credentials are never printed. Git runs with a temp HOME, no system
// config and an empty credential helper list before its own. Every repository it makes is deleted at the end.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, isConnectionReset, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8883").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const RECORDED = new URL("../../packages/contract/recorded/", import.meta.url);

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>");

/** A real answer, for the contract's check (packages/contract/scripts/check-recorded.ts). */
const record = (file, schema, route, status, body) => writeFileSync(new URL(file, RECORDED), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`));
};

const call = (method, path, secret, body, headers = {}) =>
  request(URL_, method, path, { secret, body, headers }).catch((err) => {
    if (!isConnectionReset(err)) throw err;

    return request(URL_, method, path, { secret, body, headers });
  });

/** A multipart upload: `files` is [field, name, bytes, type]. fetch sets the multipart type and the length. */
async function upload(path, secret, files) {
  const form = new FormData();

  for (const [field, name, bytes, type] of files) form.append(field, new Blob([bytes], { type }), name);

  const send = async () => {
    const res = await fetch(URL_ + path, { method: "POST", body: form, headers: { authorization: `Bearer ${secret}` } });
    const text = await res.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {}

    return { status: res.status, text, json, headers: res.headers };
  };

  return send().catch((err) => {
    if (!isConnectionReset(err)) throw err;

    return send();
  });
}

const waitFor = async (pred, ms = 15_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }

  return null;
};

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

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** In batches, so the dev server is not flooded. */
async function batches(n, size, fn) {
  const out = [];

  for (let i = 0; i < n; i += size) out.push(...(await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, k) => fn(i + k)))));

  return out;
}

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#8a6a48"/></svg>');

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-artifacts-"));

const home = join(work, "home");

mkdirSync(home);

const M = `art-${id}`;

let S = null;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Art", GIT_AUTHOR_EMAIL: "art@pando.invalid", GIT_COMMITTER_NAME: "Art", GIT_COMMITTER_EMAIL: "art@pando.invalid",
};

// The keychain rule (AGENTS.md): no system config, the helper list emptied, then this one helper.
const git = (args, cwd) =>
  spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { ...env, PANDO_SECRET: S }, encoding: "utf8",
  });

try {
  const login = `art-${id}`;
  S = (await call("POST", "/v1/users", BOOT, { login })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  const O = r.json?.monorepo?.owner ?? null;

  if (r.status === 201) tw.add(`${O}/${M}`);
  const url = r.json?.repos?.[0]?.clone_url;
  const mono = `/v1/monorepos/${O}/${M}`;
  const base = `${mono}/repos/${M}`;
  check("a plain repository made", r.status === 201 && !!url);

  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# art\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("main pushed", git(["push", "-q", url, "main"], src).status === 0);
  const BR = "feat/refresh-margin";
  r = await call("POST", `${base}/branches`, S, { name: BR, from: "main" });
  check("a branch with '/' in its name", r.status === 201, r.text.slice(0, 160));
  const arts = `${base}/branches/${encodeURIComponent(BR)}/artifacts`;

  // A second member, and a person who is not one.
  const bo = `art-b-${id}`;
  const B = (await call("POST", "/v1/users", BOOT, { login: bo })).json?.credential?.secret;
  r = await call("PUT", `${mono}/members/${bo}`, S, { role: "member" });
  check("a second person, a member (not an owner)", r.status === 200 && !!B);
  const X = (await call("POST", "/v1/users", BOOT, { login: `art-x-${id}` })).json?.credential?.secret;

  const sock = socket(`${mono}/events?topics=repo:${M}`, S);
  await waitFor(() => sock.frames.some((f) => f.type === "caught_up"), 10_000);

  // ── 1. Upload ──
  r = await call("GET", arts, S);
  check("a branch with no artifacts lists none", r.status === 200 && r.json?.branch === BR && r.json.artifacts.length === 0 && r.json.total === 0);

  const plan1 = "# Refresh the margin\n\nThe plan, first draft.\n\n![the chart](img/chart.png)\n\nShip it on Tuesday.\n";
  r = await upload(arts, S, [["file", "refresh-plan.md", plan1, "text/markdown"], ["image", "img/chart.png", PNG, "image/png"]]);
  const plan = r.json;
  check(
    "a Markdown plan with its image is one artifact (201): kind, title, v1, both files with their SHA-256, from the CLI",
    r.status === 201 && /^art_[0-9a-f]{16}$/.test(plan?.id) && plan.kind === "markdown" && plan.title === "Refresh the margin" && plan.latest.n === 1 && plan.versions === 1 &&
      plan.latest.files.map((f) => f.path).join() === "refresh-plan.md,img/chart.png" && plan.latest.sha256 === sha256(plan1) && plan.latest.files[1].sha256 === sha256(PNG) &&
      plan.latest.size === Buffer.byteLength(plan1) + PNG.length && plan.latest.via === "cli" && plan.latest.uploaded_by === login && plan.repo === M && plan.branch === BR,
    r.text.slice(0, 300),
  );
  record("artifact-added.json", "Artifact", "POST .../branches/{branch}/artifacts (a new name)", r.status, r.json);

  const plan2 = "# Refresh the margin\n\nThe plan, second draft.\n\n![the chart](./img/chart.png)\n\nShip it on Wednesday.\n";
  r = await upload(arts, S, [["file", "refresh-plan.md", plan2, "text/markdown"], ["image", "img/chart.png", PNG, "image/png"]]);
  check("the same name again is its next version (200): v2, two versions", r.status === 200 && r.json?.id === plan?.id && r.json.latest.n === 2 && r.json.versions === 2 && r.json.latest.sha256 === sha256(plan2));
  record("artifact-versioned.json", "Artifact", "POST .../branches/{branch}/artifacts (the same name: its next version)", r.status, r.json);

  const page = '<!doctype html><html><head><title>Banner &amp; hero</title></head><body><h1>Banner</h1><img src="img/hero.png"><img src="./icons/dot.svg" alt="dot"><script>alert(1)</script></body></html>';
  r = await upload(arts, B, [["file", "banner.html", page, "text/html"], ["image", "img/hero.png", PNG, "image/png"], ["image", "icons/dot.svg", SVG, "image/svg+xml"]]);
  const banner = r.json;
  check("an HTML page with its two images is one artifact, by the second member", r.status === 201 && banner?.kind === "html" && banner.title === "Banner & hero" && banner.latest.files.length === 3 && banner.created_by === bo);

  r = await upload(arts, S, [["file", "screenshot.png", PNG, "image/png"]]);
  const shot = r.json;
  check("an image alone is an image artifact, with no title", r.status === 201 && shot?.kind === "image" && shot.title === null && shot.latest.files.length === 1);

  // ── 2. Reads ──
  r = await call("GET", arts, S);
  check("the list: three artifacts, newest first, each with its newest version", r.status === 200 && r.json?.total === 3 && r.json.artifacts.map((a) => a.name).join() === "screenshot.png,banner.html,refresh-plan.md" && r.json.artifacts[2].latest.n === 2);
  record("artifacts.json", "ArtifactList", "GET .../branches/{branch}/artifacts", r.status, r.json);

  r = await call("GET", `${mono}/artifacts/${plan.id}`, S);
  check("one artifact with every version, oldest first", r.status === 200 && r.json?.all_versions?.map((v) => v.n).join() === "1,2" && r.json.all_versions[0].sha256 === sha256(plan1));
  record("artifact.json", "ArtifactDetail", "GET .../artifacts/{id}", r.status, r.json);

  let res = await fetch(`${URL_}${mono}/artifacts/${plan.id}/versions/1/files/refresh-plan.md`, { headers: { authorization: `Bearer ${S}` } });
  let text = await res.text();
  check("v1's document is still there, as it was", res.status === 200 && text === plan1 && res.headers.get("x-pando-sha256") === sha256(plan1));
  res = await fetch(`${URL_}${mono}/artifacts/${banner.id}/versions/1/files/banner.html`, { headers: { authorization: `Bearer ${S}` } });
  check("a file is served under the sandbox policy, its type from its name", res.status === 200 && res.headers.get("content-security-policy") === "sandbox; default-src 'none'" && res.headers.get("content-type")?.startsWith("text/html") && res.headers.get("x-content-type-options") === "nosniff");
  res = await fetch(`${URL_}${mono}/artifacts/${banner.id}/versions/1/files/img/hero.png`, { headers: { authorization: `Bearer ${S}` } });
  check("an image by its path", res.status === 200 && res.headers.get("content-type") === "image/png" && Buffer.from(await res.arrayBuffer()).equals(PNG));
  res = await fetch(`${URL_}${mono}/artifacts/${banner.id}/versions/1/document`, { headers: { authorization: `Bearer ${S}` } });
  text = await res.text();
  check(
    "the HTML document has its images written in as data: addresses (the frame cannot fetch from Pando)",
    res.status === 200 && text.includes(`src="data:image/png;base64,${PNG.toString("base64")}"`) && text.includes(`src="data:image/svg+xml;base64,${SVG.toString("base64")}"`) && !text.includes("img/hero.png") &&
      res.headers.get("content-security-policy") === "sandbox; default-src 'none'",
  );
  res = await fetch(`${URL_}${mono}/artifacts/${plan.id}/versions/2/document`, { headers: { authorization: `Bearer ${S}` } });
  text = await res.text();
  check("so does the Markdown, for its ./ path", res.status === 200 && text.includes(`](data:image/png;base64,${PNG.toString("base64")})`) && text.startsWith("# Refresh the margin"));
  res = await fetch(`${URL_}${mono}/artifacts/${plan.id}/versions/3/document`, { headers: { authorization: `Bearer ${S}` } });
  check("a version that does not exist is a 404", res.status === 404);

  // ── 3. The limits ──
  const MiB = 1024 * 1024;
  r = await upload(arts, S, [["file", "big.md", "#".repeat(1.5 * MiB + 1), "text/markdown"]]);
  check("a document over 1.5 MiB is refused (413), saying so", r.status === 413 && r.json?.error?.code === "too_large" && /at most 1\.5 MiB/.test(r.json.error.message), r.json?.error?.message);
  record("error-413-artifact-document.json", "ErrorBody", "POST .../branches/{branch}/artifacts (a document over 1.5 MiB)", r.status, r.json);
  r = await upload(arts, S, [["file", "heavy.md", "# heavy\n", "text/markdown"], ...Array.from({ length: 6 }, (_, i) => ["image", `img/${i}.png`, Buffer.alloc(2 * MiB, i), "image/png"])]);
  check("an artifact over 10 MiB in all is refused (413), with its size", r.status === 413 && /at most 10 MiB in all; this upload is 12/.test(r.json?.error?.message ?? ""), r.json?.error?.message);
  r = await upload(arts, S, [["file", "many.md", "# many\n", "text/markdown"], ...Array.from({ length: 20 }, (_, i) => ["image", `img/${i}.png`, PNG, "image/png"])]);
  check("21 files are refused: at most 20", r.status === 400 && r.json?.error?.code === "too_many_files");
  r = await upload(arts, S, [["file", "notes.txt", "hi", "text/plain"]]);
  check("a kind Pando does not take is refused", r.status === 400 && /\.md or \.markdown/.test(r.json?.error?.message ?? ""));
  r = await upload(arts, S, [["file", "bad name.md", "# x", "text/markdown"]]);
  check("a name with a space is refused", r.status === 400);
  r = await upload(arts, S, [["file", "up.md", "# x", "text/markdown"], ["image", "../secret.png", PNG, "image/png"]]);
  check("an image path with '..' is refused", r.status === 400);
  r = await upload(arts, S, [["file", "shot2.png", PNG, "image/png"], ["image", "x.png", PNG, "image/png"]]);
  check("an image artifact takes no other files", r.status === 400);

  const FULL = "full";
  await call("POST", `${base}/branches`, S, { name: FULL, from: "main" });
  const fullArts = `${base}/branches/${FULL}/artifacts`;
  const made = await batches(100, 10, (i) => upload(fullArts, S, [["file", `a${i}.png`, PNG, "image/png"]]));
  r = await upload(fullArts, S, [["file", "one-more.png", PNG, "image/png"]]);
  check("100 artifacts on a branch, and the 101st refused (409)", made.every((x) => x.status === 201) && r.status === 409 && r.json?.error?.code === "too_many_artifacts", `${made.filter((x) => x.status === 201).length} made`);
  record("error-409-too-many-artifacts.json", "ErrorBody", "POST .../branches/{branch}/artifacts (the 101st)", r.status, r.json);
  r = await upload(fullArts, S, [["file", "a0.png", PNG, "image/png"]]);
  check("a full branch still takes a new version of one it has", r.status === 200 && r.json?.latest?.n === 2);

  // ── 4. Comments ──
  const comments = `${mono}/artifacts/${plan.id}/comments`;

  const anchor = {
    type: "COMMENT", originalText: "Ship it on Wednesday", blockId: "block-3", startOffset: 0, endOffset: 20,
    startMeta: { parentTagName: "P", parentIndex: 3, textOffset: 0 }, endMeta: { parentTagName: "P", parentIndex: 3, textOffset: 20 },
    context: { prefix: "the chart\n\n", suffix: "." },
  };

  r = await call("POST", comments, B, { version: 2, anchor, body: `Wednesday clashes with the freeze. @${login} can we move it? @nobody-here` });
  const t1 = r.json;
  check(
    "a comment on words: Plannotator's anchor stored as written, the member named recorded (not a stranger's word)",
    r.status === 201 && /^ac_[0-9a-f]{16}$/.test(t1?.id) && t1.thread === t1.id && t1.in_reply_to === null && JSON.stringify(t1.anchor) === JSON.stringify(anchor) &&
      t1.version === 2 && t1.state === "open" && t1.author === bo && t1.mentions.join() === login && t1.body_version === 1,
    r.text.slice(0, 300),
  );
  record("artifact-comment.json", "ArtifactComment", "POST .../artifacts/{id}/comments", r.status, r.json);

  r = await call("POST", comments, S, { quote: "second draft", body: "Is this the last draft?" }, { "Idempotency-Key": `q-${id}` });
  const t2 = r.json;
  check("a quote from the CLI is stored as Plannotator's external annotation on the newest version", r.status === 201 && t2?.version === 2 && t2.anchor?.type === "COMMENT" && t2.anchor.originalText === "second draft" && t2.anchor.blockId === "external");
  r = await call("POST", comments, S, { quote: "second draft", body: "Is this the last draft?" }, { "Idempotency-Key": `q-${id}` });
  check("the same Idempotency-Key answers the same comment (200, replayed)", r.status === 200 && r.json?.id === t2?.id && r.headers.get("pando-replayed") === "true");

  r = await call("POST", comments, S, { version: 1, body: "On the whole plan: fine." });
  const t3 = r.json;
  check("a comment on the whole artifact, on v1", r.status === 201 && t3?.anchor === null && t3.version === 1);

  r = await call("POST", comments, S, { in_reply_to: t1.id, body: "Yes, Thursday then." });
  const reply = r.json;
  check("a reply: in its thread, on the root's version", r.status === 201 && reply?.thread === t1.id && reply.in_reply_to === t1.id && reply.version === 2 && reply.anchor === null);
  r = await call("POST", comments, B, { in_reply_to: reply.id, body: "Thursday works." });
  check("a reply to a reply is in the same thread, one level deep", r.status === 201 && r.json?.in_reply_to === t1.id && r.json.thread === t1.id);
  r = await call("POST", comments, S, { in_reply_to: t1.id, quote: "x", body: "no" });
  check("a reply takes no anchor", r.status === 400);

  r = await call("PATCH", `${mono}/artifact-comments/${t1.id}`, S, { body: "edited by someone else" });
  check("only its author edits a comment", r.status === 403 && r.json?.error?.code === "not_author");
  r = await call("PATCH", `${mono}/artifact-comments/${t1.id}`, B, { body: "Wednesday clashes with the freeze.", base_version: 1 });
  check("its author edits it; the version goes up and the mention goes", r.status === 200 && r.json?.body_version === 2 && r.json.mentions.length === 0);
  r = await call("PATCH", `${mono}/artifact-comments/${t1.id}`, B, { body: "stale", base_version: 1 });
  check("an edit from a stale version is refused with the comment as it is now", r.status === 409 && r.json?.error?.code === "edited" && r.json.error.current?.body_version === 2);
  record("error-409-artifact-comment-edited.json", "ErrorBody", "PATCH .../artifact-comments/{id} (a stale base_version)", r.status, r.json);

  r = await call("PATCH", `${mono}/artifact-comments/${reply.id}`, S, { state: "resolved" });
  check("any member resolves a thread (from a reply: its root)", r.status === 200 && r.json?.id === t1.id && r.json.state === "resolved" && r.json.resolved_by === login);
  record("artifact-comment-resolved.json", "ArtifactComment", "PATCH .../artifact-comments/{id} {state: resolved}", r.status, r.json);

  r = await call("GET", `${comments}?state=open`, S);
  check("open threads leave the resolved one out; the counts are of all", r.status === 200 && r.json?.threads?.map((t) => t.id).join() === `${t2.id},${t3.id}` && r.json.counts.open === 2 && r.json.counts.resolved === 1);
  r = await call("GET", comments, S);
  const th1 = r.json?.threads?.find((t) => t.id === t1.id);
  check("every thread, its replies oldest first", r.status === 200 && r.json?.threads?.length === 3 && th1?.replies?.length === 2 && th1.replies[0].id === reply.id);
  record("artifact-threads.json", "ArtifactThreads", "GET .../artifacts/{id}/comments", r.status, r.json);
  r = await call("PATCH", `${mono}/artifact-comments/${t1.id}`, B, { state: "open" });
  check("reopened", r.status === 200 && r.json?.state === "open" && r.json.resolved_by === null);

  r = await call("POST", `${mono}/artifacts/${banner.id}/comments`, S, {
    anchor: { type: "COMMENT", originalText: "Banner", htmlAnchor: { selector: "h1", tagName: "H1", text: "Banner" }, htmlAdditionalTargets: [] },
    body: "Bigger, please.",
  });
  check("a pinpoint on an HTML element", r.status === 201 && r.json?.anchor?.htmlAnchor?.selector === "h1");
  r = await call("POST", `${mono}/artifacts/${banner.id}/comments`, S, { anchor: { type: "COMMENT", htmlAnchor: { selector: "h1", tagName: "H1" }, htmlAdditionalTargets: Array(17).fill({ selector: "p", tagName: "P" }) }, body: "x" });
  check("more than 16 extra HTML elements are refused", r.status === 400);
  r = await call("POST", `${mono}/artifacts/${banner.id}/comments`, S, { anchor: { type: "COMMENT", originalText: "x".repeat(16_400) }, body: "x" });
  check("an anchor over 16,384 bytes is refused (413)", r.status === 413 && /16,384 bytes/.test(r.json?.error?.message ?? ""));
  r = await call("POST", `${mono}/artifacts/${banner.id}/comments`, S, { body: "x".repeat(65_537) });
  check("a comment over 65,536 characters is refused (413)", r.status === 413);

  r = await call("GET", `${base}/branches/${encodeURIComponent(BR)}/artifact-comments`, S);
  check("the branch's All files: every artifact's threads", r.status === 200 && r.json?.threads?.length === 4 && new Set(r.json.threads.map((t) => t.artifact)).size === 2 && r.json.counts.open === 4);
  record("artifact-threads-branch.json", "ArtifactThreads", "GET .../branches/{branch}/artifact-comments", r.status, r.json);
  r = await call("GET", arts, S);
  check("the list counts each artifact's open threads", r.json?.artifacts?.find((a) => a.id === plan.id)?.comments?.open === 3);

  // Delete your own: a root with replies keeps its place, its body gone; it goes with its last reply.
  r = await call("DELETE", `${mono}/artifact-comments/${t1.id}`, S);
  check("only its author deletes a comment", r.status === 403);
  r = await call("DELETE", `${mono}/artifact-comments/${t1.id}`, B);
  r = await call("GET", `${mono}/artifact-comments/${t1.id}`, S);
  check("a root with replies keeps its place with its body gone", r.status === 200 && r.json?.body === null);
  const replies = (await call("GET", comments, S)).json?.threads?.find((t) => t.id === t1.id)?.replies ?? [];

  for (const x of replies) await call("DELETE", `${mono}/artifact-comments/${x.id}`, x.author === login ? S : B);
  r = await call("GET", `${mono}/artifact-comments/${t1.id}`, S);
  check("once its last reply is deleted, the deleted root goes too", r.status === 404 && replies.length === 2);

  // Mentions past 10, replies past 100, threads past 500.
  const people = await batches(11, 11, async (i) => {
    const l = `art-p${i}-${id}`;
    await call("POST", "/v1/users", BOOT, { login: l });
    await call("PUT", `${mono}/members/${l}`, S, { role: "member" });

    return l;
  });

  r = await call("POST", comments, S, { body: people.map((l) => `@${l}`).join(" ") });
  check("a comment naming 11 members is refused: at most 10", r.status === 400 && r.json?.error?.code === "too_many_mentions");
  r = await call("POST", comments, S, { body: people.slice(0, 10).map((l) => `@${l}`).join(" ") });
  check("10 are recorded", r.status === 201 && r.json?.mentions?.length === 10);

  const shotComments = `${mono}/artifacts/${shot.id}/comments`;
  const root = (await call("POST", shotComments, S, { body: "A whole-image comment." })).json;
  const rs = await batches(100, 20, (i) => call("POST", shotComments, S, { in_reply_to: root.id, body: `reply ${i}` }));
  r = await call("POST", shotComments, S, { in_reply_to: root.id, body: "one more" });
  check("100 replies in a thread, and the 101st refused (409)", rs.every((x) => x.status === 201) && r.status === 409 && r.json?.error?.code === "too_many_replies");
  const ts = await batches(499, 25, (i) => call("POST", shotComments, S, { body: `thread ${i}` }));
  r = await call("POST", shotComments, S, { body: "the 501st" });
  check("500 threads on a version, and the 501st refused (409)", ts.every((x) => x.status === 201) && r.status === 409 && r.json?.error?.code === "too_many_threads", `${ts.filter((x) => x.status === 201).length} made`);

  // ── 5. Events ──
  const kinds = await waitFor(() => {
    const k = new Set(sock.events().map((e) => e.kind));

    return ["artifact.added", "artifact.versioned", "artifact_comment.added", "artifact_comment.edited", "artifact_comment.resolved", "artifact_comment.reopened", "artifact_comment.deleted"].every((x) => k.has(x)) && k;
  });

  check("every change is on the stream (added, versioned, comment added, edited, resolved, reopened, deleted)", !!kinds, [...(kinds || [])].filter((k) => k.startsWith("artifact")).join());
  const added = sock.events().find((e) => e.kind === "artifact.added" && e.row?.id === plan.id);
  check("an event names its branch and who did it, with the row as the API answers it", added?.branch === BR && added.actor === login && added.row.latest.n === 1 && added.collection === "artifacts");

  // ── 6. Delete: any member ──
  r = await call("DELETE", `${mono}/artifacts/${plan.id}`, B);
  check("any member deletes an artifact (204)", r.status === 204);
  record("artifact-deleted.json", "NoContent", "DELETE .../artifacts/{id}", r.status, null);
  r = await call("GET", `${mono}/artifacts/${plan.id}`, S);
  res = await fetch(`${URL_}${mono}/artifacts/${plan.id}/versions/1/files/refresh-plan.md`, { headers: { authorization: `Bearer ${S}` } });
  check("it is gone, with its versions", r.status === 404 && res.status === 404);
  r = await call("GET", `${mono}/artifact-comments/${t2.id}`, S);
  check("and its comments", r.status === 404);
  check("artifact.deleted on the stream", !!(await waitFor(() => sock.events().some((e) => e.kind === "artifact.deleted" && e.row?.id === plan.id))));
  record(
    "artifact-event-frames.json", "MonorepoEventFrame[]", "GET .../events?topics=repo:{repo} (WebSocket), artifact kinds",
    101, [...new Map(sock.events().filter((e) => e.kind.startsWith("artifact")).map((e) => [`${e.kind}:${e.op}`, e])).values()],
  );
  sock.ws.close();

  // ── 7. A branch made again starts with no artifacts ──
  r = await call("DELETE", `${base}/branches/${FULL}`, S);
  const gone = await call("GET", fullArts, S);
  await call("POST", `${base}/branches`, S, { name: FULL, from: "main" });
  r = await call("GET", fullArts, S);
  check("a deleted branch has no artifacts page; made again, it starts with none", gone.status === 404 && r.status === 200 && r.json?.total === 0);

  // ── 8. Not members ──
  r = await call("GET", arts, X);
  check("a person who is not a member cannot list artifacts (403)", r.status === 403);
  r = await upload(arts, X, [["file", "x.png", PNG, "image/png"]]);
  check("nor upload one", r.status === 403);
  res = await fetch(`${URL_}${mono}/artifacts/${banner.id}/versions/1/document`, { headers: { authorization: `Bearer ${X}` } });
  check("nor read one", res.status === 403);
  r = await call("POST", `${mono}/artifacts/${banner.id}/comments`, X, { body: "hi" });
  check("nor comment", r.status === 403);
  res = await fetch(`${URL_}${mono}/artifacts/${banner.id}/versions/1/document`);
  check("and without signing in, nothing (401)", res.status === 401);

  // ── 9. pando artifact, end to end: the Go test drives the commands against this server ──
  const CLI_BRANCH = "agent/plan-loop";
  r = await call("POST", `${base}/branches`, S, { name: CLI_BRANCH, from: "main" });
  const [GOMODCACHE, GOCACHE, GOPATH] = spawnSync("go", ["env", "GOMODCACHE", "GOCACHE", "GOPATH"], { encoding: "utf8" }).stdout.trim().split("\n");

  const go = spawnSync("go", ["test", "./internal/app", "-run", "^TestArtifactLive$", "-count=1", "-v"], {
    cwd: fileURLToPath(new URL("../../cli/", import.meta.url)), encoding: "utf8", timeout: 300_000,
    env: {
      ...env, GOMODCACHE, GOCACHE, GOPATH, PANDO_LIVE_URL: URL_, PANDO_LIVE_SECRET: S, PANDO_LIVE_PEER_SECRET: B,
      PANDO_LIVE_MONOREPO: `${O}/${M}`, PANDO_LIVE_BRANCH: CLI_BRANCH,
    },
  });

  check(
    "go test TestArtifactLive: add (v1, v2), list, comments, comment with a quote (warned when not in the file), reply, resolve, reopen, get --version, open",
    r.status === 201 && go.status === 0 && /--- PASS: TestArtifactLive/.test(go.stdout),
    scrub(`${go.stdout}${go.stderr}`).trim().split("\n").slice(-12).join(" | "),
  );
} catch (err) {
  check("no unexpected error", false, describeError(err));
} finally {
  check("this run's repositories are deleted", await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed}/${results.length} checks passed`);

process.exit(failed ? 1 : 0);
