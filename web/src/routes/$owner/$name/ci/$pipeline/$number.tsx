// A build's page: its facts, Open in the service and Rebuild (Cancel while it
// runs), the annotations the pipeline wrote, its jobs (a failed one opens on
// its log, with Retry; any job opens to its log, fetched when opened), and its
// artifacts. States come from the service's webhooks; logs, annotations and
// artifacts are read from the service, as the server caches them.
import { type CiBuildDetail, type CiJob, Routes } from "@pando/contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { cancelBuild, rebuild, retryJob } from "../../../../../api/actions";
import { ciAnnotationsQuery, ciArtifactsQuery, ciBuildIdQuery, ciBuildQuery, ciKey, ciLogQuery, going } from "../../../../../api/ci";
import { monorepoQuery } from "../../../../../api/queries";
import { CI_TOPICS, fallback, syncCi, useRows } from "../../../../../live/rows";
import { Avatar } from "../../../../../ui/Avatar";
import { button, lnk, Refusal, SectionHead } from "../../../../../ui/controls";
import { Chevron } from "../../../../../ui/Icons";
import { branchLink } from "../../../../../ui/paths";
import { SafeHtml } from "../../../../../ui/SafeHtml";
import { jobSearch } from "../../../../../api/search";
import { useArrivals } from "../../../../../ui/arrival";
import { ago, elapsed, useSeconds } from "../../../../../ui/time";
import { LogText } from "../../-ci/Log";
import { BuildFacts, BuildState, facts, ServiceMark, serviceName } from "../../-ci/parts";
import { MonorepoHead, useMonorepo } from "../../-frame/heads";

export const Route = createFileRoute("/$owner/$name/ci/$pipeline/$number")({
  validateSearch: jobSearch,
  loader: async ({ context: { queryClient, monorepo }, params }) => {
    const number = Number(params.number);

    if ((await queryClient.ensureQueryData(monorepoQuery(monorepo))).kind === "repo" || !Number.isInteger(number) || number < 1) throw notFound();
    const id = await queryClient.ensureQueryData(ciBuildIdQuery(monorepo, params.pipeline, number));

    if (!id) throw notFound();
    await queryClient.ensureQueryData(ciBuildQuery(monorepo, id));

    return { id };
  },
  component: BuildPage,
});

/** "38 KB": an artifact's size. */
function size(bytes: number | null): string {
  if (bytes === null) return "";

  if (bytes < 1024) return `${bytes} B`;

  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Rebuild (a new build of the same commit) or, while it runs, Cancel. */
function Action({ b }: { b: CiBuildDetail }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const running = going(b.state);

  const act = useMutation({
    mutationFn: () => (running ? cancelBuild(monorepo, b.id) : rebuild(monorepo, b.id)),
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: ciKey(monorepo) });

      if (!running && out.build)
        await navigate({
          to: "/$owner/$name/ci/$pipeline/$number",
          params: { owner: monorepo.owner, name: monorepo.name, pipeline: out.build.pipeline, number: String(out.build.number) },
        });
    },
  });

  return (
    <span className="flex flex-col items-end phone:items-start">
      <button type="button" className={button("quiet", 30)} disabled={act.isPending} onClick={() => act.mutate()}>
        {running ? "Cancel" : "Rebuild"}
      </button>
      <Refusal error={act.error} />
    </span>
  );
}

function Annotations({ b }: { b: CiBuildDetail }) {
  const { monorepo } = useMonorepo();
  const list = useQuery(ciAnnotationsQuery(monorepo, b.id, b.state)).data?.annotations ?? [];

  if (!list.length) return null;

  return (
    <div className="mb-[18px] grid gap-2.5">
      {list.map((a, i) => (
        <section key={a.id ?? i} aria-label={a.context ?? "Annotation"} className="rounded-[10px] border border-rootline px-4 py-3 text-[13.5px] leading-5">
          {/* The prototype sets these fonts with the shorthand, so each line is its font's own height. */}
          <p className="mb-1.5 flex gap-2.5 text-[12px] leading-[15px] text-ash">
            {a.style ? <span className={a.style === "error" ? "text-rust" : ""}>{a.style}</span> : null}
            {a.context ? <span>{a.context}</span> : null}
          </p>
          <SafeHtml
            html={a.body_html}
            className="text-bark-dim [&_a]:border-b [&_a]:border-ash-half [&_a:hover]:text-bark [&_code]:text-[12.5px] [&_code]:text-bark [&_p]:m-0 [&_p+p]:mt-0.5 [&_strong]:font-semibold [&_strong]:text-bark"
          />
        </section>
      ))}
    </div>
  );
}

/** A job's log so far, from the service; while the job runs it is read again every few seconds. */
function Log({ b, job }: { b: CiBuildDetail; job: CiJob }) {
  const { monorepo } = useMonorepo();
  const log = useQuery(ciLogQuery(monorepo, b.id, job.id, going(job.state)));

  if (log.error) return <Refusal error={log.error} />;

  return <LogText log={log.data?.content ?? null} truncated={log.data?.truncated ?? false} />;
}

function Retry({ b, job }: { b: CiBuildDetail; job: CiJob }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const retry = useMutation({ mutationFn: () => retryJob(monorepo, b.id, job.id), onSettled: () => qc.invalidateQueries({ queryKey: ciKey(monorepo) }) });

  return (
    <>
      <button type="button" className={`${lnk} font-sans text-[12.5px] leading-[normal]`} disabled={retry.isPending} onClick={() => retry.mutate()}>
        Retry
      </button>
      {retry.error ? <span className="font-sans text-[12.5px] text-rust">{retry.error.message}</span> : null}
    </>
  );
}

/** A job: its state, its check's mark, its name and time (ticking while it runs); it opens to its log. */
function Job({ b, job, opened, arrived }: { b: CiBuildDetail; job: CiJob; opened: boolean; arrived: boolean }) {
  const clock = useSeconds(job.state === "running");
  const failed = job.state === "failed";
  const [open, setOpen] = useState(failed || opened);
  const name = job.name ?? job.step_key ?? job.type;

  return (
    <li className="border-t border-rule-faint first:border-t-0">
      {/* Keyed by its state: a change remounts the row, so its arrival plays once. */}
      <button
        key={job.state}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`grid min-h-[46px] w-full cursor-pointer grid-cols-[72px_minmax(0,1fr)_96px_20px] items-center gap-3.5 px-4 text-left text-[14px] leading-[normal] text-bark hover:bg-air focus-visible:bg-air ${arrived ? "arrived" : ""}`}
      >
        <BuildState state={job.state} />
        <span className="fox-cool min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {job.check ? <ServiceMark service={b.service} /> : null}
          {name}
        </span>
        <span className="fox-cool text-right text-[12.5px] whitespace-nowrap text-ash">{elapsed(job, clock)}</span>
        <Chevron className={`block size-3.5 text-ash ${open ? "" : "-rotate-90"}`} />
      </button>
      {open ? (
        <div className="bg-air py-2.5 pr-4 pb-3.5 pl-[102px]">
          {job.exit_status !== null || failed ? (
            <p className="mb-2 flex items-center gap-3.5 font-mono text-[12px] leading-[15px] text-ash">
              <span>exit status {job.exit_status ?? 1}</span>
              {failed ? <Retry b={b} job={job} /> : null}
            </p>
          ) : null}
          <Log b={b} job={job} />
        </div>
      ) : null}
    </li>
  );
}

function Artifacts({ b }: { b: CiBuildDetail }) {
  const { monorepo } = useMonorepo();
  const list = useQuery(ciArtifactsQuery(monorepo, b.id, b.state)).data?.artifacts ?? [];

  if (!list.length) return null;

  return (
    <div className="mt-10">
      <SectionHead title="Artifacts" count={list.length} />
      <ul aria-label="Artifacts">
        {list.map((a, i) => (
          <li key={a.id ?? i} className="border-t border-rule-faint">
            <div className="-mx-2.5 grid min-h-[38px] grid-cols-[minmax(0,1fr)_90px_90px] items-center gap-4 rounded-[7px] px-2.5 py-2">
              <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap phone:[overflow-wrap:anywhere] phone:whitespace-normal">{a.path ?? a.filename ?? ""}</span>
              <span className="text-right text-[12.5px] whitespace-nowrap text-ash">{size(a.size)}</span>
              <span className="text-right">
                {a.id ? (
                  <a href={Routes.ciArtifactDownloadPath(monorepo.owner, monorepo.name, b.id, a.id)} className={lnk}>
                    Download
                  </a>
                ) : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuildPage() {
  const { monorepo } = useMonorepo();
  const { id } = Route.useLoaderData();
  const { job: opened } = Route.useSearch();
  const qc = useQueryClient();
  const live = useRows(monorepo, CI_TOPICS, () => syncCi(qc, monorepo));
  const b = useSuspenseQuery({ ...ciBuildQuery(monorepo, id), refetchInterval: fallback(live) }).data;
  const clock = useSeconds(going(b.state));
  // The newer job of a Retry replaces the older one.
  const jobs = b.jobs.filter((j) => !j.retried);
  // A job that comes in, or moves, while the page is open plays the arrival.
  const arrived = useArrivals(jobs.map((j) => ({ key: j.id, state: j.state })));
  const branch = b.branch && b.repo_path && b.branch !== "main" ? b.branch : null;

  return (
    <>
      <MonorepoHead tab="ci" />
      <div className="max-w-[1000px]">
        <div className="mb-5 flex items-start justify-between gap-8 phone:flex-col phone:gap-4">
          <div className="min-w-0">
            <h2 className="max-w-[28em] text-[22px] leading-7 tracking-[-.018em] text-balance">{b.message ?? `Build #${b.number}`}</h2>
            <p className={`${facts} mt-2 text-[13px] leading-4`}>
              <BuildState state={b.state} />
              <BuildFacts
                b={b}
                branch={
                  branch && b.repo_path ? (
                    <Link {...branchLink(monorepo.full, b.repo_path, branch)} className="font-mono text-bark-dim hover:underline hover:decoration-ash hover:underline-offset-3">
                      {branch}
                    </Link>
                  ) : undefined
                }
              />
            </p>
            <p className="mt-2 flex items-center gap-2.5 text-[13px] leading-4 text-ash">
              {b.pushed_by ? (
                <>
                  <Avatar name={b.pushed_by} size={16} />
                  <b className="font-normal text-bark-dim">{b.pushed_by}</b>
                </>
              ) : null}
              <span>{elapsed(b, clock)}</span>
              <span>{b.created_at ? ago(b.created_at, clock) : ""}</span>
            </p>
          </div>
          <div className="flex items-center gap-4">
            {b.web_url ? (
              <a href={b.web_url} target="_blank" rel="noopener noreferrer" className={lnk}>
                Open in {serviceName(b.service)}
              </a>
            ) : null}
            <Action b={b} />
          </div>
        </div>
        <Annotations b={b} />
        <div className="overflow-hidden rounded-[10px] border border-rootline">
          <ul aria-label="Jobs">
            {jobs.map((j) => (
              <Job key={j.id} b={b} job={j} opened={j.id === opened} arrived={arrived(j.id)} />
            ))}
          </ul>
        </div>
        <Artifacts b={b} />
      </div>
    </>
  );
}
