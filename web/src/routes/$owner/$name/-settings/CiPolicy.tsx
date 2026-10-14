// "When checks run", owners only: per project, whether its CI builds each
// push (the default), only when a merge asks for one, or main only. Main's
// merge commit builds under all three. One row per project in a repository
// with projects; one row in a plain repository.
import type { CiPolicy, Repo } from "@pando/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { setCiPolicy } from "../../../../api/actions";
import { reposQuery } from "../../../../api/queries";
import { repoQuery } from "../../../../api/releases";
import { Refusal } from "../../../../ui/controls";
import { Select } from "../../../../ui/dropdown";
import { useMonorepo, usePlainRepo } from "../-frame/heads";

const TITLE = "When checks run";

const WHAT = "Every push builds each push to a branch. On merge builds a branch when someone merges it, and the merge waits for green. Main only builds main. Main's merge commits build under all three.";

const CHOICES: { value: CiPolicy; label: string }[] = [
  { value: "every_push", label: "Every push" },
  { value: "on_merge", label: "On merge" },
  { value: "main_only", label: "Main only" },
];

const isPolicy = (v: string): v is CiPolicy => CHOICES.some((c) => c.value === v);

function PolicyRow({ repo, plain }: { repo: Repo; plain: boolean }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (policy: CiPolicy) => setCiPolicy(monorepo, repo.name, policy),
    onSuccess: async (saved) => {
      qc.setQueryData(repoQuery(monorepo, repo.name).queryKey, saved);
      await qc.invalidateQueries({ queryKey: reposQuery(monorepo).queryKey });
    },
  });

  const shown = save.isPending && save.variables !== undefined ? save.variables : (repo.ci_policy ?? "every_push");
  const name = plain ? "this repository" : repo.path;

  return (
    <li className="border-b border-rule-faint">
      <div className="flex min-h-[46px] items-center gap-3.5 text-[14px]">
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-bark">{plain ? "Checks run on" : repo.path}</span>
        <span className="ml-auto">
          <Select label={`When checks run for ${name}`} value={shown} onChange={(v) => (isPolicy(v) ? save.mutate(v) : undefined)}>
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </span>
      </div>
      <Refusal error={save.error} />
    </li>
  );
}

export function CiPolicySwitch() {
  const { monorepo } = useMonorepo();
  const plain = usePlainRepo();
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;
  const shown = plain ? [plain] : repos;

  if (!shown.length) return null;

  return (
    <section className="mt-11">
      <h2 className="mb-1.5 text-[14px] leading-5 font-semibold">{TITLE}</h2>
      <p className="text-[13.5px] text-bark-dim">{WHAT}</p>
      <ul aria-label={TITLE} className="mt-3.5 border-t border-rule-faint">
        {shown.map((r) => (
          <PolicyRow key={r.name} repo={r} plain={!!plain} />
        ))}
      </ul>
    </section>
  );
}
