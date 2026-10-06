// A Cloudflare agent's transcript (pando-agents, Pi) as conversation items
// (shape.ts). A person's message is a prompt, or Pando's note when it starts
// "[Pando]" (a note and the person's words when the two came together, after a
// sandbox came back); the agent's text is prose; each tool call is a step with
// its result's text, failed when the result says so, and running while the
// session works and no result has come. The model's thinking is left out.
import type { AgentMessage } from "@pando/contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ConversationItem, StepArgs } from "./shape";

/** Who the session's prompts are from and who answers. */
export interface AgentVoice {
  person: string;
  program: string;
  model: string;
  working: boolean;
}

const PANDO = "[Pando] ";

const decodeArgs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

const isText = Schema.is(Schema.String);

/** A tool call's arguments, each value as a string (a non-string as its JSON). */
function argsOf(json: string): StepArgs {
  const args = Option.getOrElse(decodeArgs(json), () => ({}));

  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, isText(v) ? v : JSON.stringify(v)]));
}

export function fromAgent(messages: readonly AgentMessage[], voice: AgentVoice): ConversationItem[] {
  const results = new Map<string, { text: string; error: boolean }>();

  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool-result") results.set(p.id, { text: p.text, error: p.error });
    }
  }

  const items: ConversationItem[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

      if (text.startsWith(PANDO)) {
        const cut = text.indexOf("\n\n");

        items.push({ kind: "note", key: `${m.id}:note`, at: m.at, text: (cut < 0 ? text : text.slice(0, cut)).slice(PANDO.length) });

        if (cut >= 0) items.push({ kind: "prompt", key: m.id, at: m.at, who: voice.person, text: text.slice(cut + 2) });
      } else {
        items.push({ kind: "prompt", key: m.id, at: m.at, who: voice.person, text });
      }
    }

    if (m.role !== "assistant") continue;

    for (const [i, p] of m.parts.entries()) {
      if (p.type === "text" && p.text.trim()) items.push({ kind: "prose", key: `${m.id}:${i}`, at: m.at, program: voice.program, model: voice.model, text: p.text });

      if (p.type === "tool-call") {
        const r = results.get(p.id);

        items.push({ kind: "step", key: p.id, at: m.at, tool: p.name, args: argsOf(p.arguments), out: r?.text, error: r?.error, running: !r && voice.working });
      }
    }

    if (m.error) items.push({ kind: "note", key: `${m.id}:error`, at: m.at, text: `The model's answer failed: ${m.error}` });
  }

  return items;
}
