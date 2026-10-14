// The activity log: each event as one sentence, led by the person who did it
// (or the CI service's mark for a check), as on GitHub's feed. Used by the
// home, a monorepo's Code page (its side column) and its Activity tab. A
// sentence links who (a person's page, or a check's build page) and what (the
// branch, issue or file, in Link: owner ruling, links R); its places ("in
// projects/web", "from ana-mbp") are plain context. The whole row goes to what
// the sentence is about: a link stretched under the row, with the sentence's
// links above it.
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import type { FeedEvent } from "@pando/contract";
import { lineKey, takeArrived } from "../live/arrivals";
import { Avatar } from "./Avatar";
import buildkiteMark from "./buildkite-mark.svg";
import { type AppLink, blobLink, branchesLink, branchLink, ciBuildLink, commitLink, historyLink, issueLink, monoLink, ownerLink, repoLink } from "./paths";
import { type IssueState, IssueRef, Ref } from "./Ref";
import { duration, since, useNow } from "./time";
import { Older } from "./Older";

/** What a line is about: a branch or a commit (SF Mono), a saved file's path, or an issue (its number, with its state glyph). */
interface LineObject {
  kind: "branch" | "commit" | "file" | "issue";
  text: string;
  link: AppLink | null;
  /** An issue's number and its state as of the line's event. */
  issue?: IssueState & { number: number };
}

interface Sentence {
  /** The repository the line is in (`owner/name`). */
  monorepo: string;
  /** Who leads the line: a person's avatar, a CI service's mark, or an empty slot. */
  person: string | null;
  app: string | null;
  actor: string;
  /** A person's page (theirs, as an owner), or a check's build page in Pando; else (`actorHref`) the check's page at its CI service. None for a save's author, a name not a login. */
  actorLink: AppLink | null;
  actorHref: string | null;
  verb: string;
  bad: boolean;
  object: LineObject | null;
  tail: string | null;
  /** The issues a merge closed ("closing #9"), each a reference. */
  closes: readonly number[];
  repo: string | null;
  /** The project's page, for "in projects/web". */
  repoLink: AppLink | null;
  machine: string | null;
  /** Shown on hover: a commit title, a version, a check's time; `detailSha`, a merge commit (SF Mono). */
  detail: string | null;
  detailSha?: boolean;
  /** Where the whole row goes: its object's page, else its project's, else its repository's. */
  target: AppLink;
}

const VERDICTS = { approve: "approved", request_changes: "asked for changes on", comment: "commented on" } as const;

const CHECK_STATES = { success: "passed on", failure: "failed on", error: "errored on", pending: "started on", superseded: "superseded on" } as const;

/** A CI service's name; Buildkite is the only one with a mark for the contest. */
const appName = (app: string) => (app === "buildkite" ? "Buildkite" : app);

export function describe(e: FeedEvent): Sentence {
  const s = sentence(e);
  const project = e.repo_path && e.repo_path !== "." ? repoLink(e.monorepo, e.repo_path) : null;

  return { ...s, target: s.object?.link ?? project ?? monoLink(e.monorepo) };
}

function sentence(e: FeedEvent): Omit<Sentence, "target"> {
  const branch: LineObject | null = e.branch ? { kind: "branch", text: e.branch, link: e.repo_path ? branchLink(e.monorepo, e.repo_path, e.branch) : null } : null;
  const repo = e.repo_path && e.repo_path !== "." ? e.repo_path : null;

  const base = {
    monorepo: e.monorepo,
    person: e.actor,
    app: null,
    actor: e.actor ?? "someone",
    actorLink: e.actor ? ownerLink(e.actor) : null,
    actorHref: null,
    bad: false,
    object: branch,
    tail: null,
    closes: [],
    repo,
    repoLink: repo ? repoLink(e.monorepo, repo) : null,
    machine: e.machine,
    detail: null,
  };

  switch (e.kind) {
    case "push": {
      const n = e.summary?.commits;

      return { ...base, verb: n ? `pushed ${n} commit${n === 1 ? "" : "s"} to` : "pushed to", detail: e.summary?.head_title ?? null };
    }

    case "branch.opened":
      return { ...base, verb: "opened", detail: e.summary?.head_title ?? null };
    case "branch.deleted":
      // Its page is gone; the project's branches list is where it was.
      return { ...base, verb: "deleted", object: branch && { ...branch, link: e.repo_path ? branchesLink(e.monorepo, e.repo_path) : null } };
    case "merged": {
      const closes = e.summary?.closes ?? [];

      return { ...base, verb: "merged", tail: closes.length ? "into main, closing" : "into main", closes, detail: e.summary?.merge_commit?.slice(0, 7) ?? null, detailSha: true };
    }

    case "review":
      return { ...base, verb: VERDICTS[e.summary?.verdict ?? "comment"] };
    case "status": {
      const d = e.summary;
      const app = d?.app ?? null;
      const took = d?.duration_s == null ? null : duration(d.duration_s);

      // On a commit no branch is at (main's, or a deleted branch's): the branch the server names, else the commit itself, opening its page.
      const on: LineObject | null = base.object ?? (d?.sha ? { kind: "commit", text: d.sha.slice(0, 7), link: e.repo_path ? commitLink(e.monorepo, e.repo_path, d.sha) : null } : null);

      return {
        ...base,
        object: on,
        person: app ? null : e.actor,
        app,
        actor: d?.context ?? "check",
        // The build Pando holds for it opens here, as a branch page's checks do; a status with none opens its own page.
        actorLink: d?.build ? ciBuildLink(e.monorepo, d.build.pipeline, d.build.number) : null,
        actorHref: !d?.build && d?.target_url && /^https?:\/\//.test(d.target_url) ? d.target_url : null,
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
        repoLink: null,
        // A save's actor is its author's name, not a login: no page.
        actorLink: null,
        verb: deleted ? "deleted" : "saved",
        object: { kind: "file", text: path, link: deleted ? historyLink(e.monorepo, path) : blobLink(e.monorepo, path) },
        detail: e.summary?.version ? `version ${e.summary.version}` : null,
      };
    }

    // Issues: the number as the object (with its state glyph as of the event, opening the issue), then its title; a close says how instead.
    case "issue.opened":
    case "issue.commented":
    case "issue.closed":
    case "issue.reopened": {
      const d = e.summary;
      const verb = { "issue.opened": "opened", "issue.commented": "commented on", "issue.closed": "closed", "issue.reopened": "reopened" }[e.kind];
      const how = d?.reason === "not_planned" ? "as not planned" : "as completed";

      return {
        ...base,
        verb,
        object: d
          ? {
              kind: "issue",
              text: `#${d.number}`,
              link: issueLink(e.monorepo, d.number),
              issue: { number: d.number, state: e.kind === "issue.closed" ? "closed" : "open", reason: e.kind === "issue.closed" ? (d.reason ?? "completed") : null },
            }
          : null,
        tail: d ? (e.kind === "issue.closed" ? how : d.title) : null,
        detail: d?.excerpt ?? null,
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

/** The words of a row, for the row link's name. */
const said = (s: Sentence) =>
  [s.actor, s.verb, s.object?.text, s.tail, s.closes.map((n) => `#${n}`).join(", "), s.repo ? `in ${s.repo}` : null].filter(Boolean).join(" ");

/** What the line is about, in Link (links R), with a faint underline: it sits in running text. */
export function ObjectRef({ s, obj }: { s: Sentence; obj: LineObject }) {
  if (obj.kind === "issue" && obj.issue) return <IssueRef full={s.monorepo} number={obj.issue.number} state={obj.issue.state} reason={obj.issue.reason} text above className="fox-cool" />;

  const mono = obj.kind === "branch" || obj.kind === "commit";

  return obj.link ? (
    <Ref kind="object" link={obj.link} text mono={mono} above className="fox-cool">
      {obj.text}
    </Ref>
  ) : (
    <span className={`fox-cool text-bark ${mono ? "font-mono text-[13px]" : ""}`}>{obj.text}</span>
  );
}

/** The sentence. `mini` (the side column) leads with the mark and drops "in" and "from". */
export function Sentence({ s, mini = false }: { s: Sentence; mini?: boolean }) {
  const obj = s.object;

  return (
    <span className={`flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap phone:flex-wrap phone:whitespace-normal ${mini ? "text-[13px]" : ""}`}>
      {mini && s.app === "buildkite" ? <CheckMark /> : null}
      {s.actorLink ? (
        <Ref kind="person" link={s.actorLink} above className="fox-cool">
          {s.actor}
        </Ref>
      ) : s.actorHref ? (
        <Ref kind="person" href={s.actorHref} above className="fox-cool">
          {s.actor}
        </Ref>
      ) : (
        <span className="fox-cool font-semibold text-bark">{s.actor}</span>
      )}
      <span className={`fox-cool ${s.bad ? "text-rust" : "text-bark-dim"}`}>{s.verb}</span>
      {obj ? <ObjectRef s={s} obj={obj} /> : null}
      {s.tail ? <span className="fox-cool text-bark-dim">{s.tail}</span> : null}
      {s.closes.map((n, i) => (
        <span key={n} className="fox-cool text-bark-dim">
          {" "}
          <IssueRef full={s.monorepo} number={n} state="closed" reason="completed" text above />
          {i < s.closes.length - 1 ? "," : null}
        </span>
      ))}
      {!mini && s.repo ? <span className="fox-cool text-ash">in {s.repo}</span> : null}
      {!mini && s.machine ? <span className="fox-cool text-ash">from {s.machine}</span> : null}
      {s.detail ? (
        <span
          className={`ml-2 overflow-hidden text-ellipsis text-ash opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 group-has-focus-visible:opacity-100 phone:hidden ${s.detailSha ? "font-mono text-[12px]" : "text-[12px]"}`}
        >
          {s.detail}
        </span>
      ) : null}
    </span>
  );
}

/** The whole row's link, stretched under it: what the sentence is about. Its inner links sit above it, so none is nested in another. */
function RowLink({ s }: { s: Sentence }) {
  return <Link {...s.target} aria-label={said(s)} className="absolute inset-0 rounded-[7px] focus-visible:outline-offset-[-1.5px]" />;
}

/** The leading slot: the person's avatar, or the check's mark, so every sentence starts on the same line. */
function Lead({ s }: { s: Sentence }) {
  return (
    <span className="inline-flex size-4 flex-none items-center phone:mt-0.5">
      {s.app === "buildkite" ? <CheckMark height={10.6} /> : s.person ? <Avatar name={s.person} size={16} /> : null}
    </span>
  );
}

/** The line's repository, in its column: Bark-dim, Link under the pointer; on the owner's own page (`owner`), its name alone. */
function RepoColumn({ full, owner }: { full: string; owner: string | null }) {
  const [who = "", name = ""] = full.split("/");

  return (
    <span className="flex items-center gap-2 overflow-hidden text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap phone:hidden">
      <Link {...monoLink(full)} className="relative z-10 text-bark-dim decoration-1 underline-offset-3 hover:text-link hover:underline">
        {who === owner ? null : <span className="text-ash">{who}/</span>}
        {name}
      </Link>
    </span>
  );
}

function Line({ e, withMonorepo, owner, clock }: { e: FeedEvent; withMonorepo: boolean; owner: string | null; clock: number }) {
  const [fresh] = useState(() => takeArrived(lineKey(e)));
  const s = describe(e);

  return (
    <li className={`border-t border-rule-faint first:border-t-0 ${fresh ? "arrived" : ""}`}>
      <div
        className={`group relative -mx-2.5 grid min-h-[38px] items-center gap-4 rounded-[7px] px-2.5 py-1.5 hover:bg-air ${withMonorepo ? "grid-cols-[64px_186px_minmax(0,1fr)] phone:grid-cols-[52px_minmax(0,1fr)]" : "grid-cols-[64px_minmax(0,1fr)]"}`}
      >
        <RowLink s={s} />
        <span className="fox-cool text-[12.5px] whitespace-nowrap text-ash">{since(e.at, clock)}</span>
        {withMonorepo ? <RepoColumn full={e.monorepo} owner={owner} /> : null}
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

/** `owner`: the page is that owner's (an organization's or a person's), so the repository column leaves the owner off. */
export function ActivityList({ events, withMonorepo, owner = null, older }: { events: readonly FeedEvent[]; withMonorepo: boolean; owner?: string | null; older: OlderPages }) {
  const clock = useNow();
  const first = events[0];
  const list = useMakeRoom(first ? lineKey(first) : null);

  return (
    <>
      <ul ref={list} aria-label="Activity" data-testid="activity">
        {events.map((e) => (
          <Line key={lineKey(e)} e={e} withMonorepo={withMonorepo} owner={owner} clock={clock} />
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
      {events.map((e) => {
        const s = describe(e);

        return (
          <li key={lineKey(e)} className="border-t border-rule-faint first:border-t-0">
            <div className="group relative -mx-2.5 grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[7px] px-2.5 py-[5px] hover:bg-air">
              <RowLink s={s} />
              <Sentence s={s} mini />
              <span className="text-[12.5px] whitespace-nowrap text-ash">{since(e.at, clock)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
