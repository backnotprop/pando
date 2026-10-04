// The CI tab's reads: the service and its pipelines, builds, one build with
// its jobs, and what is fetched from the service when opened (a job's log,
// annotations, artifacts). Keys sit under ["m", owner, name, "ci"]. Builds
// and jobs are patched from the rows on the page's socket (live/rows.ts). A
// running job's log is the one service read on a timer while a build runs
// (the service has no push for it): the server keeps it 10 s, shared by every
// viewer.
import { type CiState, Routes } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import type * as Schema from "effect/Schema";
import { get } from "./client";
import type { MonorepoRef } from "./names";

const read = <A, I>(route: { path: string; response: Schema.Codec<A, I> }) => get(route.response, route.path);

export const ciKey = (m: MonorepoRef) => ["m", m.owner, m.name, "ci"] as const;

/** Still moving: worth asking again. */
export const going = (state: CiState) => state === "queued" || state === "running";

/** A running job's log is read this often: the service has no push for it. */
const LOG_MS = 5000;

/** The service, its connections (webhook URL, last event) and its pipelines, each with its last build. */
export const ciQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...ciKey(m), "overview"],
    queryFn: () => read(Routes.getCi(m.owner, m.name)),
  });

/** The newest builds across the monorepo (the first page, 30). */
export const ciBuildsQuery = (m: MonorepoRef) =>
  queryOptions({
    queryKey: [...ciKey(m), "builds"],
    queryFn: () => read(Routes.listCiBuilds(m.owner, m.name, null, null)).then((r) => r.builds),
  });

/** A pipeline's page: its pipeline.yml and its builds. */
export const ciPipelineQuery = (m: MonorepoRef, pipeline: string) =>
  queryOptions({
    queryKey: [...ciKey(m), "pipeline", pipeline],
    queryFn: () => read(Routes.getCiPipeline(m.owner, m.name, pipeline)),
  });

/** Pando's id for a pipeline's build number, or null when it is not one of ours. A number never moves to another build. */
export const ciBuildIdQuery = (m: MonorepoRef, pipeline: string, number: number) =>
  queryOptions({
    queryKey: [...ciKey(m), "number", pipeline, number],
    queryFn: () => read(Routes.findCiBuild(m.owner, m.name, pipeline, number)).then((r) => r.builds[0]?.id ?? null),
    staleTime: Infinity,
  });

/** A build and its jobs. */
export const ciBuildQuery = (m: MonorepoRef, build: string) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build],
    queryFn: () => read(Routes.getCiBuild(m.owner, m.name, build)),
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
    queryFn: () => read(Routes.getCiJobLog(m.owner, m.name, build, job)),
    staleTime: (q) => (q.state.data?.complete ? Infinity : 0),
    refetchInterval: (q) => (moving ? LOG_MS : q.state.data && !q.state.data.complete ? SETTLING_MS : false),
  });

/**
 * A build's annotations (the service's HTML). Each read can cost a call to
 * the service, so while the build runs they are read when its state changes;
 * once it ends, every 10 s until the server calls them complete.
 */
export const ciAnnotationsQuery = (m: MonorepoRef, build: string, state: CiState) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build, "annotations", state],
    queryFn: () => read(Routes.listCiAnnotations(m.owner, m.name, build)),
    // The last answer stays on screen while a new state's is read.
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (!going(state) && q.state.data && !q.state.data.complete ? SETTLING_MS : false),
  });

/** A build's artifacts, read as its annotations are. */
export const ciArtifactsQuery = (m: MonorepoRef, build: string, state: CiState) =>
  queryOptions({
    queryKey: [...ciKey(m), "build", build, "artifacts", state],
    queryFn: () => read(Routes.listCiArtifacts(m.owner, m.name, build)),
    // The last answer stays on screen while a new state's is read.
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (!going(state) && q.state.data && !q.state.data.complete ? SETTLING_MS : false),
  });
