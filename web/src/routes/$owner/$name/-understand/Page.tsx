// An Understand page (docs/understand/BRIEF.md; the approved mock
// research/design/pando-understand-2026-10-14/understand-v2.html): an essay
// with exhibits. The question is the title; one sentence says who asked and
// who answered; the lines asked about are one code view with the commit that
// last changed each run; the answer is the assistant's paragraphs, and each
// record a paragraph cites is shown under it, once, with the face it has
// elsewhere in Pando (Records.tsx). Every record's facts are Pando's (the
// server fills them); only the paragraphs are the model's. "How this was
// found" is folded at the end. The page is live on its own topic.
import type { UnderstandPage as PageData, UnderstandRef } from "@pando/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { agentModelsQuery } from "../../../../api/agents";
import { reposQuery } from "../../../../api/queries";
import { followUpUnderstand, understandQuery } from "../../../../api/understand";
import { fallback, useRows } from "../../../../live/rows";
import { button, CopyButton, field, Refusal } from "../../../../ui/controls";
import { Chevron } from "../../../../ui/Icons";
import { Title } from "../../../../ui/pages";
import { absolute } from "../../../../ui/paths";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { useMe } from "../-issues/parts";
import { askAssistant } from "../-agents/Assistant";
import { Code } from "./Code";
import { Prose, Record, type Names } from "./Records";

/** The title: the question's first line (the rest of a long question stays in the record). */
const titleOf = (q: string) => q.split("\n", 1)[0] ?? q;

/** A lookup in words, past tense: "Blamed lines 1 to 7 of src/limit.ts: 2 commits". */
const VERB: Record<string, string> = { blame: "Blamed", behind: "Read", history: "Read", commit: "Read", search_shared: "Searched", search_sessions: "Searched", issue: "Read" };

function stepWords(s: PageData["steps"][number]): string {
  const asked = s.tool === "behind" ? "what those commits name" : s.asked;

  return s.error ? `${VERB[s.tool] ?? "Looked up"} ${asked}: skipped, ${s.error}` : `${VERB[s.tool] ?? "Looked up"} ${asked}: ${s.found}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Where it was asked, as the sentence under the title says it. */
function askedFrom(page: PageData): string {
  if (page.from?.kind === "files_changed") return " from Files changed";

  if (page.from?.kind === "commit") return " from a commit";

  if (page.from?.kind === "assistant") return " in the assistant";

  return "";
}

function Byline({ page, model }: { page: PageData; model: string }) {
  const clock = useNow();

  const asked = (
    <>
      {page.asked_by} asked{askedFrom(page)}
      {page.from?.branch ? (
        <>
          {" "}
          on <code className="text-[13px]">{page.from.branch}</code>
        </>
      ) : null}
      , {ago(page.created_at, clock)}.
    </>
  );

  if (page.status === "building") {
    const last = page.steps.at(-1);

    return (
      <p className="col-span-full flex items-center gap-2 text-[14px] text-bark-dim" role="status">
        <span aria-hidden className="size-3 flex-none animate-spin rounded-full border-[1.5px] border-ash border-t-transparent motion-reduce:animate-none" />
        {last ? `${stepWords(last)}.` : "Reading Pando's records."}
      </p>
    );
  }

  return (
    <p className="col-span-full text-[14px] text-bark-dim">
      {asked}{" "}
      {page.status === "failed" ? `It stopped: ${page.reason ?? "the session ended"}.` : page.blocks.length ? `${model} answered from Pando's records.` : "The assistant finished without writing an answer."}
    </p>
  );
}

/** The records found so far, in the order found, before the answer (or with none written): commits, sessions, shared files. */
function SoFar({ page, names }: { page: PageData; names: Names }) {
  const shown = page.refs.filter((r) => r.card && r.card.kind !== "issue");

  const count = (kind: string, one: string, many: string) => {
    const k = page.refs.filter((r) => r.card?.kind === kind).length;

    return k ? `${k} ${k === 1 ? one : many}` : null;
  };

  const found = [count("commit", "commit", "commits"), count("session", "session", "sessions"), count("meta", "shared file", "shared files"), count("issue", "issue", "issues")].filter((x) => x !== null);
  const said = found.length > 1 ? `${found.slice(0, -1).join(", ")} and ${found.at(-1)}` : found[0];

  return (
    <>
      <p className="max-w-[65ch] text-[15px] leading-6 text-bark">
        {page.status === "building" ? `${said ? `Pando found ${said} so far.` : "Pando is reading its records."} The answer is written when the lookups finish.` : said ? `Pando found ${said}.` : "Pando found no record about this."}
      </p>
      {shown.map((r) => (
        <Record key={r.id} ref_={r} page={page} names={names} />
      ))}
    </>
  );
}

/** The answer: each paragraph, then the records it cites for the first time. A `nothing` block opens with Pando's own sentence. */
function Answer({ page, names }: { page: PageData; names: Names }) {
  const shown = new Set<string>();
  const byId = new Map(page.refs.map((r) => [r.id, r]));

  return page.blocks.map((b) => {
    const fresh = b.cites.flatMap((c) => {
      const r = byId.get(c);

      if (!r || shown.has(c) || r.card?.kind === "issue") return [];
      shown.add(c);

      return [r];
    });

    return (
      <section key={b.id} className="grid gap-3.5" data-block={b.id}>
        <p className={`max-w-[65ch] text-[15px] leading-6 ${b.type === "nothing" ? "text-bark" : "text-doc"}`}>
          {b.type === "nothing" ? <>No record explains {page.scope?.kind === "commit" ? "this change" : page.scope ? "these lines" : "this"}. </> : null}
          <span className={b.type === "nothing" ? "text-doc" : ""}>
            <Prose text={b.text} page={page} names={names} />
          </span>
        </p>
        {fresh.map((r: UnderstandRef) => (
          <Record key={r.id} ref_={r} page={page} names={names} />
        ))}
      </section>
    );
  });
}

function Found({ page }: { page: PageData }) {
  if (!page.steps.length) return null;

  return (
    <details className="group text-[13px] text-ash">
      <summary className="inline-flex cursor-pointer list-none items-center gap-[7px] hover:text-bark-dim [&::-webkit-details-marker]:hidden">
        <Chevron className="size-3 -rotate-90 opacity-70 group-open:rotate-0" />
        How this was found
      </summary>
      <ol className="mt-2.5 grid gap-1 pl-[19px]">
        {page.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="text-bark-dim">{stepWords(s)}.</span>
            <span className="ml-auto whitespace-nowrap">{seconds(s.ms)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function FollowUp({ page }: { page: PageData }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);

    try {
      await followUpUnderstand(monorepo, page.number, text.trim());
      setText("");
      // Read again rather than keep the answer: a quick session can finish before the answer arrives, and its live
      // frames (building, then complete) are newer than it.
      await qc.invalidateQueries({ queryKey: understandQuery(monorepo, page.number).queryKey, exact: true });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="flex gap-2">
        <input aria-label="Ask a follow-up" placeholder="Ask a follow-up" value={text} onChange={(e) => setText(e.target.value)} className={`${field} flex-1`} />
        <button type="submit" className={button("solid")}>
          Ask
        </button>
      </div>
      <Refusal error={error} />
    </form>
  );
}

export function UnderstandPage({ n }: { n: number }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const query = understandQuery(monorepo, n);
  const live = useRows(monorepo, [`understand:${n}`], () => void qc.invalidateQueries({ queryKey: query.queryKey, exact: true }));
  const page = useQuery({ ...query, refetchInterval: (q) => (q.state.data?.status === "building" ? fallback(live) : false) }).data;
  const models = useQuery(agentModelsQuery(monorepo)).data ?? [];
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const me = useMe();

  if (!page) return null;
  const model = models.find((x) => x.id === page.model)?.name ?? page.model;
  const names: Names = { full: monorepo.full, repoPath: (name) => repos.find((r) => r.name === name)?.path ?? "." };
  const nothing = page.blocks.some((b) => b.type === "nothing");
  const scope = page.scope;

  return (
    <article className="grid max-w-[720px] gap-7" data-status={page.status}>
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 phone:grid-cols-1">
        <Title>{titleOf(page.question)}</Title>
        <CopyButton text={absolute(`/${monorepo.full}/understand/${page.number}`)} label="Copy link" className={`${button("quiet", 30)} phone:row-start-3 phone:justify-self-start`} />
        <Byline page={page} model={model} />
      </header>

      {page.lines ? <Code lines={page.lines} page={page} names={names} /> : null}

      {page.blocks.length ? <Answer page={page} names={names} /> : <SoFar page={page} names={names} />}

      {nothing && scope?.kind === "lines" ? (
        <div>
          <button type="button" className={button("quiet", 30)} onClick={() => askAssistant(`What does ${scope.path}, lines ${scope.start} to ${scope.end}, do?`, scope.repo)}>
            Ask the assistant what this code does
          </button>
        </div>
      ) : null}

      {me === page.asked_by && !nothing && page.status !== "building" ? <FollowUp page={page} /> : null}

      <Found page={page} />
    </article>
  );
}
