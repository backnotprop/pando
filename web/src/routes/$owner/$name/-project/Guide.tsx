// A branch's Guided review tab (docs/risk-review/DESIGN.md): the guide Pando
// wrote for a head a person must approve, drawn with Pando's own pieces. The
// guide is Plannotator's snapshot (GuideSnapshotV1, the guide artifact's
// guided-review.json): its title and intent, then its sections in reading
// order, each with its overview (Markdown, as issues show it) and its files,
// each file's summary over its diff in Files changed's own list (-code/DiffList,
// Pierre's CodeView, themed by Pando's tokens), drawn from the patch the guide
// was written against. A section ticked as reviewed folds; the ticks stay in
// this browser, by the guide's version. On the right: the reading progress,
// then the branch's Merge box and Risk review (Approve), so a person reads and
// approves in one place. Plannotator's HTML export stays for download.
import type { Branch, ChangedFile, Repo } from "@pando/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileHref } from "../../../../api/artifacts";
import { type GuidePart, type GuideRead, guideQuery } from "../../../../api/review";
import { Empty, lnk, SectionHead } from "../../../../ui/controls";
import { CheckIcon, Chevron } from "../../../../ui/Icons";
import { branchArtifactsLink } from "../../../../ui/paths";
import { useColourViews } from "../-code/coloured";
import { useMonorepo } from "../-frame/heads";
import { Markdown } from "../-issues/Markdown";
import { Header, list } from "./FilesChanged";

/** The guide artifact's version and its snapshot file, as the branch's review names them. */
type GuideRef = NonNullable<NonNullable<Branch["review"]>["guide"]>;

/** The ticks, kept in this browser by the guide's version (a new head writes a new version). */
function useTicks(guide: GuideRef, count: number) {
  const key = `pando.guide.${guide.artifact}.${guide.version}`;

  const [ticks, setTicks] = useState<boolean[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");

      return Array.from({ length: count }, (_, i) => Array.isArray(saved) && saved[i] === true);
    } catch {
      return Array.from({ length: count }, () => false);
    }
  });

  const tick = (i: number) =>
    setTicks((t) => {
      const next = t.map((v, j) => (j === i ? !v : v));

      localStorage.setItem(key, JSON.stringify(next));

      return next;
    });

  return { ticks, tick };
}

/** True once the element has come within a screen of the window; it stays drawn after (a diff is costly to start, cheap to keep). */
function useNear<E extends Element>() {
  const ref = useRef<E>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;

    if (!el || near) return;

    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: "100% 0px" });

    seen.observe(el);

    return () => seen.disconnect();
  }, [near]);

  return { ref, near };
}

/** The card's height: the whole diff at the list's metrics (DiffList: a 44 px header, 20 px lines, a 32 px rule between hunks), up to 640 px; a longer one scrolls inside. */
function heightOf(f: ChangedFile, closed: boolean): number {
  if (closed) return 46;
  const lines = (f.patch ?? "").split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const body = start < 0 ? [] : lines.slice(start).filter((l) => l !== "");
  const hunks = body.filter((l) => l.startsWith("@@")).length;

  return Math.min(640, 44 + 26 + hunks * 32 + (body.length - hunks) * 20);
}

/** A line of the guide's own words, its `code` spans set as code (the summaries and the intent are plain text with backticks). */
function Words({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="rounded-[4px] bg-loam px-1 py-px font-mono text-[0.9em] text-bark">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** One file of a section: what changed in it, in a sentence, over its diff. */
function FileCard({ repo, head, at, path, file, summary }: { repo: Repo; head: string; at: number; path: string; file: ChangedFile | null; summary: string | null }) {
  const views = useColourViews();
  const { ref, near } = useNear<HTMLDivElement>();
  const [closed, setClosed] = useState(false);
  const closedSet = useMemo<ReadonlySet<string>>(() => new Set(closed ? [path] : []), [closed, path]);
  const files = useMemo(() => (file ? [file] : []), [file]);
  const idOf = useCallback((f: ChangedFile) => `guide:${head}:${at}:${f.path}`, [head, at]);
  const ends = { after: head, before: null, files_total: 1, too_many_files: false };

  return (
    <div className="mt-5">
      {summary ? (
        <p className="mb-2.5 text-[13.5px] leading-[20px] text-bark-dim">
          <Words text={summary} />
        </p>
      ) : null}
      {file ? (
        <div ref={ref} style={{ height: heightOf(file, closed) }}>
          {near && views ? (
            <views.DiffList
              files={files}
              closed={closedSet}
              target={null}
              onTop={noop}
              idOf={idOf}
              className={list}
              header={(f) => <Header repo={repo} what="branch" ends={ends} f={f} open={!closed} current={false} toggle={() => setClosed(!closed)} />}
            />
          ) : (
            <div className="h-full rounded-[10px] shadow-[0_0_0_1px_var(--rootline)]" />
          )}
        </div>
      ) : (
        <p className="rounded-[10px] px-4 py-3 text-[13px] text-ash shadow-[0_0_0_1px_var(--rootline)]">
          <code className="text-bark-dim">{path}</code>: no lines in this diff (a binary file, or one too large to send)
        </p>
      )}
    </div>
  );
}

const noop = () => {};

/** The Reviewed tick on a section's head. */
function Tick({ on, toggle, label }: { on: boolean; toggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={toggle}
      className={`flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] ${on ? "bg-loam text-bark" : "text-bark-dim shadow-[inset_0_0_0_1px_var(--ash-half)] hover:text-bark"}`}
    >
      <span className={`flex size-3.5 items-center justify-center rounded-[4px] ${on ? "bg-bark text-soil" : "shadow-[inset_0_0_0_1px_var(--ash)]"}`}>
        {on ? <CheckIcon className="size-3" /> : null}
      </span>
      Reviewed
    </button>
  );
}

function Section({ repo, head, at, part, ticked, tick }: { repo: Repo; head: string; at: number; part: GuidePart; ticked: boolean; tick: () => void }) {
  const { monorepo } = useMonorepo();
  // A ticked section folds; its title opens it again.
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? !ticked;

  return (
    <section id={`guide-${at + 1}`} aria-label={part.title} className="scroll-mt-6 border-t border-rule-faint pt-6 pb-8 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        <span className="mt-[3px] flex size-6 flex-none items-center justify-center rounded-full bg-loam font-mono text-[12px] text-bark-dim">{at + 1}</span>
        <h3 className="min-w-0 flex-1">
          <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className="flex cursor-pointer items-start gap-2 text-left text-[17px] leading-[26px] font-semibold text-bark hover:text-bark-hi">
            {part.title}
            <Chevron className={`mt-[7px] size-3.5 flex-none text-ash ${shown ? "" : "-rotate-90"}`} />
          </button>
          <span className="mt-0.5 block text-[12.5px] font-normal text-ash">
            {part.files.length} file{part.files.length === 1 ? "" : "s"}
          </span>
        </h3>
        <Tick on={ticked} toggle={() => { tick(); setOpen(null); }} label={`Reviewed: ${part.title}`} />
      </div>
      {shown ? (
        <div className="mt-3 pl-9 narrow:pl-0">
          {part.overview.trim() ? <Markdown text={part.overview} full={monorepo.full} /> : null}
          {part.files.map((f) => (
            <FileCard key={f.path} repo={repo} head={head} at={at} path={f.path} file={f.file} summary={f.summary} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The right column's top: how far the reading has got, each section a jump to it. */
function Progress({ parts, ticks }: { parts: readonly GuidePart[]; ticks: readonly boolean[] }) {
  const done = ticks.filter(Boolean).length;

  return (
    <nav aria-label="Sections" className="mb-10">
      <SectionHead title="Sections" right={<span className="text-ash">{`${done} of ${parts.length} reviewed`}</span>} />
      <div aria-hidden className="mb-3 h-1 overflow-hidden rounded-full bg-rule-faint">
        <div className="h-full rounded-full bg-bark-dim transition-[width] duration-300" style={{ width: `${parts.length ? (done / parts.length) * 100 : 0}%` }} />
      </div>
      <ol className="grid gap-0.5">
        {parts.map((p, i) => (
          <li key={i}>
            <a href={`#guide-${i + 1}`} className="-mx-2 flex items-baseline gap-2.5 rounded-[6px] px-2 py-1 text-[13px] hover:bg-loam">
              <span className={`flex size-3.5 flex-none translate-y-[2px] items-center justify-center rounded-[4px] ${ticks[i] ? "bg-bark text-soil" : "shadow-[inset_0_0_0_1px_var(--ash-half)]"}`}>
                {ticks[i] ? <CheckIcon className="size-3" /> : null}
              </span>
              <span className={ticks[i] ? "text-ash" : "text-bark"}>{p.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Guide({ repo, b, guide, read, aside }: { repo: Repo; b: Branch; guide: GuideRef; read: GuideRead; aside: ReactNode }) {
  const { monorepo } = useMonorepo();
  const { parts } = read;
  const { ticks, tick } = useTicks(guide, parts.length);
  const head = read.head ?? b.head;
  const model = read.model;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
      <article aria-label="Guided review">
        <p className="text-[12.5px] text-ash">
          Guided review of <code className="text-bark-dim">{head.slice(0, 7)}</code>
          {model ? `, written by Pando with ${model.replace(/^@cf\//, "")}` : ", written by Pando"}.{" "}
          <a href={fileHref(monorepo, guide.artifact, guide.version, "guided-review.html")} download="guided-review.html" className={lnk}>
            Download
          </a>
        </p>
        <h2 className="mt-2 text-[22px] leading-[29px] font-semibold tracking-[-.01em] text-bark">{read.title}</h2>
        {read.intent ? (
          <p className="mt-2 max-w-[46em] text-[14.5px] leading-[22px] text-bark-dim">
            <Words text={read.intent} />
          </p>
        ) : null}
        <div className="mt-8">
          {parts.map((p, i) => (
            <Section key={i} repo={repo} head={head} at={i} part={p} ticked={ticks[i] ?? false} tick={() => tick(i)} />
          ))}
        </div>
      </article>
      <aside>
        <Progress parts={parts} ticks={ticks} />
        {aside}
      </aside>
    </div>
  );
}

/** The tab's body: the guide, or where it stands (being written, failed, written before Pando kept its data). */
export function GuideTab({ repo, b, aside }: { repo: Repo; b: Branch; aside: ReactNode }) {
  const { monorepo } = useMonorepo();
  const r = b.review;
  const guide = r?.guide ?? null;
  const snapshot = guide?.snapshot ?? null;
  const query = useQuery({ ...guideQuery(monorepo, { artifact: guide?.artifact ?? "", version: guide?.version ?? 1, snapshot: snapshot ?? "" }), enabled: !!snapshot });

  if (!r || r.guide_state === "none") return <Empty>This head has no guided review: Pando writes one when a change needs a person's approval.</Empty>;

  if (r.guide_state === "writing") return <Empty>Pando is writing the guided review of this head.</Empty>;

  if (!guide) return <Empty>The guided review could not be written for this head.</Empty>;

  if (!snapshot) {
    return (
      <Empty>
        This guided review was written before Pando kept it as data.{" "}
        <Link {...branchArtifactsLink(monorepo.full, repo.path, b.name, { artifact: "guided-review.html" })} className={lnk}>
          Open it in Artifacts
        </Link>
      </Empty>
    );
  }

  if (query.data) return <Guide repo={repo} b={b} guide={guide} read={query.data} aside={aside} />;

  return query.isError ? <Empty>The guided review could not be read: {query.error.message}</Empty> : <div className="min-h-24" />;
}
