// A branch's page is the pull request: its title, then two tabs. Overview:
// its commits (with co-authors), its reviews, and on the right the Merge box,
// its checks (each with its CI service's mark and a link to the run) and its
// worktree. Merge lands exactly the head on screen (expected_head); a refusal
// is shown in the box, in words. Files changed: each file's diff, read only
// (FilesChanged.tsx).
import { type QueryClient, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { merge } from "../../../../api/actions";
import type { MonorepoRef } from "../../../../api/names";
import type { Branch, Checks, Commit, Repo, Review, Status } from "@pando/contract";
import { branchDiffQuery, branchQuery, type CheckRun, checkRunsQuery, commitsQuery, repoKey, reviewsQuery, worktreeQuery } from "../../../../api/projects";
import { CheckMark } from "../../../../ui/activity";
import { Avatar } from "../../../../ui/Avatar";
import { button, Empty, SectionHead, useCopy } from "../../../../ui/controls";
import { Title } from "../../../../ui/pages";
import { fallback, useRows } from "../../../../live/rows";
import { useArrivals } from "../../../../ui/arrival";
import { branchLink, ciBuildLink } from "../../../../ui/paths";
import { Tab, TabBar } from "../../../../ui/TabBar";
import { ago, elapsed, since, useNow, useSeconds } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { FilesChanged } from "./FilesChanged";
import { mergeableOf, stateOf, unknownWhy } from "./state";

/** `files`: the Files changed tab waits for the diff; Overview fetches it alongside, for the tab's count. */
export async function loadBranch(qc: QueryClient, m: MonorepoRef, repo: Repo, branch: string, files: boolean) {
  const diff = qc.prefetchQuery(branchDiffQuery(m, repo.name, branch));

  await Promise.all([
    qc.ensureQueryData(branchQuery(m, repo.name, branch)),
    qc.ensureQueryData(commitsQuery(m, repo.name, branch)),
    qc.ensureQueryData(reviewsQuery(m, repo.name, branch)),
    files ? diff : null,
  ]);
}

const solid = button("solid");

const quiet = button("quiet");

const big = "text-[15px] font-semibold";

const q = "text-[13px] leading-[19px] text-bark-dim";

/** "ramos and Claude": the author, then any Co-authored-by names. */
function Authors({ c }: { c: Commit }) {
  const co = (c.co_authors ?? []).map((a) => a.name);

  return (
    // On a phone the line spans the row under the title, in full.
    <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[13px] whitespace-nowrap text-bark-dim phone:whitespace-normal">
      {c.author.name ? <Avatar name={c.author.name} size={18} /> : null}
      <span className="min-w-0 overflow-hidden text-ellipsis phone:overflow-visible">
        {c.author.name ?? ""}
        {co.length ? <span className="text-ash"> and {co.join(", ")}</span> : null}
      </span>
    </span>
  );
}

function Commits({ commits }: { commits: readonly Commit[] }) {
  const clock = useNow();

  return (
    <ul aria-label="Commits">
      {commits.map((c) => (
        <li key={c.sha} className="border-t border-rule-faint">
          <div className="-mx-2.5 grid min-h-10 grid-cols-[76px_minmax(0,1fr)_200px_56px] items-center gap-4 rounded-[7px] px-2.5 py-2 phone:grid-cols-[64px_minmax(0,1fr)]">
            <span className="font-mono text-[13.5px] leading-[16px] text-bark-dim">{c.sha.slice(0, 7)}</span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{c.title}</span>
            <span className="phone:col-span-2">
              <Authors c={c} />
            </span>
            <span className="text-right font-mono text-[12.5px] whitespace-nowrap text-ash phone:hidden">{c.author.date ? since(c.author.date, clock) : ""}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

const VERDICT = { approve: "approved", request_changes: "asked for changes", comment: "commented" } as const;

function Reviews({ reviews }: { reviews: readonly Review[] }) {
  const clock = useNow();

  if (!reviews.length) return <Empty>No reviews yet.</Empty>;

  return (
    <ul aria-label="Reviews">
      {reviews.map((r) => (
        <li key={r.id} className="border-t border-rule-faint first:border-t-0">
          <div className="-mx-2.5 grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[7px] px-2.5 py-2">
            <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
              <span className="self-center">
                <Avatar name={r.author} size={16} />
              </span>
              <span className="text-bark">{r.author}</span>
              <span className="text-bark-dim">{VERDICT[r.verdict]}</span>
              {r.body ? <span className="overflow-hidden text-[13px] text-ellipsis text-ash">{r.body}</span> : null}
            </span>
            <span className="font-mono text-[12.5px] whitespace-nowrap text-ash">{since(r.created_at, clock)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A check's state in words: its job's, when a CI service runs it; else its status's. */
function checkWord(s: Status | undefined, run: CheckRun | undefined): string {
  if (run) return run.job.state;

  if (!s) return "not reported";

  return s.state === "success" ? "passed" : s.state === "pending" ? "running" : s.state === "failure" ? "failed" : "errored";
}

const toneOf = (word: string) => (word === "passed" ? "text-bark-dim" : word === "failed" || word === "errored" ? "font-semibold text-rust" : "text-ash");

/**
 * Each required or reported check, as GitHub lists them: its CI service's
 * mark, its name (opening its job on the build's page), its state in words,
 * and its time, which ticks each second while it runs. A check that moves
 * while the page is open plays the arrival.
 */
function CheckRows({ repo, branch, checks, live }: { repo: Repo; branch: Branch; checks: Checks; live: boolean }) {
  const { monorepo, info } = useMonorepo();
  // Read from Pando's stored builds, not only when a status names a service: a job shows the moment it is queued.
  const runs = useQuery({ ...checkRunsQuery(monorepo, repo.name, branch.name, branch.head), refetchInterval: fallback(live) }).data?.runs;
  const names = [...new Set([...(checks.required ?? []), ...checks.statuses.map((s) => s.context), ...(runs?.keys() ?? [])])];
  const words = names.map((name) => checkWord(checks.statuses.find((x) => x.context === name), runs?.get(name)));
  const clock = useSeconds(words.includes("running"));
  const arrived = useArrivals(runs ? names.map((name, i) => ({ key: name, state: words[i] ?? "" })) : undefined);

  // pando.toml unreadable or broken: which checks are required is not known (the Merge box gives the reason in full).
  const unknown =
    checks.state === "unknown" ? (
      <p title={checks.checks_unknown ?? undefined} className="mb-2.5 text-[13px] text-ash">
        Required checks unknown
      </p>
    ) : null;

  if (!names.length) return unknown ?? <Empty>None required.</Empty>;

  return (
    <>
      {unknown}
      <ul aria-label="Checks" className="grid gap-2.5">
        {names.map((name, i) => {
          const s = checks.statuses.find((x) => x.context === name);
          const run = runs?.get(name);
          const word = words[i] ?? "";
          const mark = s?.app === "buildkite" || run?.build.service === "buildkite";
          // A monorepo's build has its page here; a plain repo's opens in the service.
          const page = run && info.kind === "monorepo" ? ciBuildLink(monorepo.full, run.build.pipeline, run.build.number) : null;
          const url = run?.job.web_url ?? s?.target_url ?? null;
          const label = <code className="fox-cool text-bark">{name}</code>;

          return (
            <li key={`${name}:${word}`} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[13px] ${arrived(name) ? "arrived" : ""}`}>
              <span className="text-bark-dim">
                {mark ? <CheckMark /> : null}
                {page && run ? (
                  <Link {...page} search={{ job: run.job.id }} className="hover:underline hover:decoration-ash hover:underline-offset-3">
                    {label}
                  </Link>
                ) : url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline hover:decoration-ash hover:underline-offset-3">
                    {label}
                  </a>
                ) : (
                  label
                )}{" "}
                <span className={`fox-cool text-[13px] whitespace-nowrap ${toneOf(word)}`}>{word}</span>
              </span>
              <span className="fox-cool font-mono text-[12.5px] whitespace-nowrap text-ash">{run ? elapsed(run.job, clock) : ""}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** What the last Merge click was told, kept until the branch changes under it. */
interface Answer {
  head: string;
  code: string;
  paths: readonly string[];
}

/** The Merge box: ready, conflicting, failing, waiting, merged; and what a refused Merge said. */
function MergeBox({ repo, b }: { repo: Repo; b: Branch }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const clock = useNow();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [review, copyReview] = useCopy("Review in Plannotator");
  const refresh = () => qc.invalidateQueries({ queryKey: repoKey(monorepo, repo.name) });

  const landing = useMutation({
    mutationFn: (force: boolean) => merge(monorepo, repo.name, b.name, b.head, force),
    onSuccess: async (out) => {
      if (out.refused) setAnswer({ head: b.head, code: out.refused.error.code, paths: out.refused.error.paths ?? [] });

      await refresh();
    },
  });

  const s = stateOf(b);
  const said = answer?.head === b.head ? answer : null;
  const moved = answer && answer.code === "head_moved" && answer.head !== b.head;
  const conflicts = mergeableOf(b) === "conflicts" || said?.code === "conflict";
  const failed = b.checks.statuses.find((x) => x.state === "failure" || x.state === "error");
  // The box's line (waiting, failed, ready, merged) plays the arrival when it changes while the page is open.
  const line = b.state === "merged" ? "merged" : conflicts ? "conflicts" : failed ? `failed:${failed.context}` : s.tone === "wait" ? `wait:${s.text}` : "ready";
  const arrives = useArrivals([{ key: "line", state: line }])("line") ? "arrived fox-arrive" : "";

  const reviewLink = (
    <button
      type="button"
      title={`pando review ${b.name}`}
      className="cursor-pointer border-b border-ash-half pb-px text-bark-dim hover:border-bark hover:text-bark"
      onClick={() => copyReview(`pando review ${b.name}`)}
    >
      {review}
    </button>
  );

  const acts = (button: React.ReactNode) => (
    <div className="mt-4 flex items-center gap-4">
      {button}
      {reviewLink}
    </div>
  );

  let body: React.ReactNode;

  if (b.state === "merged") {
    body = (
      <>
        {/* Just merged here: it arrives in Foxfire, then cools (the prototype's one colour for arrival). */}
        <p key={line} className={`${big} ${landing.data?.ok ? "fox-arrive" : ""} ${arrives}`}>
          Merged into main
        </p>
        <p className={`${q} mt-1.5`}>
          <code className="text-[12.5px] text-bark">{b.merge_commit?.slice(0, 7) ?? ""}</code>
          {b.merged_by ? `, by ${b.merged_by}` : ""}
          {b.merged_at ? `, ${ago(b.merged_at, clock)}` : ""}
        </p>
      </>
    );
  } else if (conflicts) {
    // The files the dry run found changed on both sides, up front; a refused Merge's own answer if it has newer ones.
    const paths = said?.paths.length ? said.paths : (b.conflict_paths ?? []);

    body = (
      <>
        <p key={line} className={`${big} text-rust ${arrives}`}>
          Conflicts with main
        </p>
        {paths.length ? (
          <p className={`${q} mt-1.5`}>
            {paths.map((p) => (
              <code key={p} className="block text-[12.5px] text-bark">
                {p}
              </code>
            ))}
          </p>
        ) : null}
        {acts(
          <button type="button" className={solid} disabled>
            Merge
          </button>,
        )}
      </>
    );
  } else {
    const force = s.tone !== "ready";

    const heading = failed ? (
      <p key={line} className={`${big} text-rust ${arrives}`}>
        {failed.app === "buildkite" ? <CheckMark height={12} big /> : null}
        {failed.context} failed
      </p>
    ) : s.tone === "wait" ? (
      <p key={line} className={`${big} text-bark-dim ${arrives}`}>
        {s.text === "no ci yet" ? (
          "No ci has reported"
        ) : s.text === "checks unknown" ? (
          "Required checks unknown"
        ) : s.text === "checking" ? (
          "Checking main"
        ) : (
          <>
            Waiting for {s.app === "buildkite" ? <CheckMark height={12} big /> : null}
            {s.text.replace(/ running$/, "")}
          </>
        )}
      </p>
    ) : (
      <p key={line} className={`${big} ${arrives}`}>
        Ready to merge
      </p>
    );

    body = (
      <>
        {heading}
        {/* While pando.toml cannot be read, why: after the heading, which says it when nothing else comes first. */}
        {b.checks.state === "unknown" ? <p className={`${q} mt-1.5`}>{s.text === "checks unknown" ? b.checks.checks_unknown : unknownWhy(b)}</p> : null}
        {moved ? (
          <p className={`${q} mt-1.5`}>
            Moved to <code className="text-[12.5px] text-bark">{b.head.slice(0, 7)}</code>
          </p>
        ) : null}
        {acts(
          <button type="button" className={force ? quiet : solid} disabled={landing.isPending} onClick={() => landing.mutate(force)}>
            {force ? "Merge anyway" : "Merge"}
          </button>,
        )}
      </>
    );
  }

  return (
    <div className="rounded-[10px] bg-loam px-5 py-[18px]" aria-live="polite">
      {body}
    </div>
  );
}

function Worktree({ repo, branch }: { repo: Repo; branch: string }) {
  const { monorepo } = useMonorepo();
  const w = useQuery(worktreeQuery(monorepo, repo.path, branch)).data;

  if (!w) return null;

  return (
    <div className="mt-10">
      <SectionHead title="Worktree" />
      <div className="grid gap-2.5 text-[13px]">
        <span>
          <code className="break-all text-bark">{w.path}</code>
        </span>
        <span className="text-bark-dim">
          {w.reported_by}{" "}
          <span className="text-ash">
            on {w.machine}, {w.kind}
          </span>
        </span>
      </div>
    </div>
  );
}

/** The Files changed tab's body: the diff, or why there is none. */
function FilesTab({ repo, branch }: { repo: Repo; branch: string }) {
  const { monorepo } = useMonorepo();
  const diff = useQuery(branchDiffQuery(monorepo, repo.name, branch));

  if (diff.data) return <FilesChanged diff={diff.data} />;

  return diff.isError ? <Empty>The files changed could not be read.</Empty> : null;
}

export function BranchPage({ repo, branch, files }: { repo: Repo; branch: string; files: boolean }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();

  // The branch's row, its checks and its jobs come live on the repo's rows (a new head reads its diff again);
  // the record, its runs and its diff are read once more when the socket opens.
  const live = useRows(monorepo, [`repo:${repo.name}`], () => {
    void qc.invalidateQueries({ queryKey: branchQuery(monorepo, repo.name, branch).queryKey, exact: true });
    void qc.invalidateQueries({ queryKey: branchDiffQuery(monorepo, repo.name, branch).queryKey, exact: true });
    void qc.invalidateQueries({ queryKey: [...repoKey(monorepo, repo.name), "runs"] });
  });

  const b = useSuspenseQuery({ ...branchQuery(monorepo, repo.name, branch), refetchInterval: fallback(live) }).data;
  const commits = useSuspenseQuery(commitsQuery(monorepo, repo.name, branch)).data;
  const reviews = useSuspenseQuery(reviewsQuery(monorepo, repo.name, branch)).data;
  const changed = useQuery(branchDiffQuery(monorepo, repo.name, branch)).data?.files_total;
  const n = b.state === "merged" ? commits.total : (b.ahead ?? commits.total);

  return (
    <>
      <div>
        <Title>{b.title ?? b.name}</Title>
        <p className="mt-2 text-[14px] text-bark-dim">
          <code className="text-bark">{b.name}</code> into <code className="text-bark">main</code>. {n} commit{n === 1 ? "" : "s"}
          {b.author ? ` by ${b.author}` : ""}
          {b.behind ? `, ${b.behind} behind main` : ""}.
        </p>
      </div>
      <TabBar label="Branch">
        <Tab link={branchLink(monorepo.full, repo.path, branch)} current={!files} label="Overview" />
        <Tab link={branchLink(monorepo.full, repo.path, branch, true)} current={files} label="Files changed" count={changed} />
      </TabBar>
      {files ? <FilesTab repo={repo} branch={branch} /> : <Overview repo={repo} b={b} commits={commits.commits} reviews={reviews} live={live} />}
    </>
  );
}

function Overview({ repo, b, commits, reviews, live }: { repo: Repo; b: Branch; commits: readonly Commit[]; reviews: readonly Review[]; live: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
      <section>
        <SectionHead title="Commits" count={commits.length} />
        {commits.length ? <Commits commits={commits} /> : <Empty>No commits ahead of main.</Empty>}
        <div className="mt-10">
          <SectionHead title="Reviews" />
          <Reviews reviews={reviews} />
        </div>
      </section>
      <aside>
        <MergeBox repo={repo} b={b} />
        <div className="mt-10">
          <SectionHead title="Checks" />
          <CheckRows repo={repo} branch={b} checks={b.checks} live={live} />
        </div>
        <Worktree repo={repo} branch={b.name} />
      </aside>
    </div>
  );
}
