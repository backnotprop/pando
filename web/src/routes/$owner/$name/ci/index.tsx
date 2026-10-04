// The CI tab, in a service-neutral shape (ruling): each CI service connected
// (its webhook and last event), the pipelines with what each project needs to
// merge, and the recent builds. A second service adds a block and rows, not a
// new layout. Connecting shows a secret once, so it happens in a terminal.
import type { CiConnection, CiPipeline } from "@pando/contract";
import { useMutation, useQueries, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { disconnect } from "../../../../api/actions";
import { ciBuildQuery, ciBuildsQuery, ciKey, ciQuery } from "../../../../api/ci";
import { CI_TOPICS, fallback, syncCi, useRows } from "../../../../live/rows";
import { monorepoQuery } from "../../../../api/queries";
import buildkiteMark from "../../../../ui/buildkite-mark.svg";
import { button, copyInCmd, CopyButton, Empty, lnk, Refusal, row, SectionHead, thead } from "../../../../ui/controls";
import { ciPipelineLink, isHomeProject } from "../../../../ui/paths";
import { ago, since, useNow } from "../../../../ui/time";
import { BuildList, BuildState, CommandButton, ServiceMark, serviceName } from "../-ci/parts";
import { MonorepoHead, useMonorepo } from "../-frame/heads";

export const Route = createFileRoute("/$owner/$name/ci/")({
  loader: async ({ context: { queryClient, monorepo } }) => {
    // A plain repo has no CI tab (its checks show on its branches).
    if ((await queryClient.ensureQueryData(monorepoQuery(monorepo))).kind === "repo") throw notFound();

    await Promise.all([queryClient.ensureQueryData(ciQuery(monorepo)), queryClient.ensureQueryData(ciBuildsQuery(monorepo))]);
  },
  component: CiTab,
});

/** Disconnect asks once more in place: it removes the connection's pipelines and builds from Pando. */
function Disconnect({ c }: { c: CiConnection }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [sure, setSure] = useState(false);
  const off = useMutation({ mutationFn: () => disconnect(monorepo, c.id), onSettled: () => qc.invalidateQueries({ queryKey: ciKey(monorepo) }) });

  return (
    <>
      <button
        type="button"
        className={button(sure ? "danger" : "quiet", 30)}
        disabled={off.isPending}
        onBlur={() => setSure(false)}
        onClick={() => (sure ? off.mutate() : setSure(true))}
      >
        {sure ? `Disconnect ${serviceName(c.service)}` : "Disconnect"}
      </button>
      <Refusal error={off.error} />
    </>
  );
}

function Service({ c, owner }: { c: CiConnection; owner: boolean }) {
  const clock = useNow();
  const name = serviceName(c.service);

  return (
    <div className="mt-2.5 first:mt-0">
      <div className="flex items-center gap-3.5 rounded-[10px] border border-rootline px-[18px] py-4 phone:flex-wrap phone:gap-y-2.5">
        {c.service === "buildkite" ? <img src={buildkiteMark} alt="" width={27} height={18} className="flex-none" /> : null}
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="text-[13px] leading-4 text-bark-dim">{c.organization}</span>
        <span className="ml-auto flex items-center gap-4 phone:ml-0 phone:basis-full phone:flex-wrap phone:gap-y-2">
          <span className="text-[12.5px] whitespace-nowrap text-ash">connected {ago(c.created_at, clock)}</span>
          <a href={c.web_url} target="_blank" rel="noopener noreferrer" className={lnk}>
            Open in {name}
          </a>
          {owner ? <Disconnect c={c} /> : null}
        </span>
      </div>
      {/* The webhook sits under the service's name: 18 px of padding, the 27 px mark and its 14 px gap. */}
      <div className="mt-2.5 flex items-center gap-3.5 pr-[18px] pl-[59px] text-[13px] text-bark-dim phone:flex-wrap phone:p-0">
        <span>Webhook</span>
        <span className="flex h-[34px] min-w-0 flex-1 items-center gap-3 rounded-lg border border-rootline pr-1 pl-3 phone:order-2 phone:basis-full">
          <code className="min-w-0 flex-1 overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-bark">{c.webhook_url}</code>
          <CopyButton text={c.webhook_url} className={copyInCmd} />
        </span>
        <span className="text-[12.5px] whitespace-nowrap text-ash">{c.last_event ? `last event ${ago(c.last_event.at, clock)}` : "no event yet"}</span>
      </div>
    </div>
  );
}

const pipeCols = "grid-cols-[minmax(0,1fr)_minmax(0,200px)_minmax(0,180px)_120px] phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-y-0.5";

/** Required checks; the service's mark beside each one its pipeline's last build ran. */
function Checks({ checks, ran, service }: { checks: readonly string[]; ran: ReadonlySet<string>; service: string }) {
  if (!checks.length) return <span className="text-ash">none</span>;

  return checks.map((c, i) => (
    <Fragment key={c}>
      {i ? <span className="text-ash">, </span> : null}
      {ran.has(c) ? <ServiceMark service={service} /> : null}
      <span className="text-[13px]">{c}</span>
    </Fragment>
  ));
}

/** A pipeline's row: its project, its page, its checks, and its last build's state and age. */
function PipelineRow({ p, ran }: { p: CiPipeline; ran: ReadonlySet<string> }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const last = p.last_build;

  return (
    <div className={`${row} ${pipeCols}`}>
      <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap">{p.repo_path ?? <span className="text-ash">none</span>}</span>
      <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap phone:row-start-2">
        <Link {...ciPipelineLink(monorepo.full, p.slug)} className="hover:underline hover:decoration-ash hover:underline-offset-3">
          {p.slug}
        </Link>
      </span>
      <span className="min-w-0 phone:hidden">
        <Checks checks={p.required_checks ?? []} ran={ran} service={p.service} />
      </span>
      <span className="text-right text-[12.5px] whitespace-nowrap text-ash">
        {last ? (
          <>
            <BuildState state={last.state} /> {last.created_at ? since(last.created_at, clock) : ""}
          </>
        ) : null}
      </span>
    </div>
  );
}

/** Each project with its pipelines, and each project with none (Add pipeline, in a terminal). */
function Pipelines() {
  const { monorepo } = useMonorepo();
  const ci = useSuspenseQuery(ciQuery(monorepo)).data;
  // The monorepo's own project first, then by path.
  const pipelines = [...ci.pipelines].sort((a, b) => Number(isHomeProject(b.repo_path, monorepo.name)) - Number(isHomeProject(a.repo_path, monorepo.name)) || (a.repo_path ?? "").localeCompare(b.repo_path ?? ""));
  // The checks each pipeline's last build ran, so a mark shows only where the service ran it (ruling).
  const lastBuilds = useQueries({ queries: pipelines.map((p) => ({ ...ciBuildQuery(monorepo, p.last_build?.id ?? ""), enabled: p.last_build !== null })) });
  const ranBy = (i: number) => new Set((lastBuilds[i]?.data?.jobs ?? []).flatMap((j) => (j.check && !j.retried ? [j.check] : [])));
  const without = ci.required_checks.filter((r) => !ci.pipelines.some((p) => p.repo === r.repo));

  return (
    <div className="mt-10">
      <SectionHead title="Pipelines" right={<span className="text-[12.5px] text-ash">.pando/pando.toml</span>} />
      <div className={`${thead} ${pipeCols} phone:hidden`}>
        <span>Project</span>
        <span>Pipeline</span>
        <span>Required to merge</span>
        <span className="text-right">Last build</span>
      </div>
      <ul aria-label="Pipelines">
        {pipelines.map((p, i) => (
          <li key={`${p.connection}/${p.slug}`} className="border-t border-rule-faint">
            <PipelineRow p={p} ran={ranBy(i)} />
          </li>
        ))}
        {without.map((r) => (
          <li key={r.repo} className="border-t border-rule-faint">
            <div className={`${row} ${pipeCols}`}>
              <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap">{r.path}</span>
              <span className="text-ash phone:row-start-2">none</span>
              <span className="min-w-0 phone:hidden">
                <Checks checks={r.checks ?? []} ran={new Set()} service="" />
              </span>
              <span className="text-right">
                <CommandButton label="Add pipeline" size={28} heading="Add a pipeline" command={`pando ci pipeline add ${r.path} <pipeline> --monorepo ${monorepo.full}`} />
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CiTab() {
  const { monorepo, info } = useMonorepo();
  const qc = useQueryClient();
  const live = useRows(monorepo, CI_TOPICS, () => syncCi(qc, monorepo));
  const ci = useSuspenseQuery({ ...ciQuery(monorepo), refetchInterval: fallback(live) }).data;
  const builds = useSuspenseQuery({ ...ciBuildsQuery(monorepo), refetchInterval: fallback(live) }).data;
  const owner = info.role === "owner";
  const connected = ci.connections.length > 0;

  return (
    <>
      <MonorepoHead tab="ci" />
      <div className="max-w-[1000px]">
        <SectionHead title="CI service" />
        {connected ? ci.connections.map((c) => <Service key={c.id} c={c} owner={owner} />) : <Empty>None connected.</Empty>}
        {connected ? <Pipelines /> : null}
        <div className="mt-10">
          <SectionHead title="Recent builds" />
          {builds.length ? <BuildList full={monorepo.full} builds={builds} label="Recent builds" /> : <Empty>No builds yet.</Empty>}
        </div>
        <div className="mt-10">
          <CommandButton
            label={connected ? "Connect another CI service" : "Connect a CI service"}
            heading="Connect Buildkite"
            command={`pando ci connect --org <slug> --monorepo ${monorepo.full}`}
          />
        </div>
      </div>
    </>
  );
}
