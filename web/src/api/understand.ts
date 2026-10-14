// Understand pages (docs/understand/DESIGN.md): the repository's list, one
// page, asking and following up. Keys sit under ["m", owner, name,
// "understand"], so an understand.updated row on the page's socket
// (live/rows.ts) can read them again.
import { Routes, type UnderstandPage } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import { get, type JsonValue, write } from "./client";
import type { MonorepoRef } from "./names";

export const understandKey = (m: MonorepoRef) => ["m", m.owner, m.name, "understand"] as const;

/** The repository's pages, newest first (the first page; the list is short). */
export const understandListQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...understandKey(m), "list"],
    queryFn: () => {
      const route = Routes.listUnderstand(m.owner, m.name);

      return get(route.response, route.path);
    },
  });

/** One page, its records as they read now. */
export const understandQuery = (m: MonorepoRef, n: number) =>
  queryOptions({
    queryKey: [...understandKey(m), "n", n],
    queryFn: () => {
      const route = Routes.getUnderstand(m.owner, m.name, n);

      return get(route.response, route.path);
    },
  });

/** What was asked about: lines of a file at a commit or branch, or one commit. */
export type AskScope = { kind: "lines"; repo: string; path: string; ref: string; start: number; end: number } | { kind: "commit"; repo: string; sha: string };

/** Where it was asked. */
export interface AskFrom {
  kind: "files_changed" | "commit" | "assistant";
  branch?: string;
}

/** Asks a question: the page answers at once, building; it streams in on its socket. */
export function askUnderstand(m: MonorepoRef, question: string, scope: AskScope | null, from: AskFrom | null): Promise<UnderstandPage> {
  const body = new Map<string, JsonValue>([["question", question]]);

  if (scope) body.set("scope", { ...scope });

  if (from) body.set("from", { ...from });

  return write(Routes.askUnderstand(m.owner, m.name), Object.fromEntries(body));
}

/** A follow-up from the asker: the page's next revision. */
export const followUpUnderstand = (m: MonorepoRef, n: number, question: string): Promise<UnderstandPage> => write(Routes.followUpUnderstand(m.owner, m.name, n), { question });

/** The question for lines asked about from Files changed: "Why are lines 12 to 18 of src/limit.ts the way they are?" */
export const linesQuestion = (path: string, start: number, end: number) =>
  start === end ? `Why is line ${start} of ${path} the way it is?` : `Why are lines ${start} to ${end} of ${path} the way they are?`;
