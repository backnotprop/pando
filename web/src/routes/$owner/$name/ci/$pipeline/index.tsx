// A pipeline's page: its project, branch and required checks, its
// pipeline.yml as the CI service has it (with Copy), and its builds. New build
// builds the default branch's head with fresh tokens, as Rebuild does.
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { newBuild } from "../../../../../api/actions";
import { ciBuildQuery, ciKey, ciPipelineQuery } from "../../../../../api/ci";
import { CI_TOPICS, fallback, syncCi, useRows } from "../../../../../live/rows";
import { monorepoQuery } from "../../../../../api/queries";
import { button, CopyButton, Empty, lnk, Refusal, SectionHead } from "../../../../../ui/controls";
import { tool } from "../../-code/FileView";
import { BuildList, ServiceMark, serviceName } from "../../-ci/parts";
import { MonorepoHead, useMonorepo } from "../../-frame/heads";

export const Route = createFileRoute("/$owner/$name/ci/$pipeline/")({
  loader: async ({ context: { queryClient, monorepo }, params }) => {
    if ((await queryClient.ensureQueryData(monorepoQuery(monorepo))).kind === "repo") throw notFound();

    await queryClient.ensureQueryData(ciPipelineQuery(monorepo, params.pipeline));
  },
  component: PipelinePage,
});

function NewBuild({ pipeline, branch }: { pipeline: string; branch: string }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const start = useMutation({
    mutationFn: () => newBuild(monorepo, pipeline, branch),
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: ciKey(monorepo) });

      if (out.build)
        await navigate({ to: "/$owner/$name/ci/$pipeline/$number", params: { owner: monorepo.owner, name: monorepo.name, pipeline, number: String(out.build.number) } });
    },
  });

  return (
    <span className="flex flex-col items-end phone:items-start">
      <button type="button" className={button("quiet", 30)} disabled={start.isPending} onClick={() => start.mutate()}>
        New build
      </button>
      <Refusal error={start.error} />
    </span>
  );
}

function PipelinePage() {
  const { monorepo } = useMonorepo();
  const slug = Route.useParams().pipeline;
  const qc = useQueryClient();
  const live = useRows(monorepo, CI_TOPICS, () => syncCi(qc, monorepo));
  const { pipeline: p, builds } = useSuspenseQuery({ ...ciPipelineQuery(monorepo, slug), refetchInterval: fallback(live) }).data;
  // The checks its last build ran carry the service's mark.
  const last = useQuery({ ...ciBuildQuery(monorepo, p.last_build?.id ?? ""), enabled: p.last_build !== null }).data;
  const ran = new Set((last?.jobs ?? []).flatMap((j) => (j.check && !j.retried ? [j.check] : [])));
  const branch = p.default_branch ?? "main";

  return (
    <>
      <MonorepoHead tab="ci" />
      <div className="max-w-[1000px]">
        <div className="mb-5 flex items-center justify-between gap-8 phone:flex-col phone:items-start phone:gap-4">
          <div className="min-w-0">
            <h2 className="text-[22px] leading-7 tracking-[-.018em]">
              <span className="font-mono text-[20px]">{p.slug}</span>
            </h2>
            <p className="mt-1.5 flex items-center gap-2.5 overflow-hidden font-mono text-[13px] whitespace-nowrap text-ash phone:flex-wrap phone:gap-y-0.5 phone:whitespace-normal">
              {p.repo_path ? <span>{p.repo_path}</span> : null}
              <span>{branch}</span>
              {p.required_checks.map((c) => (
                <span key={c}>
                  {ran.has(c) ? <ServiceMark service={p.service} /> : null}
                  {c}
                </span>
              ))}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <a href={p.web_url} target="_blank" rel="noopener noreferrer" className={lnk}>
              Open in {serviceName(p.service)}
            </a>
            <NewBuild pipeline={p.slug} branch={branch} />
          </div>
        </div>
        <div className="overflow-hidden rounded-[10px] border border-rootline">
          <div className="flex min-h-11 items-center gap-2 border-y border-rule-faint py-1.5 pr-2.5 pl-4 phone:flex-wrap phone:pb-2.5">
            <span className="mr-auto font-mono text-[12.5px] leading-[15px] text-ash phone:basis-full">pipeline.yml</span>
            {p.configuration === null ? null : <CopyButton text={p.configuration} className={tool} />}
          </div>
          {p.configuration === null ? (
            <p className="px-[18px] py-3.5 text-[13.5px] text-ash">{p.configuration_error?.message ?? "Not read from the CI service yet."}</p>
          ) : (
            <pre className="m-0 overflow-x-auto px-[18px] py-3.5 font-mono text-[12.5px] leading-[19px] whitespace-pre text-bark">{p.configuration}</pre>
          )}
        </div>
        <div className="mt-10">
          <SectionHead title="Builds" />
          {builds.length ? <BuildList full={monorepo.full} builds={builds} label="Builds" /> : <Empty>No builds yet.</Empty>}
        </div>
      </div>
    </>
  );
}
