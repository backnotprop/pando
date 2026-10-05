// One piece of a session, read: trajectory (letta-ai/trajectory 0.4.3, pinned) turns the agent's own lines into
// common records, and Pando's own pass over the same lines adds what trajectory keeps once per session or not at all
// (docs/sessions-build-notes.md): each line's time, the model of each answer, images, a Codex subagent's task
// (`agent_message`), a Codex subagent's parent. OpenCode V2 rows are turned into the OpenCode export trajectory reads.
// A piece is at most PIECE_MAX bytes, so a parse stays near 42 MB of memory (measured, stage 0).
import { normalizeTranscript, type NormalizedRecord } from "@letta-ai/trajectory";
import { isRecord, isText, isWholeNumber, parseJson, type Json, type JsonObject } from "../parse";
import type { Program } from "./ids";

/** The largest piece of trimmed lines the server takes: 8 MB (boarded; a parse costs about 5 times its text). */
export const PIECE_MAX = 8_000_000;

/** What a tool call keeps of its input and of its result (DETERMINISM.md row 32). */
export const TOOL_TEXT_MAX = 2048;

/** User records that are not typed prompts (DETERMINISM.md row 12): shown as notes, never counted. */
const NOT_PROMPTS = ["<local-command-", "<bash-stdout", "<bash-stderr", "<task-notification", "[Request interrupted", "This session is being continued from a previous conversation", "<turn_aborted>", "<system-reminder>"];

export type EntryKind = "prompt" | "note" | "answer" | "tool" | "image" | "agent_message" | "removed";

/** One thing in the conversation, in order. `prompt` numbers prompts from 1 across the session. */
export interface Entry {
  id: string;
  at: string | null;
  kind: EntryKind;
  text: string | null;
  prompt: number | null;
  tool: string | null;
  input: string | null;
  result: string | null;
  ok: boolean | null;
  /** A removed turn's mark: who removed it (its `at` is when). */
  by: string | null;
}

/** What the index keeps of a piece. Times are the lines' own (the agent's machine clock). */
export interface PieceFacts {
  first_at: string | null;
  last_at: string | null;
  prompts: number;
  tool_calls: number;
  /** Answers per model id, as recorded. */
  answers: Map<string, number>;
  /** Each time the answering model changed, in order: the model in force from `at` on. */
  model_changes: { at: string; model: string }[];
  folder: string | null;
  parent_agent_id: string | null;
  images: number;
  lines: number;
  /** The model in force when the piece ends: the next piece's carry. */
  model_after: string | null;
}

export interface ParsedPiece {
  facts: PieceFacts;
  entries: Entry[];
}

/** What a piece's parse needs from the pieces before it. */
export interface Carry {
  /** Codex says its model once per turn (`turn_context`): the one in force when this piece starts. */
  model: string | null;
  /** The last line time before this piece: a line without its own time takes it. */
  at: string | null;
}

/** A line of the piece, decoded once. */
export interface Line {
  /** Byte-free position: the line's index in the piece. */
  index: number;
  raw: string;
  value: JsonObject | null;
  /** The line's own time, or the one before it. */
  at: string | null;
}

function field(o: Json | undefined, key: string): Json | undefined {
  return isRecord(o) ? o[key] : undefined;
}

function text(o: Json | undefined, key: string): string | null {
  const v = field(o, key);

  return isText(v) && v ? v : null;
}

function iso(v: Json | undefined): string | null {
  if (isWholeNumber(v) && v > 1e11) return new Date(v).toISOString();

  if (!isText(v) || !v) return null;
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);

  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The time a line carries: `timestamp` (Claude Code, Codex, Pi), or the row's `time_created` (OpenCode V2, as `pando sync` sends rows). */
function ownTime(program: Program, v: JsonObject): string | null {
  return program === "opencode" ? iso(v.time_created) : iso(v.timestamp);
}

/** A piece's whole lines, decoded, each with its time. */
export function linesOf(program: Program, piece: string, carry: string | null): Line[] {
  const out: Line[] = [];
  let at = carry;
  let index = 0;

  for (const raw of piece.split("\n")) {
    if (!raw) continue;
    const parsed = parseJson(raw);
    const value = isRecord(parsed) ? parsed : null;
    at = (value && ownTime(program, value)) ?? at;
    out.push({ index: index++, raw, value, at });
  }

  return out;
}

function blocks(v: Json | undefined): JsonObject[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function blockText(v: Json | undefined): string {
  if (isText(v)) return v;

  return blocks(v).map((b) => text(b, "text") ?? "").filter(Boolean).join("\n");
}

/** Images on a line, by each agent's own block type (DETERMINISM.md row 34). */
function imagesOn(program: Program, v: JsonObject): number {
  const kinds = (list: JsonObject[], type: string) => list.filter((b) => b.type === type).length;

  if (program === "claude-code" && v.type === "user") return kinds(blocks(field(v.message, "content")), "image");

  if (program === "codex" && v.type === "response_item") return kinds(blocks(field(v.payload, "content")), "input_image");

  if (program === "pi" && v.type === "message" && field(v.message, "role") === "user") return kinds(blocks(field(v.message, "content")), "image");

  if (program === "opencode" && v.type === "user") return blocks(field(v.data, "files")).filter((f) => (text(f, "mime") ?? "").startsWith("image/")).length;

  return 0;
}

/**
 * Pando's pass: per line, the model of an answer (Claude Code `message.model` by message id, skipping `<synthetic>`;
 * Codex the `turn_context` model in force at each assistant message; Pi `message.model`; OpenCode `data.model.id`),
 * images, Codex subagent tasks and a Codex subagent's parent thread.
 */
function pass(program: Program, lines: Line[], carry: Carry) {
  const answers = new Map<string, number>();
  const changes: { at: string; model: string }[] = [];
  const extra: { line: Line; kind: "image" | "agent_message"; text: string | null }[] = [];
  const counted = new Set<string>();
  let model = carry.model;
  let last = carry.model;
  let parent: string | null = null;
  let images = 0;

  const answer = (m: string | null, at: string | null, key: string | null) => {
    if (!m || m === "<synthetic>") return;

    if (key) {
      if (counted.has(key)) return;
      counted.add(key);
    }

    answers.set(m, (answers.get(m) ?? 0) + 1);

    if (m !== last && at) changes.push({ at, model: m });
    last = m;
  };

  for (const line of lines) {
    const v = line.value;

    if (!v) continue;
    const n = imagesOn(program, v);

    for (let i = 0; i < n; i++) extra.push({ line, kind: "image", text: null });
    images += n;

    if (program === "claude-code" && v.type === "assistant") answer(text(v.message, "model"), line.at, text(v.message, "id"));

    if (program === "pi" && v.type === "message" && field(v.message, "role") === "assistant") answer(text(v.message, "model"), line.at, null);

    if (program === "opencode" && v.type === "assistant") answer(text(field(v.data, "model"), "id"), line.at, null);

    if (program === "codex") {
      const p = field(v, "payload");

      if (v.type === "turn_context") model = text(p, "model") ?? model;

      if (v.type === "session_meta") parent = text(p, "parent_thread_id") ?? text(field(field(field(p, "source"), "subagent"), "thread_spawn"), "parent_thread_id") ?? parent;

      if (v.type === "response_item" && field(p, "type") === "message" && field(p, "role") === "assistant") answer(model, line.at, null);

      if (v.type === "response_item" && field(p, "type") === "agent_message") extra.push({ line, kind: "agent_message", text: blockText(field(p, "content")) });
    }
  }

  return { answers, changes, extra, parent, images, model: program === "codex" ? model : last };
}

/** The `info` of an OpenCode export: the session's id, folder and start. */
interface ExportInfo {
  id: string;
  directory?: string;
  time?: { created: number };
}

/** OpenCode V2 rows (one per line, as `pando sync` reads them) as the OpenCode export trajectory reads. */
export function openCodeExport(lines: Line[], agentId: string): string {
  const info: ExportInfo = { id: agentId };
  const messages: Json[] = [];

  for (const { value: v } of lines) {
    if (!v) continue;

    if (v.type === "session") {
      const dir = text(v, "directory");

      if (dir) info.directory = dir;

      if (isWholeNumber(v.time_created)) info.time = { created: v.time_created };
      continue;
    }

    const id = text(v, "id") ?? "";
    const created = isWholeNumber(v.time_created) ? v.time_created : null;
    const d = field(v, "data");

    if (v.type === "user") {
      messages.push({ info: { id, role: "user", time: { created } }, parts: [{ id: `${id}.0`, type: "text", text: text(d, "text") ?? "" }] });
    } else if (v.type === "assistant") {
      const parts = blocks(field(d, "content")).map((c, i): Json => {
        if (c.type === "tool") {
          const state = field(c, "state");

          return {
            id: `${id}.${i}`, type: "tool", callID: text(c, "id"), tool: text(c, "name"),
            state: { status: text(state, "status"), input: field(state, "input") ?? {}, output: blockText(field(state, "content")), time: { start: field(field(c, "time"), "created") ?? null, end: field(field(c, "time"), "completed") ?? null } },
          };
        }

        return c.type === "text" ? { id: `${id}.${i}`, type: "text", text: text(c, "text") ?? "" } : { id: `${id}.${i}`, type: "skip" };
      });

      messages.push({ info: { id, role: "assistant", time: { created }, modelID: text(field(d, "model"), "id") }, parts });
    } else if (v.type === "shell") {
      // A command the person typed in OpenCode's terminal (`!`): a tool call they ran.
      const done = field(field(d, "time"), "completed") ?? null;
      messages.push({ info: { id, role: "user", time: { created } }, parts: [{ id: `${id}.0`, type: "tool", callID: id, tool: "shell", state: { status: text(d, "status"), input: { command: text(d, "command") ?? "" }, output: blockText(field(d, "output")), time: { start: created, end: done } } }] });
    }
  }

  return JSON.stringify({ info, messages });
}

function isPrompt(content: string): boolean {
  const head = content.trimStart();

  return !NOT_PROMPTS.some((p) => head.startsWith(p));
}

/** trajectory's records in the piece, tool calls paired with their results. */
interface RecordsRead {
  entries: Entry[];
  folder: string | null;
  prompts: number;
  tools: number;
}

function entriesOf(records: NormalizedRecord[], key: string): RecordsRead {
  const entries: Entry[] = [];
  const byCall = new Map<string, Entry>();
  let folder: string | null = null;
  let prompts = 0;
  let tools = 0;

  const add = (e: Omit<Entry, "id" | "prompt" | "tool" | "input" | "result" | "ok" | "by"> & Partial<Entry>) => {
    const full: Entry = { prompt: null, tool: null, input: null, result: null, ok: null, by: null, ...e, id: `${key}.${entries.length}` };
    entries.push(full);

    return full;
  };

  for (const r of records) {
    if (r.role === "meta") {
      folder ??= r.cwd ?? null;
    } else if (r.role === "user") {
      // Claude Code's image blocks read as "[image]" lines; the pass shows each as its own entry.
      const content = r.content.replace(/^\[image\]$/gm, "").trim();

      if (!content) continue;
      const prompt = isPrompt(content);

      if (prompt) prompts++;
      add({ at: r.timestamp, kind: prompt ? "prompt" : "note", text: content });
    } else if (r.role === "assistant" && "tool_calls" in r) {
      for (const call of r.tool_calls) {
        tools++;
        byCall.set(call.id, add({ at: r.timestamp, kind: "tool", text: null, tool: call.name, input: call.args.slice(0, TOOL_TEXT_MAX) }));
      }
    } else if (r.role === "assistant") {
      if (r.content) add({ at: r.timestamp, kind: "answer", text: r.content });
    } else if (r.role === "tool") {
      const call = byCall.get(r.tool_call_id);
      const result = r.content.slice(0, TOOL_TEXT_MAX);

      if (call) {
        call.result = result;
        call.ok = r.ok ?? null;
      } else {
        add({ at: r.timestamp, kind: "tool", text: null, result, ok: r.ok ?? null });
      }
    } else if (r.role === "observation") {
      add({ at: r.timestamp, kind: "note", text: r.content });
    }
    // reasoning: not kept (the machine drops it; anything left is not shown). system: omitted by trajectory.
  }

  return { entries, folder, prompts, tools };
}

/**
 * Read one piece. `key` names it in entry ids (the piece's start); `agentId` is the agent's own session id (OpenCode's
 * export needs it). A piece trajectory cannot read keeps its facts from Pando's pass and shows no entries.
 */
export function parsePiece(program: Program, piece: string, key: string, agentId: string, carry: Carry): ParsedPiece {
  const lines = linesOf(program, piece, carry.at);
  const p = pass(program, lines, carry);
  let read: RecordsRead = { entries: [], folder: null, prompts: 0, tools: 0 };

  try {
    const transcript = program === "opencode" ? openCodeExport(lines, agentId) : piece;

    const out = normalizeTranscript({
      source: program,
      transcript,
      sourceContext: { partial: true },
      bounds: { toolArguments: { maxCharacters: TOOL_TEXT_MAX }, toolResults: { maxCharacters: TOOL_TEXT_MAX } },
    });

    read = entriesOf(out.records, key);
  } catch {
    // Kept as sent; a later parser can read it (the index is rebuilt from the stored pieces).
  }

  // Pando's own entries go after trajectory's at the same time: an image follows its prompt.
  const extra = p.extra.map((x, i): Entry => ({ id: `${key}.x${i}`, at: x.line.at, kind: x.kind, text: x.text, prompt: null, tool: null, input: null, result: null, ok: null, by: null }));
  const entries = [...read.entries, ...extra].map((e, i) => ({ e, i })).sort((a, b) => (a.e.at ?? "").localeCompare(b.e.at ?? "") || a.i - b.i).map((x) => x.e);
  const times = lines.map((l) => l.at).filter((t) => t !== null);

  return {
    entries,
    facts: {
      first_at: times[0] ?? null,
      last_at: times.at(-1) ?? null,
      prompts: read.prompts,
      tool_calls: read.tools,
      answers: p.answers,
      model_changes: p.changes,
      folder: read.folder,
      parent_agent_id: p.parent,
      images: p.images,
      lines: lines.length,
      model_after: p.model,
    },
  };
}
