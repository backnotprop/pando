// The activity log: each event as one sentence, led by the person who did it
// (or the CI service's mark for a check), as on GitHub's feed. Used by the
// home, a monorepo's Code page (its side column) and its Activity tab.
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import type { FeedEvent } from "@pando/contract";
import { lineKey, takeArrived } from "../live/arrivals";
import { Avatar } from "./Avatar";
import buildkiteMark from "./buildkite-mark.svg";
import { type AppLink, blobLink, branchLink } from "./paths";
import { since, useNow } from "./time";
import { Older } from "./Older";

interface Sentence {
  /** Who leads the line: a person's avatar, a CI service's mark, or an empty slot. */
  person: string | null;
  app: string | null;
  actor: string;
  verb: string;
  bad: boolean;
  object: { text: string; link: AppLink | null } | null;
  tail: string | null;
  repo: string | null;
  machine: string | null;
  /** Shown on hover: a commit title, a version, a check's time. */
  detail: string | null;
}

const VERDICTS = { approve: "approved", request_changes: "asked for changes on", comment: "commented on" } as const;

const CHECK_STATES = { success: "passed on", failure: "failed on", error: "errored on", pending: "started on" } as const;

/** A CI service's name; Buildkite is the only one with a mark for the contest. */
const appName = (app: string) => (app === "buildkite" ? "Buildkite" : app);

function duration(s: number): string {
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
}

export function describe(e: FeedEvent): Sentence {
  const branch = e.branch ? { text: e.branch, link: e.repo_path ? branchLink(e.monorepo, e.repo_path, e.branch) : null } : null;
  const repo = e.repo_path && e.repo_path !== "." ? e.repo_path : null;
  const base = { person: e.actor, app: null, actor: e.actor ?? "someone", bad: false, object: branch, tail: null, repo, machine: e.machine, detail: null };

  switch (e.kind) {
    case "push": {
      const n = e.summary?.commits;

      return { ...base, verb: n ? `pushed ${n} commit${n === 1 ? "" : "s"} to` : "pushed to", detail: e.summary?.head_title ?? null };
    }

    case "branch.opened":
      return { ...base, verb: "opened", detail: e.summary?.head_title ?? null };
    case "branch.deleted":
      return { ...base, verb: "deleted", object: branch && { text: branch.text, link: null } };
    case "merged":
      return { ...base, verb: "merged", tail: "into main", detail: e.summary?.merge_commit?.slice(0, 7) ?? null };
    case "review":
      return { ...base, verb: VERDICTS[e.summary?.verdict ?? "comment"] };
    case "status": {
      const d = e.summary;
      const app = d?.app ?? null;
      const took = d?.duration_s == null ? null : duration(d.duration_s);

      return {
        ...base,
        person: app ? null : e.actor,
        app,
        actor: d?.context ?? "check",
        verb: CHECK_STATES[d?.state ?? "pending"],
        bad: d?.state === "failure" || d?.state === "error",
        machine: null,
        detail: [app ? appName(app) : null, took].filter(Boolean).join(", ") || null,
      };
    }

    case "worktree.reported":
      return { ...base, verb: "added worktree", detail: e.summary?.path ?? null };
    case "worktree.removed":
      return { ...base, verb: "removed worktree", detail: e.summary?.path ?? null };
    case "meta.saved": {
      const path = e.summary?.path ?? "";
      const deleted = e.summary?.deleted ?? false;

      return {
        ...base,
        repo: null,
        verb: deleted ? "deleted" : "saved",
        object: { text: path, link: deleted ? null : blobLink(e.monorepo, path) },
        detail: e.summary?.version ? `version ${e.summary.version}` : null,
      };
    }
  }
}

/** Buildkite's mark beside a check's name; `big` in a heading sits on the baseline with more room (the prototype's .big .ckm). */
export const CheckMark = ({ height = 10, big = false }: { height?: number; big?: boolean }) => (
  <img
    src={buildkiteMark}
    alt="Buildkite"
    title="Buildkite"
    width={height * 1.5}
    height={height}
    className={`inline-block flex-none ${big ? "mr-2 align-[0]" : "mr-1.5 align-[-1px]"}`}
  />
);

/** The sentence. `mini` (the side column) leads with the mark and drops "in" and "from". */
export function Sentence({ s, mini = false }: { s: Sentence; mini?: boolean }) {
  const obj = s.object;
  const objClass = "fox-cool font-mono text-[13px] leading-[16px] text-bark";

  return (
    <span className={`flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap phone:flex-wrap phone:whitespace-normal ${mini ? "text-[13px]" : ""}`}>
      {mini && s.app === "buildkite" ? <CheckMark /> : null}
      <span className="fox-cool text-bark">{s.actor}</span>
      <span className={`fox-cool ${s.bad ? "text-rust" : "text-bark-dim"}`}>{s.verb}</span>
      {obj ? (
        obj.link ? (
          <Link {...obj.link} className={`${objClass} ${mini ? "text-[12.5px]" : ""} hover:underline hover:decoration-ash hover:underline-offset-3`}>
            {obj.text}
          </Link>
        ) : (
          <span className={`${objClass} ${mini ? "text-[12.5px]" : ""}`}>{obj.text}</span>
        )
      ) : null}
      {s.tail ? <span className="fox-cool text-bark-dim">{s.tail}</span> : null}
      {!mini && s.repo ? (
        <span className="fox-cool text-ash">
          in <code className="text-[12.5px] text-ash">{s.repo}</code>
        </span>
      ) : null}
      {!mini && s.machine ? <span className="fox-cool text-ash">from {s.machine}</span> : null}
      {s.detail ? (
        <span className="ml-2 overflow-hidden text-[12px] text-ellipsis text-ash opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 group-focus-visible:opacity-100 phone:hidden">
          {s.detail}
        </span>
      ) : null}
    </span>
  );
}

/** The leading slot: the person's avatar, or the check's mark, so every sentence starts on the same line. */
function Lead({ s }: { s: Sentence }) {
  return (
    <span className="inline-flex size-4 flex-none items-center phone:mt-0.5">
      {s.app === "buildkite" ? <CheckMark height={10.6} /> : s.person ? <Avatar name={s.person} size={16} /> : null}
    </span>
  );
}

function Line({ e, withMonorepo, clock }: { e: FeedEvent; withMonorepo: boolean; clock: number }) {
  const [fresh] = useState(() => takeArrived(lineKey(e)));
  const s = describe(e);
  const [owner, name] = e.monorepo.split("/");

  return (
    <li className={`border-t border-rule-faint first:border-t-0 ${fresh ? "arrived" : ""}`}>
      <div
        tabIndex={-1}
        className={`group -mx-2.5 grid min-h-[38px] items-center gap-4 rounded-[7px] px-2.5 py-1.5 ${withMonorepo ? "grid-cols-[64px_186px_minmax(0,1fr)] phone:grid-cols-[52px_minmax(0,1fr)]" : "grid-cols-[64px_minmax(0,1fr)]"}`}
      >
        <span className="fox-cool font-mono text-[12.5px] whitespace-nowrap text-ash">{since(e.at, clock)}</span>
        {withMonorepo ? (
          <span className="flex items-center gap-2 overflow-hidden font-mono text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-ash phone:hidden">
            <span>
              {owner}/<span className="text-bark-dim">{name}</span>
            </span>
          </span>
        ) : null}
        <span className="flex min-w-0 items-center gap-2.5 phone:items-start">
          <Lead s={s} />
          <Sentence s={s} />
        </span>
      </div>
    </li>
  );
}

/** When a line arrives at the top, the lines below slide down to make room (FLIP), as in the prototype. */
function useMakeRoom(top: string | null) {
  const list = useRef<HTMLUListElement>(null);
  const last = useRef(top);
  useLayoutEffect(() => {
    if (top === last.current) return;
    last.current = top;
    const first = list.current?.firstElementChild;

    if (!(first instanceof HTMLElement) || !first.classList.contains("arrived")) return;

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const h = first.getBoundingClientRect().height;
    const rest = [...(list.current?.children ?? [])].slice(1).filter((x) => x instanceof HTMLElement);

    for (const li of rest) {
      li.style.transition = "none";
      li.style.transform = `translateY(-${h}px)`;
    }

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const li of rest) {
          li.style.transition = "transform .24s var(--ease-pando)";
          li.style.transform = "";
        }
      }),
    );
  }, [top]);

  return list;
}

/** Older pages load one at a time, from the "Older" link at the end (design review: no infinite scroll). */
export interface OlderPages {
  more: boolean;
  loading: boolean;
  load: () => void;
}

export function ActivityList({ events, withMonorepo, older }: { events: readonly FeedEvent[]; withMonorepo: boolean; older: OlderPages }) {
  const clock = useNow();
  const first = events[0];
  const list = useMakeRoom(first ? lineKey(first) : null);

  return (
    <>
      <ul ref={list} aria-label="Activity" data-testid="activity">
        {events.map((e) => (
          <Line key={lineKey(e)} e={e} withMonorepo={withMonorepo} clock={clock} />
        ))}
      </ul>
      <Older {...older} none="No older activity." />
    </>
  );
}

/** The side column's short log: six lines, each with its time at the right. */
export function MiniActivity({ events }: { events: readonly FeedEvent[] }) {
  const clock = useNow();

  return (
    <ul>
      {events.map((e) => (
        <li key={lineKey(e)} className="border-t border-rule-faint first:border-t-0">
          <div className="-mx-2.5 grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[7px] px-2.5 py-[5px]">
            <Sentence s={describe(e)} mini />
            <span className="font-mono text-[12.5px] whitespace-nowrap text-ash">{since(e.at, clock)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
