// A branch head's risk, from Workers AI's clef model (@cf/cloudflare/clef): a
// decision model that reads a state and answers typed questions with
// probabilities. One call per head; its state is the change in plain text,
// cut to STATE_MAX_CHARS. A failure, a timeout or a refusal is "unknown",
// never low (policy.ts sends unknown to a person).

import type { Env } from "../env";
import { runJson } from "./ai";
import { isNumber, isRecord, isText, type Json, type JsonObject } from "../parse";

export const CLEF_MODEL = "@cf/cloudflare/clef";

/** About 24,000 tokens at 4 characters a token: a third of clef's 65,536-token window, $0.0058 a call at most. */
export const STATE_MAX_CHARS = 96_000;

/** The start of each hunk the model reads. */
export const HUNK_LINES = 20;

/** A line of a hunk, cut here (minified files). */
const LINE_MAX = 200;

/** Files named in the state; past this, the count only. */
export const FILES_NAMED = 300;

/** Commit messages in the state, newest first, each cut to COMMIT_MAX characters. */
export const COMMITS_SHOWN = 50;

const COMMIT_MAX = 500;

const DESCRIPTION_MAX = 4_000;

/** How long the classification may take before the head is unknown. */
export const CLEF_TIMEOUT_MS = 20_000;

/** clef's price: US dollars per million input tokens (output is free). */
export const USD_PER_M_INPUT = 0.24;

export interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Its hunks' lines (with +, - or space), hunk by hunk; empty when not read. */
  hunks: string[][];
}

export interface StateInput {
  repo: string;
  branch: string;
  title: string | null;
  description: string | null;
  /** "a person, ramos" or "an agent (claude-code) on ramos-mac, for ramos". */
  author: string;
  commits: string[];
  files: ChangedFile[];
  files_total: number;
  sensitive_patterns: readonly string[];
  sensitive_hits: readonly string[];
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** The state clef reads: the change in plain text, at most STATE_MAX_CHARS. Hunks go first when cutting. */
export function stateOf(s: StateInput): string {
  const adds = s.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = s.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  const head = [
    `Change: branch ${s.branch} of project ${s.repo}, to be merged into main.`,
    `Title: ${s.title ?? "(none)"}`,
    ...(s.description ? [`Description: ${s.description.slice(0, DESCRIPTION_MAX)}`] : []),
    `Author: ${s.author}`,
    `Size: ${plural(s.files_total, "file")} changed, ${adds.toLocaleString("en-US")} lines added, ${dels.toLocaleString("en-US")} removed.`,
    `Sensitive paths in this project: ${s.sensitive_patterns.join(", ") || "(none)"}.`,
    `Changed files under them: ${s.sensitive_hits.length ? s.sensitive_hits.slice(0, 50).join(", ") : "none"}.`,
    "",
    `Commit messages (newest first, ${s.commits.length} shown):`,
    ...s.commits.slice(0, COMMITS_SHOWN).map((m) => `- ${m.trim().slice(0, COMMIT_MAX).replace(/\n+/g, " / ")}`),
    "",
    "Files changed (status, +added -removed):",
    ...s.files.slice(0, FILES_NAMED).map((f) => `- ${f.path} (${f.status}${f.binary ? ", binary" : `, +${f.additions ?? "?"} -${f.deletions ?? "?"}`})`),
    ...(s.files_total > FILES_NAMED ? [`- and ${plural(s.files_total - FILES_NAMED, "more file")}`] : []),
    "",
    `The start of each change (the first ${HUNK_LINES} lines of each hunk):`,
  ].join("\n");

  const out = [head.slice(0, STATE_MAX_CHARS - 200)];
  let used = out[0].length;
  let left = 0;

  for (const f of s.files) {
    if (!f.hunks.length) continue;
    const part = [`=== ${f.path}`, ...f.hunks.map((h) => h.slice(0, HUNK_LINES).map((l) => l.slice(0, LINE_MAX)).join("\n"))].join("\n");

    if (used + part.length + 1 > STATE_MAX_CHARS - 100) {
      left++;
      continue;
    }

    out.push(part);
    used += part.length + 1;
  }

  if (left) out.push(`(${plural(left, "more file")}' changes not shown)`);

  return out.join("\n");
}

/** The risk question: what to look for, the critical kinds of change named so the model weighs them. */
const CRITICAL_ASK =
  "How risky is it to merge this change into main without a careful review? Weigh most a change to who can do what (permission and access checks, roles, sign-in, sessions, tokens), to money (payments, billing, charges), to deleting or overwriting stored data, to secrets and credentials, to database schemas and migrations, and to the rules that decide whether code may merge or deploy.";

/** The questions, as clef takes them. */
export const QUESTIONS: JsonObject = {
  risk: {
    type: "score",
    instructions: CRITICAL_ASK,
    criteria: [
      "Low: documentation, tests, comments, formatting, copy, styling, or a small isolated change that cannot break other code.",
      "Medium: a logic change in one area of the code, with limited reach, that changes none of the critical kinds.",
      "High: changes who can do what (permission or access checks, roles, sign-in, sessions, tokens), moves or charges money, deletes or overwrites stored data, handles secrets or credentials, changes a database schema or migration, changes the rules for merging or deploying, or is a large change across many areas.",
    ],
  },
  review_path: {
    type: "choice",
    instructions: "Which review should this change get before it merges?",
    criteria: {
      auto: "None beyond its automated checks: safe to merge when they pass.",
      ai: "A review by an automated code reviewer that reads the change and runs its tests.",
      human: "A person must read and approve it: the change can do real harm if it is wrong.",
    },
  },
  sensitive: {
    type: "noul",
    instructions: "Does the change touch authentication, permissions, payments, secrets, infrastructure, CI, or stored data and its migrations?",
  },
  destructive: {
    type: "noul",
    instructions: "Does the change delete or rewrite more existing code than it adds, or remove files?",
  },
  critical: {
    type: "noul",
    instructions: "Does the change alter who can do what (a permission or access check, a role, sign-in, a session or token), move or charge money, delete or overwrite stored data, handle secrets or credentials, change a database schema or migration, or change the rules for merging or deploying?",
  },
};

/** What the head stores from clef's answers. */
export interface Classified {
  /** 0 to 1. */
  score: number;
  /** Per level: low, medium, high. */
  levels: { low: number; medium: number; high: number };
  path: { choice: string; probabilities: Record<string, number> };
  sensitive: number;
  destructive: number;
  /** The noul "critical": who can do what, money, deleting data, secrets, migrations, merge or deploy rules. */
  critical: number;
  model: string;
  tokens: number;
  cost_usd: number;
  ms: number;
}

/** A scoring: clef's answers, or why there are none. */
export type Scored = { ok: true; c: Classified } | { ok: false; why: string };

const numberIn = (o: JsonObject | null, k: string): number | null => {
  const v = o?.[k];

  return isNumber(v) ? v : null;
};

const objectIn = (o: JsonObject | null, k: string): JsonObject | null => {
  const v = o?.[k];

  return isRecord(v) ? v : null;
};

/** clef's answer (Json, as Workers AI returns it) read into Classified. */
export function readAnswer(out: Json, chars: number, ms: number): Scored {
  const answers = isRecord(out) ? objectIn(out, "answers") : null;

  if (!isRecord(out) || !answers) return { ok: false, why: "clef answered without answers" };
  const risk = objectIn(answers, "risk");
  const path = objectIn(answers, "review_path");
  const raw = numberIn(risk, "score");

  if (raw === null) return { ok: false, why: "clef answered without a risk score" };
  const p = objectIn(risk, "probabilities");
  // A noul answer is {noul: p}; a bare number is taken as p too.
  const noul = (k: string) => numberIn(objectIn(answers, k), "noul") ?? numberIn(answers, k) ?? 0;
  const probs: Record<string, number> = {};

  for (const [k, v] of Object.entries(objectIn(path, "probabilities") ?? {})) if (isNumber(v)) probs[k] = v;
  const usage = objectIn(out, "usage");
  // Its input tokens when it says (usage.prompt_tokens or input_tokens); else 4 characters a token.
  const tokens = numberIn(usage, "prompt_tokens") ?? numberIn(usage, "input_tokens") ?? Math.ceil(chars / 4);
  const choice = path?.choice;

  return {
    ok: true,
    c: {
      score: Math.min(1, Math.max(0, raw / 2)),
      levels: { low: numberIn(p, "0") ?? 0, medium: numberIn(p, "1") ?? 0, high: numberIn(p, "2") ?? 0 },
      path: { choice: isText(choice) ? choice : "", probabilities: probs },
      sensitive: noul("sensitive"),
      destructive: noul("destructive"),
      critical: noul("critical"),
      // It names its selector ("clef"); the model id is the one called.
      model: CLEF_MODEL,
      tokens,
      cost_usd: (tokens * USD_PER_M_INPUT) / 1_000_000,
      ms,
    },
  };
}

/** One clef call: the answers, or why there are none (a failure, a refusal, a timeout). */
export async function classify(env: Env, state: string): Promise<Scored> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const call = runJson(env, CLEF_MODEL, { model: "clef", state, questions: QUESTIONS });

    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CLEF_TIMEOUT_MS);
    });

    const out = await Promise.race([call, late]);

    return out === null ? { ok: false, why: `clef did not answer within ${CLEF_TIMEOUT_MS / 1000} s` } : readAnswer(out, state.length, Date.now() - t0);
  } catch (err) {
    return { ok: false, why: `clef failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A scripted answer for tests (RISK_TEST): the score given, no call. */
export function scripted(score: number, chars: number): Classified {
  // The level weights that give this score: between low and medium below 0.5, between medium and high above.
  const w = score * 2;
  const levels = w <= 1 ? { low: 1 - w, medium: w, high: 0 } : { low: 0, medium: 2 - w, high: w - 1 };

  return {
    score, levels, path: { choice: "", probabilities: {} },
    sensitive: 0, destructive: 0, critical: 0, model: "scripted", tokens: Math.ceil(chars / 4), cost_usd: 0, ms: 0,
  };
}

/** Plain-word reasons, most telling first, at most six. */
export function reasonsOf(c: Classified | null, s: { sensitive_hits: readonly string[]; files_total: number; additions: number; deletions: number; deleted_files: number }): string[] {
  const out: string[] = [];
  const hits = s.sensitive_hits;

  if (hits.length) out.push(`Touches sensitive paths: ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? `, and ${hits.length - 3} more` : ""}`);

  if (s.deleted_files) out.push(`Deletes ${plural(s.deleted_files, "file")}`);
  else if (s.deletions > s.additions && s.deletions >= 20) out.push(`Removes more than it adds (+${s.additions} -${s.deletions})`);

  if (s.files_total > 20 || s.additions + s.deletions > 500) out.push(`Large: ${plural(s.files_total, "file")}, +${s.additions.toLocaleString("en-US")} -${s.deletions.toLocaleString("en-US")}`);

  if (c) {
    if (c.sensitive >= 0.5) out.push(`The model reads it as touching auth, payments, secrets, infrastructure or data (${c.sensitive.toFixed(2)})`);

    if (c.critical >= 0.5) out.push(`The model reads it as changing a critical kind of behaviour: access, money, data deletion, secrets, migrations or merge rules (${c.critical.toFixed(2)})`);

    if (c.destructive >= 0.5) out.push(`The model reads it as deleting or rewriting more than it adds (${c.destructive.toFixed(2)})`);
    const top = Object.entries(c.levels).sort((x, y) => y[1] - x[1])[0];
    out.push(`Risk ${c.score.toFixed(2)}: mostly ${top[0]} (${top[1].toFixed(2)})`);
  }

  return out.slice(0, 6);
}
