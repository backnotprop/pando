// The guided review for a head on the human tier: Plannotator's method and
// format (@plannotator/core), written by one Workers AI call on the Worker,
// not by a container session (a guide is one read of the diff). The guide
// is checked for coverage (every changed file placed once), repaired once if
// nothing survives, wrapped by Plannotator's own exporter into one HTML file,
// and kept as the branch's artifact guided-review.html. A guide that cannot
// be written is recorded as failed; it never holds up the review. It runs
// from an outbox of its own (guides_outbox): a guide takes 20 to 60 s, and
// branch facts never wait behind it.

import { buildGuideSnapshot, createGuideHtml, listGuidePatchFiles, resolveGuideViewerAssets } from "@plannotator/core/guide-format";
import { buildGuideUserMessage, GUIDE_REVIEW_PROMPT, GUIDE_SCHEMA_JSON, validateGuideOutput } from "@plannotator/core/guide-prompt";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/core/guide-viewer-manifest";
import type { CodeGuideOutput } from "@plannotator/core/guide";
import { DEFAULT_MODEL } from "../../../agents/src/protocol";
import type { Env } from "../env";
import { runJson } from "./ai";
import { isRecord, isText, parseJson, type Json } from "../parse";

/** The diff the model reads, in characters (about 50,000 tokens); a larger change gets no guide. */
export const GUIDE_PATCH_MAX = 200_000;

/** The answer's length, in tokens. */
const ANSWER_TOKENS = 8_192;

/** One call's wait. */
export const GUIDE_TIMEOUT_MS = 120_000;

export const GUIDE_MODEL = DEFAULT_MODEL;

/** The artifact's name on the branch. */
export const GUIDE_ARTIFACT = "guided-review.html";

export interface GuideInput {
  /** The branch page's address: the guide's pull request. */
  url: string;
  repo: string;
  branch: string;
  head: string;
  title: string | null;
  description: string | null;
  commits: string[];
  patch: string;
  stats: { path: string; additions: number; deletions: number }[];
}

/** A guide: the HTML file, or why there is none. */
export type Guided = { ok: true; html: string; title: string; ms: number; calls: number } | { ok: false; why: string };

/** The JSON a Workers AI chat model answered with: `response` (an object, or JSON text, fenced or not), or an OpenAI-style choice. */
function answerOf(out: Json): Json {
  if (!isRecord(out)) return out;
  const choices = out.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const v = out.response ?? (isRecord(message) ? message.content : undefined) ?? out;

  if (!isText(v)) return v;
  const t = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const from = t.indexOf("{");
  const to = t.lastIndexOf("}");

  return parseJson(from >= 0 && to > from ? t.slice(from, to + 1) : t);
}

async function ask(env: Env, system: string, user: string): Promise<Json> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the model did not answer within ${GUIDE_TIMEOUT_MS / 1000} s`)), GUIDE_TIMEOUT_MS);
  });

  try {
    const call = runJson(env, GUIDE_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: parseJson(GUIDE_SCHEMA_JSON) },
      max_tokens: ANSWER_TOKENS,
    });

    return answerOf(await Promise.race([call, late]));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Plannotator's message for an inline diff, with the branch's own words first (the guide's intent comes from them). */
function userMessage(g: GuideInput, files: string[]): string {
  const about = [
    `Branch ${g.branch} of ${g.repo}, into main. Title: ${g.title ?? "(none)"}.`,
    ...(g.description ? [`Description: ${g.description.slice(0, 4_000)}`] : []),
    "Commit messages, newest first:",
    ...g.commits.slice(0, 50).map((m) => `- ${m.split("\n")[0].slice(0, 200)}`),
    "",
  ];

  const changed = g.stats.filter((s) => files.includes(s.path));

  return [...about, buildGuideUserMessage(g.patch, "branch", undefined, { url: g.url, baseBranch: "main", inlineDiff: true }, changed)].join("\n");
}

/** The guide for this head as one HTML file, or why there is none. */
export async function writeGuide(env: Env, g: GuideInput): Promise<Guided> {
  if (!g.patch.trim()) return { ok: false, why: "the branch changes no text files" };

  if (g.patch.length > GUIDE_PATCH_MAX) return { ok: false, why: `the diff is ${g.patch.length.toLocaleString("en-US")} characters; a guide reads at most ${GUIDE_PATCH_MAX.toLocaleString("en-US")}` };
  const t0 = Date.now();
  const files = listGuidePatchFiles(g.patch).map((f) => f.path);
  let calls = 1;
  let raw: Json;

  try {
    raw = await ask(env, GUIDE_REVIEW_PROMPT, userMessage(g, files));
  } catch (err) {
    return { ok: false, why: `the guide model failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }

  let checked = validateGuideOutput(raw, files);

  // Once: fix the structure, never the content.
  if ("error" in checked) {
    calls++;

    const repair = [
      "This guided review does not match its schema, or does not place the changed files. Fix the structure only: keep every title, intent, overview and summary word for word.",
      "Every diffs[].file must be one of these paths, copied exactly, and each path appears in exactly one section or in unplacedFiles:",
      ...files.map((f) => `- ${f}`),
      "",
      `The schema: ${GUIDE_SCHEMA_JSON}`,
      "",
      "The guide to fix:",
      JSON.stringify(raw).slice(0, 60_000),
    ].join("\n");

    try {
      checked = validateGuideOutput(await ask(env, "You repair JSON documents. Answer with the fixed JSON only.", repair), files);
    } catch (err) {
      return { ok: false, why: `the guide's repair failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
    }
  }

  if ("error" in checked) return { ok: false, why: `no usable guide: ${checked.error}` };
  const guide: CodeGuideOutput = checked.guide;

  const snapshot = buildGuideSnapshot({
    guide,
    reviewed: [],
    review: { rawPatch: g.patch, gitRef: `main...${g.branch}`, base: "main", source: { kind: "pr", repo: g.repo, branch: g.branch, headSha: g.head, pr: { url: g.url, title: g.title ?? g.branch } } },
    generator: { engine: "pando", model: GUIDE_MODEL },
  });

  return { ok: true, html: createGuideHtml(snapshot, { viewer: resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST) }), title: guide.title, ms: Date.now() - t0, calls };
}
