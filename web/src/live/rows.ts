// A page's own socket to its monorepo's event stream, on the topics the page
// shows (rows, not activity lines): each row patches TanStack Query's cache
// where it is shown, so the page needs no polling (ruling, Data layer: "the
// web patches its cache from events"). On its first caught_up the page reads
// its data once more (rows from before the socket opened); on a reconnect it
// asks for what it missed with since=<last seq>, and a resync reads again.
// While the socket is down, the page polls as a fallback (`fallback`).
import { type BranchEventRow, type CiBuild, type CiBuildDetail, type CiJob, decodeMonorepoEventFrame, type FeedEvent, type Machine, type MonorepoEventFrame, type RepoName, Routes } from "@pando/contract";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { applyAgentRow } from "../api/agents";
import { ciBuildQuery, ciBuildsQuery, ciKey, ciPipelineQuery, ciQuery } from "../api/ci";
import { mirrorQuery } from "../api/mirror";
import { sessionGone, sessionsChanged } from "../api/sessions";
import type { MonorepoRef } from "../api/names";
import { type CheckRuns, branchDiffQuery, branchQuery, commitsQuery, repoKey, reports } from "../api/projects";
import { machinesQuery } from "../api/queries";
import { applyIssueFrame, touchLinkedIssues } from "./issues";
import { keepOpen } from "./socket";

/** While the socket is down, the page's data is read this often instead. */
const FALLBACK_MS = 5000;

export const fallback = (live: boolean) => (live ? false : FALLBACK_MS);

const newestFirst = (a: CiBuild, b: CiBuild) => (b.created_at ?? "").localeCompare(a.created_at ?? "");

/** A build into a list, newest first: replaced where it is, else placed by when it was made. */
const withBuild = <B extends CiBuild>(list: readonly B[], b: B): B[] =>
  (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [b, ...list]).sort(newestFirst);

/** Latest activity first, then connected, then by name: the server's order. */
const byActivity = (a: Machine, b: Machine) =>
  (b.last_activity?.at ?? "").localeCompare(a.last_activity?.at ?? "") || Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name);

/**
 * An activity line names its person and machine: that machine's row on the
 * Machines tab takes it as its last activity (the server republishes a
 * machine's row for activity at most once a minute, and leaves the rest to
 * the lines).
 */
export function patchMachineActivity(qc: QueryClient, e: FeedEvent) {
  const [owner, name] = e.monorepo.split("/");
  const { monorepo: _m, monorepo_id: _id, actor, machine, ...last } = e;

  if (!actor || !machine) return;

  qc.setQueryData<readonly Machine[]>(["m", owner, name, "machines"], (list) =>
    list?.map((x) => (x.login === actor && x.name === machine && (x.last_activity?.seq ?? -1) <= last.seq ? { ...x, last_activity: last } : x)).sort(byActivity),
  );
}

function patchMachine(qc: QueryClient, m: MonorepoRef, row: Machine) {
  qc.setQueryData(machinesQuery(m).queryKey, (list) =>
    list && (list.some((x) => x.login === row.login && x.credential_id === row.credential_id) ? list.map((x) => (x.login === row.login && x.credential_id === row.credential_id ? row : x)) : [...list, row]).sort(byActivity),
  );
}

function patchBuild(qc: QueryClient, m: MonorepoRef, b: CiBuild) {
  qc.setQueryData(ciBuildsQuery(m).queryKey, (list) => list && withBuild(list, b));
  qc.setQueryData(ciPipelineQuery(m, b.pipeline).queryKey, (page) => page && { ...page, builds: withBuild(page.builds, b) });
  qc.setQueryData(ciBuildQuery(m, b.id).queryKey, (detail): CiBuildDetail | undefined => detail && { ...detail, ...b });
  qc.setQueryData(ciQuery(m).queryKey, (ci) =>
    ci && {
      ...ci,
      pipelines: ci.pipelines.map((p) =>
        p.slug === b.pipeline && p.connection === b.connection && (!p.last_build || p.last_build.id === b.id || newestFirst(p.last_build, b) > 0) ? { ...p, last_build: b } : p,
      ),
    },
  );

  // A branch page at this commit: the build joins its checks' runs.
  if (b.sha) qc.setQueryData<CheckRuns>([...repoKey(m, b.repo), "runs", b.sha], (r) => r && { builds: new Map(r.builds).set(b.id, b), runs: rebuild(r.runs, b) });
}

/** A build's own fields changed: the runs that are its jobs carry the new build. */
const rebuild = (runs: CheckRuns["runs"], b: CiBuild) => new Map([...runs].map(([check, run]) => [check, run.build.id === b.id ? { ...run, build: b } : run]));

function patchJob(qc: QueryClient, m: MonorepoRef, repo: RepoName | null, buildId: string, job: CiJob) {
  qc.setQueryData(ciBuildQuery(m, buildId).queryKey, (detail) =>
    detail && { ...detail, jobs: detail.jobs.some((j) => j.id === job.id) ? detail.jobs.map((j) => (j.id === job.id ? job : j)) : [...detail.jobs, job] },
  );

  if (!repo || !job.check) return;
  const check = job.check;

  // Each branch page whose commit this build is of: the job reports its check, if it is the newest.
  for (const [key, r] of qc.getQueriesData<CheckRuns>({ queryKey: [...repoKey(m, repo), "runs"] })) {
    const build = r?.builds.get(buildId);

    if (!r || !build || !reports(job, build, r.runs.get(check))) continue;
    qc.setQueryData<CheckRuns>(key, { builds: r.builds, runs: new Map(r.runs).set(check, { job, build }) });
  }
}

/** A row event (not caught_up, resync or error). */
type RowEvent = Extract<MonorepoEventFrame, { type: "event" }>;

/** A branch's stored fields changed (a push, a merge, a title edit): merged into the cached branch; its facts follow as a full branch.updated. */
function patchBranchFields(qc: QueryClient, m: MonorepoRef, row: BranchEventRow) {
  const { repo, ...fields } = row;

  qc.setQueryData(branchQuery(m, repo, row.name).queryKey, (b) => b && { ...b, ...fields });
}

function apply(qc: QueryClient, m: MonorepoRef, f: RowEvent) {
  switch (f.kind) {
    case "machine.updated":
      patchMachine(qc, m, f.row);
      break;
    case "ci.build":
      patchBuild(qc, m, f.row);
      break;
    case "ci.job":
      patchJob(qc, m, f.repo, f.row.build, f.row);
      break;
    case "ci.connection":
      // Connected or disconnected (rare): the tab's top is read again (a row here has no webhook URL).
      void qc.invalidateQueries({ queryKey: ciQuery(m).queryKey });
      break;
    case "branch.updated":
    case "branch.opened":
    case "merged":
    case "push": {
      if (f.collection !== "branches") break;
      const before = qc.getQueryData(branchQuery(m, f.row.repo, f.row.name).queryKey)?.head;

      if (f.partial) {
        patchBranchFields(qc, m, f.row);
      } else {
        const { repo, ...branch } = f.row;

        qc.setQueryData(branchQuery(m, repo, branch.name).queryKey, branch);
      }

      // A new head: its Files changed is read again (a 304 by its ETag when the files did not move), and its commits, so the page's
      // commit counts move with the head rather than with the activity line that follows.
      if (f.row.head !== before) {
        void qc.invalidateQueries({ queryKey: branchDiffQuery(m, f.row.repo, f.row.name).queryKey, exact: true });
        void qc.invalidateQueries({ queryKey: commitsQuery(m, f.row.repo, f.row.name).queryKey, exact: true });
      }

      touchLinkedIssues(qc, m, f.row.repo, f.row.name);

      break;
    }

    case "status":
      // The branches at that commit follow as branch.updated, with their checks and gate.
      break;
    case "issue.opened":
    case "issue.commented":
    case "issue.closed":
    case "issue.reopened":
    case "issue.updated":
    case "label.updated":
      applyIssueFrame(qc, m, f);
      break;
    case "session.started":
    case "session.updated":
      // A session started or grew: its lists and its page read again (they are small; a session sends at most a piece per 30 s).
      sessionsChanged(qc, m);
      break;
    case "session.deleted":
      sessionGone(qc, m, f.row);
      break;
    case "agent.updated":
      applyAgentRow(qc, m, f.row);
      break;
    case "mirror.updated":
      // A run ended or a setting changed: Settings reads its section again (the event's row has no paths or counts behind).
      void qc.invalidateQueries({ queryKey: mirrorQuery(m).queryKey });
      break;
  }
}

/**
 * Keeps a socket on `topics` open while the page is: rows patch the cache,
 * `sync` reads the page's data again (on the first caught_up, and on a
 * resync). Answers whether the socket is up (else the page polls).
 */
export function useRows(m: MonorepoRef, topics: readonly string[], sync: () => void): boolean {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const read = useRef(sync);
  const key = topics.join(",");

  read.current = sync;
  useEffect(() => {
    let seq: number | null = null;

    const stop = keepOpen(() => Routes.monorepoEventsSocketPath(m.owner, m.name, key.split(","), seq), {
      up: (open) => {
        if (!open) setLive(false);
      },
      frame: (data) => {
        const frame = Option.getOrNull(decodeMonorepoEventFrame(data));

        if (!frame) return;

        switch (frame.type) {
          case "caught_up":
            // The first: rows from before the socket opened come from one more read. A replay brought the rest.
            if (seq === null) read.current();
            seq = Math.max(seq ?? 0, frame.seq);
            setLive(true);
            break;
          case "resync":
            seq = frame.seq;
            read.current();
            break;
          case "event":
            seq = Math.max(seq ?? 0, frame.seq);
            apply(qc, m, frame);
            break;
        }
      },
    });

    return () => {
      stop();
      setLive(false);
    };
  }, [qc, m.owner, m.name, key]);

  return live;
}

/** The CI pages' rows. */
export const CI_TOPICS = ["kind:ci.build", "kind:ci.job", "kind:ci.connection"];

/** Reads the CI pages' stored rows again (never the service's logs, annotations or artifacts). */
export const syncCi = (qc: QueryClient, m: MonorepoRef) =>
  void qc.invalidateQueries({ queryKey: ciKey(m), predicate: (q) => ["overview", "builds", "pipeline"].includes(String(q.queryKey[4])) || (q.queryKey[4] === "build" && q.queryKey.length === 6) });
