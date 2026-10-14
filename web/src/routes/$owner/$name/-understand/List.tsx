// /{owner}/{name}/understand: the repository's Understand pages, newest first,
// with the box to ask a question about the code. Every member sees every page;
// a page is its question, who asked, and how it stands.
import type { UnderstandRow } from "@pando/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { askUnderstand, understandListQuery, understandQuery } from "../../../../api/understand";
import { fallback, useRows } from "../../../../live/rows";
import { button, Empty, field, Refusal, row } from "../../../../ui/controls";
import { Title } from "../../../../ui/pages";
import { understandLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";

/** How a page stands, in words. */
function standing(p: UnderstandRow): string {
  if (p.status === "building") return "Building";

  if (p.status === "failed") return "Stopped";

  return p.cited ? `${p.cited} ${p.cited === 1 ? "record" : "records"} cited` : "No record cited";
}

function Ask() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    // One question at a time: a second press while the first is asked does nothing.
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);

    try {
      const page = await askUnderstand(monorepo, text.trim(), null, null);

      setText("");
      qc.setQueryData(understandQuery(monorepo, page.number).queryKey, page);
      await navigate(understandLink(monorepo.full, page.number));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-[720px]">
      <div className="flex gap-2">
        <input aria-label="Ask about the code" placeholder="Ask why something in this repository is the way it is" value={text} onChange={(e) => setText(e.target.value)} className={`${field} flex-1`} />
        <button type="submit" className={button("solid")}>
          Ask
        </button>
      </div>
      <Refusal error={error} />
    </form>
  );
}

export function UnderstandList() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const clock = useNow();
  const query = understandListQuery(monorepo);
  const live = useRows(monorepo, ["understand"], () => void qc.invalidateQueries({ queryKey: query.queryKey, exact: true }));
  const pages = useQuery({ ...query, refetchInterval: fallback(live) }).data?.pages;

  return (
    <div className="grid max-w-[880px] gap-7">
      <div className="grid gap-2">
        <Title>Understand</Title>
        <p className="text-[14px] text-bark-dim">Ask the code why it is the way it is. The answer comes from Pando's records: commits, sessions, shared files and issues.</p>
      </div>
      <Ask />
      {pages === undefined ? null : pages.length ? (
        <ul aria-label="Pages" className="grid">
          {pages.map((p) => (
            <li key={p.number} className={`${row} grid-cols-[minmax(0,1fr)_auto] border-t border-rule-faint first:border-t-0`}>
              <span className="min-w-0">
                <Ref kind="name" link={understandLink(monorepo.full, p.number)} className="block overflow-hidden text-ellipsis whitespace-nowrap">
                  {p.question.split("\n", 1)[0]}
                </Ref>
                <span className="text-[13px] text-ash">
                  {p.asked_by} asked {ago(p.created_at, clock)}. {standing(p)}.
                </span>
              </span>
              <span className="text-[12.5px] text-ash">#{p.number}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No questions asked yet.</Empty>
      )}
    </div>
  );
}
