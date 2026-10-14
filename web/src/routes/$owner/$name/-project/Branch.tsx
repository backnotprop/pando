// A branch's page is the pull request: its title, then two tabs. Overview:
// its commits (with co-authors), its reviews, and on the right the Merge box,
// its checks (each with its CI service's mark and a link to the run) and its
// worktree. Merge lands exactly the head on screen (expected_head); a refusal
// is shown in the box, in words. The issues it is linked to sit under the box
// (-issues/BranchIssues.tsx). Files changed: each file's diff, read only
// (FilesChanged.tsx). Artifacts: the documents uploaded to the branch's page,
// and one open with its comments (-artifacts/). Risk-based review (Risk.tsx):
// the meter under the title, the Review box under the Merge box, and the
// Guided review over the commits on a head a person must approve.
import { type QueryClient, type QueryKey, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { merge } from "../../../../api/actions";
import type { MonorepoRef } from "../../../../api/names";
import type { Branch, BranchSessions, ChangedFile, Commit, Repo, Review } from "@pando/contract";
import { branchSessionsQuery } from "../../../../api/sessions";
import { branchDiffQuery, branchQuery, commitsQuery, type FilesSoFar, repoKey, reviewsQuery, worktreeQuery } from "../../../../api/projects";
import { CheckMark } from "../../../../ui/activity";
import { Avatar } from "../../../../ui/Avatar";
import { button, Empty, SectionHead, useCopy } from "../../../../ui/controls";
import { Title } from "../../../../ui/pages";
import { fallback, useRows } from "../../../../live/rows";
import { useArrivals } from "../../../../ui/arrival";
import { type ArtifactAt, branchArtifactsLink, branchLink, branchSessionsLink, codeBlobLink, commitLink, ownerLink } from "../../../../ui/paths";
import { artifactListQuery } from "../../../../api/artifacts";
import { Ref } from "../../../../ui/Ref";
import { Tab, TabBar } from "../../../../ui/TabBar";
import { ago, since, useNow } from "../../../../ui/time";
import { BranchSessionsTab, SessionNumbers } from "../-sessions/BranchTab";
import { useMonorepo } from "../-frame/heads";
import { loadColourViews } from "../-code/coloured";
import { ReviewAgents, ReviewWithAgent } from "../-agents/ReviewAgent";
import { BranchIssues } from "../-issues/BranchIssues";
import { CheckRows } from "./Checks";
import { FilesChanged } from "./FilesChanged";
import { GuidedReview, ReviewBox, RiskMeter } from "./Risk";
import { mergeableOf, stateOf, unknownWhy } from "./state";

/** Files enough to fill the first screen of Files changed, at the list's metrics (-code/DiffList.tsx: a 44 px header and 16 px apart, 20 px a line), counting only changed lines. */
function fillsScreen(files: readonly ChangedFile[]): boolean {
  let px = 0;

  for (const f of files) {
    px += 60 + ((f.additions ?? 0) + (f.deletions ?? 0)) * 20;

    if (px >= window.innerHeight) return true;
  }

  return false;
}

/** Resolves once the streamed diff has its first screen of files, or has ended (`done`), whichever is first. */
export function firstFiles(qc: QueryClient, key: QueryKey, done: Promise<void>): Promise<void> {
  const ready = () => {
    const d = qc.getQueryData<Pick<FilesSoFar, "files" | "end" | "error">>(key);

    return !!d && (d.end !== null || d.error !== null || fillsScreen(d.files));
  };

  return new Promise((resolve) => {
    if (ready()) return resolve();

    const stop = qc.getQueryCache().subscribe(() => {
      if (!ready()) return;
      stop();
      resolve();
    });

    void done.then(() => {
      stop();
      resolve();
    });
  });
}

/** `files`: the Files changed tab waits for its first screen of files (the rest stream in); Overview fetches it alongside, for the tab's count. */
export async function loadBranch(qc: QueryClient, m: MonorepoRef, repo: Repo, branch: string, files: boolean) {
  const query = branchDiffQuery(m, repo.name, branch);
  const diff = files ? firstFiles(qc, query.queryKey, qc.prefetchQuery(query)) : qc.prefetchQuery(query);

  // Files changed: the diff view and its worker load alongside the reads (-code/coloured.ts).
  if (files) void loadColourViews();

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

/** The branch's commits, newest first: each sha and title opens the commit's page. */
function Commits({ repo, commits, on }: { repo: Repo; commits: readonly Commit[]; on: BranchSessions | undefined }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();

  return (
    <ul aria-label="Commits">
      {commits.map((c) => (
        <li key={c.sha} className="border-t border-rule-faint">
          <div className="-mx-2.5 grid min-h-10 grid-cols-[76px_minmax(0,1fr)_200px_56px] items-center gap-4 rounded-[7px] px-2.5 py-2 phone:grid-cols-[64px_minmax(0,1fr)]">
            <Ref kind="object" mono link={commitLink(monorepo.full, repo.path, c.sha)} className="text-[13.5px] leading-[16px]">
              {c.sha.slice(0, 7)}
            </Ref>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              <SessionNumbers sha={c.sha} on={on} />
              <Link {...commitLink(monorepo.full, repo.path, c.sha)} className="hover:text-link hover:underline">
                {c.title}
              </Link>
            </span>
            <span className="phone:col-span-2">
              <Authors c={c} />
            </span>
            <span className="text-right text-[12.5px] whitespace-nowrap text-ash phone:hidden">{c.author.date ? since(c.author.date, clock) : ""}</span>
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
              <Ref kind="person" link={ownerLink(r.author)}>
                {r.author}
              </Ref>
              <span className="text-bark-dim">{VERDICT[r.verdict]}</span>
              {r.session ? <span className="text-ash">by agent #{r.session}</span> : null}
              {r.body ? <span className="overflow-hidden text-[13px] text-ellipsis text-ash">{r.body}</span> : null}
            </span>
            <span className="text-[12.5px] whitespace-nowrap text-ash">{since(r.created_at, clock)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** What the last Merge click was told, kept until the branch changes under it. */
interface Answer {
  head: string;
  code: string;
  message: string;
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
      if (out.refused) setAnswer({ head: b.head, code: out.refused.error.code, message: out.refused.error.message, paths: out.refused.error.paths ?? [] });

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
          {b.merge_commit ? (
            <Ref kind="object" mono link={commitLink(monorepo.full, repo.path, b.merge_commit)} className="text-[12.5px]">
              {b.merge_commit.slice(0, 7)}
            </Ref>
          ) : null}
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
              <span key={p} className="block">
                <Ref kind="object" link={codeBlobLink(monorepo.full, repo.path, p, b.name)}>
                  {p}
                </Ref>
              </span>
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
    // Risk-based review holds the merge until its review is done (Risk.tsx): an owner can still merge anyway.
    const held = b.review && !b.review.passes ? b.review : null;
    const force = s.tone !== "ready" || !!held;
    const heldWord = held?.state === "classifying" ? "Risk score pending" : held?.tier === "human" ? "Human review required" : "Waiting for review";
    const reviewSaid = said && (said.code === "review_required" || said.code === "risk_pending") ? said.message : null;

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
    ) : held ? (
      <p key={line} className={`${big} ${held.tier === "human" ? "text-rust" : "text-bark-dim"} ${arrives}`}>
        {heldWord}
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
        {reviewSaid ? <p className={`${q} mt-1.5`}>{reviewSaid}</p> : held?.why && !failed && s.tone === "ready" ? <p className={`${q} mt-1.5`}>{held.why[0]?.toUpperCase() + held.why.slice(1)}</p> : null}
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
          <span className="break-all text-bark">{w.path}</span>
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

  const start = diff.data?.start;

  if (diff.data && start) {
    const ends = { after: start.head, before: start.merge_base, files_total: start.files_total, too_many_files: start.too_many_files };

    return <FilesChanged repo={repo} what="branch" diff={diff.data} ends={ends} reading={diff.isFetching} readAgain={() => void diff.refetch()} />;
  }


  return diff.isError ? <Empty>The files changed could not be read.</Empty> : null;
}

// The Artifacts tab is its own chunk, loaded when the tab is opened: the branch's other tabs never carry it.
const ArtifactsTab = lazy(() => import("../-artifacts/ArtifactsTab").then((m) => ({ default: m.ArtifactsTab })));

/** Where on the Artifacts tab the address is (`?tab=artifacts&artifact=...`), or null on another tab. */
export const artifactsAt = (s: { tab?: string; artifact?: string; v?: string; plain?: string }): ArtifactAt | null =>
  s.tab === "artifacts" ? { artifact: s.artifact, v: s.v, plain: s.plain } : null;

export function BranchPage({ repo, branch, files, sessions, artifacts }: { repo: Repo; branch: string; files: boolean; sessions: boolean; artifacts: ArtifactAt | null }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();

  // The branch's row, its checks and its jobs come live on the repo's rows (a new head reads its diff again);
  // the record, its runs and its diff are read once more when the socket opens.
  const live = useRows(monorepo, [`repo:${repo.name}`], () => {
    void qc.invalidateQueries({ queryKey: branchQuery(monorepo, repo.name, branch).queryKey, exact: true });
    // A diff still streaming in is the head's own: it goes on rather than starting over (a large one takes a while the first time).
    void qc.invalidateQueries({ queryKey: branchDiffQuery(monorepo, repo.name, branch).queryKey, exact: true }, { cancelRefetch: false });
    void qc.invalidateQueries({ queryKey: [...repoKey(monorepo, repo.name), "runs"] });
  });

  const b = useSuspenseQuery({ ...branchQuery(monorepo, repo.name, branch), refetchInterval: fallback(live) }).data;
  const commits = useSuspenseQuery(commitsQuery(monorepo, repo.name, branch)).data;
  const reviews = useSuspenseQuery(reviewsQuery(monorepo, repo.name, branch)).data;
  const changed = useQuery(branchDiffQuery(monorepo, repo.name, branch)).data?.start?.files_total;
  // The agent sessions its commits name: the Sessions tab, and each commit's numbers on the Overview.
  const on = useQuery(branchSessionsQuery(monorepo, repo.name, branch)).data;
  // The documents uploaded to its page: the Artifacts tab's count, read once the page's own reads are done (its diff's
  // first files), or at once on the Artifacts tab; never ahead of what the page draws.
  const uploaded = useQuery({ ...artifactListQuery(monorepo, repo.name, branch), enabled: !!artifacts || changed !== undefined }).data?.total;
  // One count for the line under the title and the Commits heading, from the commits read (a new head reads it again, live/rows.ts).
  const n = commits.total;

  return (
    <>
      <div>
        <Title>{b.title ?? b.name}</Title>
        <p className="mt-2 text-[14px] text-bark-dim">
          <code className="text-bark">{b.name}</code> into <code className="text-bark">main</code>. {n} commit{n === 1 ? "" : "s"}
          {b.author ? ` by ${b.author}` : ""}
          {b.behind ? `, ${b.behind} behind main` : ""}.
        </p>
        <RiskMeter b={b} />
      </div>
      <TabBar label="Branch">
        <Tab link={branchLink(monorepo.full, repo.path, branch)} current={!files && !sessions && !artifacts} label="Overview" />
        {on?.sessions.length ? <Tab link={branchSessionsLink(monorepo.full, repo.path, branch)} current={sessions} label="Sessions" count={on.sessions.length} /> : null}
        <Tab link={branchArtifactsLink(monorepo.full, repo.path, branch)} current={!!artifacts} label="Artifacts" count={uploaded || undefined} />
        <Tab link={branchLink(monorepo.full, repo.path, branch, true)} current={files} label="Files changed" count={changed} />
      </TabBar>
      {artifacts ? (
        <Suspense fallback={<div className="min-h-24" />}>
          <ArtifactsTab repo={repo} b={b} at={artifacts} aside={<Aside repo={repo} b={b} live={live} />} />
        </Suspense>
      ) : files ? (
        <FilesTab repo={repo} branch={branch} />
      ) : sessions ? (
        <BranchSessionsTab repo={repo} branch={branch} merged={b.state === "merged"} on={on} commits={commits.commits} />
      ) : (
        <Overview repo={repo} b={b} commits={commits.commits} total={n} reviews={reviews} live={live} on={on} />
      )}
    </>
  );
}

function Overview({ repo, b, commits, total, reviews, live, on }: { repo: Repo; b: Branch; commits: readonly Commit[]; total: number; reviews: readonly Review[]; live: boolean; on: BranchSessions | undefined }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
      <section>
        <GuidedReview repo={repo} b={b} />
        <SectionHead title="Commits" count={total} />
        {commits.length ? <Commits repo={repo} commits={commits} on={on} /> : <Empty>No commits ahead of main.</Empty>}
        <div className="mt-10">
          <SectionHead title="Reviews" right={b.state === "merged" ? null : <ReviewWithAgent repo={repo} branch={b.name} />} />
          <ReviewAgents repo={repo} branch={b.name} />
          <Reviews reviews={reviews} />
        </div>
      </section>
      <Aside repo={repo} b={b} live={live} />
    </div>
  );
}

/** The right column of Overview (and of the Artifacts list): the Merge box, the linked issues, the checks, the worktree. */
function Aside({ repo, b, live }: { repo: Repo; b: Branch; live: boolean }) {
  return (
    <aside>
      <MergeBox repo={repo} b={b} />
      <ReviewBox repo={repo} b={b} />
      <BranchIssues repo={repo} b={b} />
      <div className="mt-10">
        <SectionHead title="Checks" />
        <CheckRows repo={repo} sha={b.head} checks={b.checks} live={live} />
      </div>
      <Worktree repo={repo} branch={b.name} />
    </aside>
  );
}
