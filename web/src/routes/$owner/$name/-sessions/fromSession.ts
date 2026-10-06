// A recorded session's parsed entries (GET .../sessions/{id}/entries) as conversation items (shape.ts): a typed
// prompt is a prompt, numbered, with the images that followed it counted ("Image, not kept"); the agent's words are
// prose, named by its program and the model in force when they were written (the session's model changes); each tool
// call is a step with its kept input and result, failed when the agent said so; a removed turn is its mark; a task
// another agent sent (a Codex subagent's) is a prompt from that agent; anything else the agent recorded as the
// person's (a notification, an interruption) is a note. Pando's redaction mark reads "[redacted]".
import type { SessionEntry } from "@pando/contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { modelName, PROGRAM_NAME, type Program } from "../../../../ui/AgentMark";
import type { ConversationItem, StepArgs } from "../../../../conversation/shape";

export interface SessionVoice {
  person: string;
  program: Program;
  /** When the answering model changed, oldest first. */
  changes: readonly { at: string; model: string }[];
}

const REDACTED = /\[pando:redacted\]/g;

const unmark = (s: string) => s.replace(REDACTED, "[redacted]");

const ms = (at: string | null) => (at ? Date.parse(at) : 0);

const decodeArgs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

const isText = Schema.is(Schema.String);

/** A tool call's kept input (the first 2 KB of its JSON) as its arguments, each value a string; cut JSON keeps its text. */
function argsOf(input: string | null): StepArgs {
  if (!input) return {};

  return Option.match(decodeArgs(input), {
    onNone: () => ({ input: unmark(input) }),
    onSome: (args) => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, isText(v) ? unmark(v) : JSON.stringify(v)])),
  });
}

/** The model in force at a time: the last change at or before it. */
function modelAt(changes: SessionVoice["changes"], at: string | null): string {
  let model = changes[0]?.model ?? "";

  for (const c of changes) if (at && c.at <= at) model = c.model;

  return model ? modelName(model) : "";
}

export function fromSession(entries: readonly SessionEntry[], voice: SessionVoice): ConversationItem[] {
  const items: ConversationItem[] = [];

  for (const e of entries) {
    const at = ms(e.at);
    const last = items.at(-1);

    switch (e.kind) {
      case "prompt":
        items.push({ kind: "prompt", key: e.id, at, who: voice.person, text: unmark(e.text ?? ""), n: e.prompt ?? undefined });
        break;
      case "image":
        if (last?.kind === "prompt") items[items.length - 1] = { ...last, images: (last.images ?? 0) + 1 };
        else items.push({ kind: "note", key: e.id, at, text: "Image, not kept" });
        break;
      case "answer":
        items.push({ kind: "prose", key: e.id, at, program: PROGRAM_NAME[voice.program], model: modelAt(voice.changes, e.at), text: unmark(e.text ?? "") });
        break;
      case "tool":
        items.push({ kind: "step", key: e.id, at, tool: e.tool ?? "tool", args: argsOf(e.input), out: e.result === null ? undefined : unmark(e.result), error: e.ok === false || undefined });
        break;
      case "removed":
        items.push({ kind: "removed", key: e.id, at, n: e.prompt ?? 0, by: e.by ?? "" });
        break;
      case "agent_message":
        items.push({ kind: "prompt", key: e.id, at, who: "another agent", text: unmark(e.text ?? "") });
        break;
      case "note":
        items.push({ kind: "note", key: e.id, at, text: unmark(e.text ?? "") });
        break;
    }
  }

  return items;
}
