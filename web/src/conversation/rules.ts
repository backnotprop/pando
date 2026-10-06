// The conversation's fixed rules for steps (the mocks' conversation.mjs, the
// same rules): nothing here is written by a model.
//
// 1. A step's line is a verb and its object, from the tool's name and its
//    arguments ("Read web/index.html", "Ran npm test"); anything else is the
//    tool's name. A failed step reads "Failed to <base verb> <object>".
// 2. Two or more steps in a row fold into one line: "<N> steps", then per
//    verb in the order first seen, one object named or more counted ("Read 3
//    files"), at most three verbs, then "and more".
// 3. A running step's verb is in the present: "Running npm test".
import type { StepItem } from "./shape";

/** A step's words: the verb, its object, and how the object reads (a command, a path, plain). */
export interface StepWords {
  verb: string;
  object: string;
  look: "command" | "path" | "plain";
}

const NOUN = new Map<string, readonly [string, string]>([
  ["Read", ["file", "files"]],
  ["Wrote", ["file", "files"]],
  ["Edited", ["file", "files"]],
  ["Ran", ["command", "commands"]],
  ["Searched", ["time", "times"]],
  ["Listed", ["folder", "folders"]],
  ["Commented", ["time", "times"]],
]);

const BASE = new Map<string, string>([
  ["Read", "read"],
  ["Wrote", "write"],
  ["Edited", "edit"],
  ["Ran", "run"],
  ["Searched", "search"],
  ["Listed", "list"],
  ["Commented", "comment"],
  ["Reviewed", "review"],
  ["Merged", "merge"],
  ["Started", "start"],
  ["Ran a subagent,", "run a subagent,"],
]);

const PRESENT = new Map<string, string>([
  ["Read", "Reading"],
  ["Wrote", "Writing"],
  ["Edited", "Editing"],
  ["Ran", "Running"],
  ["Searched", "Searching"],
  ["Listed", "Listing"],
  ["Commented", "Commenting"],
  ["Reviewed", "Reviewing"],
  ["Merged", "Merging"],
  ["Started", "Starting"],
  ["Ran a subagent,", "Running a subagent,"],
]);

const COMMAND_MAX = 60;

const words = (verb: string, object: string, look: StepWords["look"] = "plain"): StepWords => ({ verb, object, look });

/** Rule 1: a step's verb and object. */
export function stepWords(s: Pick<StepItem, "tool" | "args" | "steps">): StepWords {
  const a = s.args;

  switch (s.tool) {
    case "read":
    case "Read":
    case "read_file":
      return words("Read", a.path ?? a.file_path ?? "", "path");
    case "write":
    case "Write":
      return words("Wrote", a.path ?? a.file_path ?? "", "path");
    case "edit":
    case "Edit":
    case "MultiEdit":
      return words("Edited", a.path ?? a.file_path ?? "", "path");
    case "bash":
    case "Bash": {
      const line = (a.command ?? "").split("\n")[0] ?? "";

      return words("Ran", line.length > COMMAND_MAX ? `${line.slice(0, COMMAND_MAX)}…` : line, "command");
    }

    case "grep":
    case "Grep":
      return words("Searched", `for ${a.pattern ?? ""}`);
    case "glob":
    case "Glob":
    case "list_files":
      return words("Listed", a.path || "the root", a.path ? "path" : "plain");
    case "issue":
      return words("Read", `#${a.number ?? ""}`);
    case "branch_diff":
      return words("Read", `the changes on ${a.branch ?? "this branch"}`);
    case "comment_issue":
      return words("Commented", `on #${a.number ?? ""}`);
    case "post_review":
      return words("Reviewed", `${a.branch ?? "this branch"}: ${(a.verdict ?? "").replace("_", " ")}`);
    case "merge":
      return words("Merged", a.branch ?? "this branch");
    case "start_branch":
      return words("Started", a.name ? `branch ${a.name}` : "its branch");
    case "Task":
      return words("Ran a subagent,", `${s.steps ?? 0} steps`);
    default:
      return words(s.tool, "");
  }
}

/** Rule 1, failed: "Failed to <base verb>". */
export const failedVerb = (verb: string): string => `Failed to ${BASE.get(verb) ?? verb}`;

/** Rule 3: the verb of a step still running. */
export const presentVerb = (verb: string): string => PRESENT.get(verb) ?? verb;

/** One part of a fold line: a verb with its one object, or with a count. */
export interface FoldPart {
  verb: string;
  object: StepWords | null;
  count: string | null;
}

/** A fold line: its parts, and whether verbs were left out. */
export interface Fold {
  parts: FoldPart[];
  more: boolean;
}

/** Rule 2: the fold line for a run of steps. */
export function foldParts(run: readonly Pick<StepItem, "tool" | "args" | "steps">[]): Fold {
  const groups = new Map<string, StepWords[]>();

  for (const s of run) {
    const w = stepWords(s);
    const list = groups.get(w.verb) ?? [];

    list.push(w);
    groups.set(w.verb, list);
  }

  const parts = [...groups].slice(0, 3).map(([verb, all]): FoldPart => {
    if (all.length === 1) return { verb, object: all[0] ?? null, count: null };

    const [, many] = NOUN.get(verb) ?? ["time", "times"];

    return { verb, object: null, count: `${all.length} ${many}` };
  });

  return { parts, more: groups.size > 3 };
}

/** Rule 2 as plain words, for a fold's title and tests. */
export function foldText(run: readonly Pick<StepItem, "tool" | "args" | "steps">[]): string {
  const { parts, more } = foldParts(run);
  const text = parts.map((p) => [p.verb, p.count ?? p.object?.object ?? ""].filter(Boolean).join(" ")).join(", ");

  return more ? `${text}, and more` : text;
}
