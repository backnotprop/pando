// The conversation's data shape: what the conversation component draws. Two
// lanes feed it: a Cloudflare agent's transcript and live frames (fromAgent.ts,
// this lane) and a recorded local session's parsed pieces (the sessions lane).
// A feeder turns its own records into these items, oldest first; the component
// decides everything else (folds, words, what opens) by fixed rules (rules.ts).
// Nothing in an item is written by a model except a prose item's text.
//
// Every item has a `key`, stable across reads (an entry id, a tool call id),
// and `at`, Unix milliseconds.

/** A tool's arguments, each value as a string (a non-string value is its JSON). */
export type StepArgs = Readonly<Record<string, string>>;

/** What the person said. `n` numbers their prompts when the view shows it; `images` counts images not kept. */
export interface PromptItem {
  kind: "prompt";
  key: string;
  at: number;
  who: string;
  text: string;
  n?: number;
  images?: number;
}

/** The agent's words, Markdown as recorded. `program` and `model` name who wrote them ("Pi", "GLM-5.3 Flash"). */
export interface ProseItem {
  kind: "prose";
  key: string;
  at: number;
  program: string;
  model: string;
  text: string;
}

/**
 * One tool call. `out` is its kept output; `notKept` says why there is none
 * ("over 1 MB"); `error` marks a failed call (its `out` then says why);
 * `running` marks the call still going; `steps` counts a subagent's own steps.
 * Redacted values in `out` read "[redacted]".
 */
export interface StepItem {
  kind: "step";
  key: string;
  at: number;
  tool: string;
  args: StepArgs;
  out?: string;
  error?: boolean;
  running?: boolean;
  notKept?: string;
  steps?: number;
}

/** Pando's own message to the agent (checks went green; the sandbox came back). */
export interface NoteItem {
  kind: "note";
  key: string;
  at: number;
  text: string;
}

/** A prompt its person removed, with its answers. */
export interface RemovedItem {
  kind: "removed";
  key: string;
  at: number;
  n: number;
  by: string;
}

/** A later turn drawn folded whole: its prompt, its step count, the commits it made. */
export interface TurnItem {
  kind: "turn";
  key: string;
  at: number;
  n: number;
  who: string;
  text: string;
  steps: number;
  commits?: readonly string[];
}

export type ConversationItem = PromptItem | ProseItem | StepItem | NoteItem | RemovedItem | TurnItem;
