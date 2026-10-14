// The tools of a session of kind understand (docs/understand/DESIGN.md): each
// lookup runs on Pando's server for this session's page and answers text for
// the model with the sources it found, each with an id on the page (r1, r2).
// `place` writes the answer's paragraphs, which may cite only those ids; Pando
// refuses any other. The session has no sandbox and no tool that writes code.

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PandoApi } from "./pando-tools";

interface Lookup {
  text: string;
  refs: string[];
}

interface Placed {
  placed: string[];
  refused: { id: string; reason: string }[];
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const Repo = Type.Optional(Type.String({ description: "A project's name; the page's own when left out" }));

export function understandTools(api: PandoApi, page: number): ToolRegistration[] {
  const base = () => `${api.base()}/understand/${page}`;

  const lookup = async <A extends object>(tool: string, args: A) => {
    const r = await api.call("POST", `${base()}/lookups`, JSON.stringify({ tool, args }));
    // SAFETY: Contract.UnderstandLookup; only its text is read.
    const out = JSON.parse(r.text) as Lookup;

    return text(out.text);
  };

  return [
    defineTool({
      name: "blame",
      description: "Which commit last changed each of lines start to end of a file, at a commit or branch (main when left out). Each commit found is a source with its id, with the session its Pando-Session line names.",
      parameters: Type.Object({ path: Type.String(), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }), ref: Type.Optional(Type.String()), repo: Repo }),
      replay: "safe",
      execute: (args) => lookup("blame", args),
    }),
    defineTool({
      name: "history",
      description: "The commits that changed a file, newest first (at most 20), each a source.",
      parameters: Type.Object({ path: Type.String(), ref: Type.Optional(Type.String()), repo: Repo }),
      replay: "safe",
      execute: (args) => lookup("history", args),
    }),
    defineTool({
      name: "commit",
      description: "One commit: its message, who made it on which machine with which agent and model, and the recorded sessions it names. Each is a source.",
      parameters: Type.Object({ sha: Type.String(), repo: Repo }),
      replay: "safe",
      execute: (args) => lookup("commit", args),
    }),
    defineTool({
      name: "search_shared",
      description: "Search the repository's shared files (plans, decisions, notes: everything outside projects/) for words. Each file found is a source, with the lines that match.",
      parameters: Type.Object({ words: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }) }),
      replay: "safe",
      execute: (args) => lookup("search_shared", args),
    }),
    defineTool({
      name: "search_sessions",
      description: "Search the prompts of recorded agent sessions for words: the sessions of the commits found first, then the newest. Each prompt found is a source.",
      parameters: Type.Object({ words: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }) }),
      replay: "safe",
      execute: (args) => lookup("search_sessions", args),
    }),
    defineTool({
      name: "issue",
      description: "Read an issue: its title, state and description. It becomes a source.",
      parameters: Type.Object({ number: Type.Integer({ minimum: 1 }) }),
      replay: "safe",
      execute: (args) => lookup("issue", args),
    }),
    defineTool({
      name: "place",
      description:
        'Write the answer on the page: blocks of type "paragraph", a few sentences each, citing the sources they rest on inline as [r1]. Every paragraph cites at least one source, and only ids the lookups gave you. When no source explains what was asked, place one block of type "nothing" saying what you checked. Placing a block with an id already placed replaces it.',
      parameters: Type.Object({
        blocks: Type.Array(
          Type.Object({
            id: Type.String({ description: "Your id for the block, such as p1; the same id replaces it" }),
            type: Type.Union([Type.Literal("paragraph"), Type.Literal("nothing")]),
            text: Type.String({ description: "Plain sentences, citing sources as [r1]" }),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      }),
      execute: async ({ blocks }) => {
        const r = await api.call("POST", `${base()}/blocks`, JSON.stringify({ blocks }));
        // SAFETY: Contract.UnderstandPlaced.
        const out = JSON.parse(r.text) as Placed;
        const lines = [out.placed.length ? `Placed ${out.placed.join(", ")}.` : "Nothing placed.", ...out.refused.map((x) => `Refused ${x.id}: ${x.reason}`)];

        if (out.refused.length && !out.placed.length) throw new Error(lines.join("\n"));

        return text(lines.join("\n"));
      },
    }),
  ];
}
