// The CI tab's reads: the service and its pipelines, builds, one build with
// its jobs, and what is fetched from the service when opened (a job's log,
// annotations, artifacts). Keys sit under ["m", owner, name, "ci"], so a
// check's line on the socket refreshes them. Builds and jobs move by webhook
// with no activity line of their own, so a page showing one that is still
// going asks again every 5 s (Pando's stored rows: no call to the service).
// A running job's log is the one service read on a timer while a build runs:
// the server keeps it 10 s, shared by every viewer.
import { type CiBuild, type CiState, Routes } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import type * as Schema from "effect/Schema";
import { get } from "./client";
import type { MonorepoRef } from "./names";
import * as Pending from "./pending";

const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

export const ciKey = (m: MonorepoRef) => ["m", m.owner, m.name, "ci"] as const;

/** Still moving: worth asking again. */
export const going = (state: CiState) => state === "queued" || state === "running";

const POLL_MS = 5000;

const pollWhile = (moving: boolean) => (moving ? POLL_MS : false);

/** The service, its connections (webhook URL, last event) and its pipelines, each with its last build. */
export const ciQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...ciKey(m), "overview"],
    queryFn: () => read(Pending.getCi(m.owner, m.name)),
    refetchInterval: (q) => pollWhile(q.state.data?.pipelines.some((p) => p.last_build && going(p.last_build.state)) ?? false),
  });

/** The newest builds across the monorepo (the first page, 30). */
export const ciBuildsQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...ciKey(m), "builds"],
    queryFn: () => read(Routes.listCiBuilds(m.owner, m.name, null, null)).then((r) => r.builds),
    refetchInterval: (q) => pollWhile(q.state.data?.some((b) => going(b.state)) ?? false),
  });

/** A pipeline's page: its pipeline.yml and its builds. */
export const ciPipelineQuery = (m: MonorepoRef, pipeline: string) =>
  queryOptions({
    queryKey: [...ciKey(m), "pipeline", pipeline],
    queryFn: () => read(Pending.getCiPipeline(m.owner, m.name, pipeline)),
    refetchInterval: (q) => pollWhile(q.state.data?.builds.some((b) => going(b.state)) ?? false),
  });

/** At most this many pages of a pipeline's builds are searched for a number (100 each). */
const FIND_PAGES = 10;

/** Pando's id for a pipeline's build number, or null when it is not one of ours. A number never moves to another build. */
export const ciBuildIdQuery = (m: MonorepoRef, pipeline: string, number: number) =>
  queryOptions({
    queryKey: [...ciKey(m), "number", pipeline, number],
    queryFn: async () => {
      let cursor: string | null = null;

      for (let page = 0; page < FIND_PAGES; page++) {
        const found: { builds: readonly CiBuild[]; next_cursor: string | null } = await read(Pending.findCiBuilds(m.owner, m.name, pipeline, number, cursor));
        const hit = found.builds.find((b) => b.number === number);

        if (hit) return hit.id;

        // Newest first: past a smaller number, it is not there.
        if (!found.next_cursor || found.builds.some((b) => b.number < number)) return null;
        cursor = found.next_cursor;
      }

      return null;
    },
    staleTime: Infinity,
  });

/** A build and its jobs. */
export const ciBuildQuery = (m: MonorepoRef, build: string) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build],
    queryFn: () => read(Routes.getCiBuild(m.owner, m.name, build)),
    refetchInterval: (q) => pollWhile(q.state.data ? going(q.state.data.state) || q.state.data.jobs.some((j) => going(j.state)) : false),
  });

/** Until the server marks a finished detail complete (30 s after it ends), it may still change: ask again this often. */
const SETTLING_MS = 10_000;

/**
 * A job's log (its last 1 MiB), fetched from the service when the job is
 * opened: every 5 s while the job runs (the server keeps a running log 10 s,
 * for every viewer), then every 10 s until the server calls it complete.
 */
export const ciLogQuery = (m: MonorepoRef, build: string, job: string, moving: boolean) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build, "log", job],
    queryFn: () => read(Pending.getCiLog(m.owner, m.name, build, job)),
    staleTime: (q) => (q.state.data?.complete ? Infinity : 0),
    refetchInterval: (q) => (moving ? POLL_MS : q.state.data && !q.state.data.complete ? SETTLING_MS : false),
  });

/**
 * A build's annotations (the service's HTML). Each read can cost a call to
 * the service, so while the build runs they are read when its state changes;
 * once it ends, every 10 s until the server calls them complete.
 */
export const ciAnnotationsQuery = (m: MonorepoRef, build: string, state: CiState) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build, "annotations", state],
    queryFn: () => read(Pending.listCiAnnotations(m.owner, m.name, build)),
    // The last answer stays on screen while a new state's is read.
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (!going(state) && q.state.data && !q.state.data.complete ? SETTLING_MS : false),
  });

/** A build's artifacts, read as its annotations are. */
export const ciArtifactsQuery = (m: MonorepoRef, build: string, state: CiState) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build, "artifacts", state],
    queryFn: () => read(Pending.listCiArtifacts(m.owner, m.name, build)),
    // The last answer stays on screen while a new state's is read.
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (!going(state) && q.state.data && !q.state.data.complete ? SETTLING_MS : false),
  });
