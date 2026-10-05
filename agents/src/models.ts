// The models a session can use. A session stores its model's id; the
// default is GLM-5.3 Flash on Workers AI (the owner's choice, 2026-10-04),
// reached through the AI binding with no provider key. Others are added here.
//
// The scripted model is for the end-to-end tests: deterministic, no cost. It
// exists only when the Worker runs with SCRIPTED_MODEL=1 (`wrangler dev --var
// SCRIPTED_MODEL:1`), never deployed.

import type { Model, ToolCall, ToolResultMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAI } from "agents/models/pi-ai";
import { contentText } from "./transcript";

import { DEFAULT_MODEL } from "./protocol";

export { DEFAULT_MODEL };

export const SCRIPTED_MODEL = "scripted";

/** The model ids a session may name. */
const WORKERS_AI_MODELS = new Set([DEFAULT_MODEL]);

export interface ModelEnv {
  AI: Ai;
  SCRIPTED_MODEL?: string;
}

export function scriptedEnabled(env: ModelEnv): boolean {
  return env.SCRIPTED_MODEL === "1";
}

/** Whether a session may use this model id here. */
export function knownModel(env: ModelEnv, id: string): boolean {
  return WORKERS_AI_MODELS.has(id) || (id === SCRIPTED_MODEL && scriptedEnabled(env));
}

/** The registry Pi looks models up in, and a function from model id to model. */
/** The registry Pi looks models up in, and the model for an id. */
export interface SessionModels {
  models: Models;
  model(id: string): Model<string>;
}

export function openModels(env: ModelEnv): SessionModels {
  const ai = createAI({ binding: env.AI });
  const models = createModels();
  models.setProvider(ai.provider);

  if (!scriptedEnabled(env)) {
    return { models, model: (id: string) => ai(id) } satisfies SessionModels;
  }

  const faux = fauxProvider({ provider: "pando-scripted", models: [{ id: SCRIPTED_MODEL, contextWindow: 200_000, maxTokens: 8_192 }] });

  const step = (context: TranscriptContext) => {
    faux.appendResponses([step]);

    return scripted(context);
  };

  faux.setResponses([step]);
  models.setProvider(faux.provider);

  return { models, model: (id: string) => (id === SCRIPTED_MODEL ? faux.getModel() : ai(id)) } satisfies SessionModels;
}

// ── The scripted model ──
//
// It reads the newest user message. Each line of the form
//   > tool_name {"json": "arguments"}
// is one tool call, made in order, one per turn. When every call has its
// result, it answers "Finished." with the last result's text. A message that
// ends with a line "recall" is answered with the earlier user messages it was
// given, which shows what the session remembers. Pando's own message that a
// branch's checks are green is answered with a merge call, as an agent would.

const CALL_LINE = /^> ([a-z_][a-z0-9_]*) (\{.*\})\s*$/;

function parseCall(line: string): { name: string; args: ToolCall["arguments"] }[] {
  const m = CALL_LINE.exec(line.trim());

  if (!m) return [];
  // SAFETY: CALL_LINE matches only a {...} literal, and the scripts are the tests' own.
  const args = JSON.parse(m[2]) as ToolCall["arguments"];

  return [{ name: m[1], args }];
}

function scripted(context: TranscriptContext) {
  const messages = context.messages.filter((m) => m.role !== "system");
  const users = messages.filter((m): m is UserMessage => m.role === "user");
  const current = users.at(-1);
  const prompt = current ? contentText(current.content) : "";
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const results = messages.slice(lastUser + 1).filter((m): m is ToolResultMessage => m.role === "toolResult");

  if (/(^|\n)recall$/.test(prompt.trim())) {
    const earlier = users.slice(0, -1).map((m) => contentText(m.content).slice(0, 80));

    return fauxAssistantMessage(fauxText(`I see ${earlier.length} earlier prompts: ${JSON.stringify(earlier)}`));
  }

  const calls = /(^|\n)\[Pando\] The required checks on \S+ are green now\./.test(prompt) ? [{ name: "merge", args: {} }] : prompt.split("\n").flatMap(parseCall);

  if (results.length < calls.length) {
    const next = calls[results.length];

    return fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" });
  }

  if (calls.length === 0) {
    return fauxAssistantMessage(fauxText(`ok: ${prompt.split("\n")[0].slice(0, 200)}`));
  }

  const last = results.at(-1);

  return fauxAssistantMessage(fauxText(`Finished.\n${last ? contentText(last.content).slice(-3000) : ""}`));
}
