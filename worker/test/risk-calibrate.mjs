// Calibration of risk-based review over Pando's own history: each case is a
// real commit (some cut to the files named), scored as a push would be (the
// comments-and-docs rule, then real clef through the Worker's AI binding).
// The table goes into docs/risk-review/DESIGN.md. Each scored case is one
// real Workers AI call; the rule cases make none.
//
//   (a Worker with RISK_TEST=1 on PANDO_URL)  PANDO_URL=http://127.0.0.1:8919 node worker/test/risk-calibrate.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const URL_ = (process.env.PANDO_URL ?? "http://127.0.0.1:8919").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const SENSITIVE = ["auth/", "payments/", "billing/", "infra/", ".github/", "migrations/", ".pando/", ".env", "secrets"];

/** [what it is, commit, files (all when empty), what it should get]. */
const CASES = [
  ["Comment fix (a test's note)", "96f8ca6", [], "auto"],
  ["Blank lines only (spacing)", "593d467", [], "auto"],
  ["Docs page (mac/README.md)", "69e1a44", [], "auto"],
  ["Copy change (landing page words)", "321a470", [], "auto"],
  ["Test only (install.mjs retry)", "1850302", [], "auto"],
  ["Web styling (artifacts tab on a phone)", "4263e95", [], "auto"],
  ["Agents' merge tool retries a 503", "0acf094", ["agents/src/pando-tools.ts"], "ai"],
  ["WorkOS sign-in (signin.ts as added)", "b6f60e5", ["worker/src/accounts/signin.ts"], "human"],
  ["Sign-out page removed (logout route)", "1209fbf", [], "human"],
  ["MCP OAuth server (oauth, consent, credentials)", "99e5057", ["worker/src/mcp/oauth.ts", "worker/src/mcp/consent.ts", "worker/src/accounts/auth.ts", "worker/src/accounts/store.ts"], "human"],
  ["Migration 0010 (MCP OAuth tables)", "99e5057", ["worker/migrations/0010_mcp_oauth.sql"], "human"],
  ["Merge gate fails closed on a broken pando.toml", "86ea53e", ["worker/src/monorepo/object.ts", "worker/src/monorepo/checks.ts"], "human"],
];

const git = (...args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).stdout;

/** A commit's diff (to its first parent), cut to `paths`, as the Worker's ChangedFile list. */
function filesOf(commit, paths) {
  const text = git("show", "--format=", "--no-color", "--no-renames", commit, "--", ...paths);
  const files = [];
  let f = null;
  let hunk = null;

  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);

    if (head) {
      f = { path: head[2], status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
      files.push(f);
      hunk = null;
      continue;
    }

    if (!f) continue;

    if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("Binary files")) f.binary = true;
    else if (line.startsWith("@@")) {
      hunk = [];
      f.hunks.push(hunk);
    } else if (hunk && /^[ +\-\\]/.test(line) && !line.startsWith("+++") && !line.startsWith("---")) {
      hunk.push(line);

      if (line[0] === "+") f.additions++;

      if (line[0] === "-") f.deletions++;
    }
  }

  return files;
}

const rows = [];

let calls = 0;

let cost = 0;

for (const [what, commit, paths, want] of CASES) {
  const message = git("log", "-1", "--format=%B", commit).trim();
  const files = filesOf(commit, paths);
  const body = { branch: `calibrate-${commit}`, title: message.split("\n")[0].slice(0, 200), commits: [message], files, sensitive: SENSITIVE, author: "a person" };
  const r = await fetch(`${URL_}/v1/_risk/score`, { method: "POST", headers: { authorization: `Bearer ${BOOT}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json();
  const c = out.scored?.ok ? out.scored.c : null;

  if (c) {
    calls++;
    cost += c.cost_usd;
  }

  const lines = files.reduce((n, x) => n + x.additions + x.deletions, 0);
  rows.push({ what, commit, files: files.length, lines, rule: out.rule, score: c?.score ?? null, critical: c?.critical ?? null, sensitive: out.sensitive_hits?.length ?? 0, tier: out.tier, want, tokens: c?.tokens ?? null, cost: c?.cost_usd ?? null, error: out.scored && !out.scored.ok ? out.scored.why : null });
}

console.log("| Change | Commit | Files, lines | Rule or clef score | critical (noul) | Sensitive path | Tier | Expected |");

console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");

for (const x of rows) {
  const score = x.rule ? "rule: comments and docs" : x.score === null ? `unknown (${x.error})` : x.score.toFixed(2);
  console.log(`| ${x.what} | ${x.commit} | ${x.files}, ${x.lines} | ${score} | ${x.critical === null ? "" : x.critical.toFixed(2)} | ${x.sensitive ? "yes" : "no"} | ${x.tier} | ${x.want}${x.tier === x.want ? "" : " (miss)"} |`);
}

console.log(`\n${calls} clef calls, $${cost.toFixed(6)} in all, $${calls ? (cost / calls).toFixed(6) : 0} a call; tokens: ${rows.map((x) => x.tokens ?? "-").join(", ")}`);
