// "Anyone can download releases" (mocks releases/settings.html and
// settings-plain.html), owners only: a project's release files download
// without signing in, so one install command works; its code stays members
// only. One switch per project in a repository with projects; one switch,
// laid out like Mirror to GitHub, in a plain repository.
import type { Repo } from "@pando/contract";
import { useMutation, useQueries, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { repoQuery, setReleasesPublic } from "../../../../api/releases";
import { reposQuery } from "../../../../api/queries";
import { Refusal } from "../../../../ui/controls";
import { useMonorepo, usePlainRepo } from "../-frame/heads";
import { Toggle } from "./mirror-parts";

const TITLE = "Anyone can download releases";

const WHAT = "Release files only. Code stays members only.";

/** One repo's switch: its answer replaces the repo's record. */
function useSwitch(repo: Repo) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (on: boolean) => setReleasesPublic(monorepo, repo.name, on),
    onSuccess: (saved) => qc.setQueryData(repoQuery(monorepo, repo.name).queryKey, saved),
  });
}

/** What the switch shows: the write on its way, else the record (off until read). */
const shown = (flip: ReturnType<typeof useSwitch>, saved: boolean | undefined) => (flip.isPending && flip.variables !== undefined ? flip.variables : (saved ?? false));

function ProjectRow({ repo, saved }: { repo: Repo; saved: boolean | undefined }) {
  const flip = useSwitch(repo);
  const on = shown(flip, saved);

  return (
    <li className="border-b border-rule-faint">
      <div className="flex min-h-[46px] items-center gap-3.5 text-[14px]">
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-bark">{repo.path}</span>
        <span className="ml-auto text-[13px] whitespace-nowrap text-ash">{on ? "Anyone" : "Members only"}</span>
        <Toggle label={`Anyone can download ${repo.path}'s releases`} checked={on} disabled={saved === undefined || flip.isPending} onChange={(v) => flip.mutate(v)} />
      </div>
      <Refusal error={flip.error} />
    </li>
  );
}

function Plain({ repo, saved }: { repo: Repo; saved: boolean | undefined }) {
  const flip = useSwitch(repo);

  return (
    <>
      <div className="mb-1.5 flex items-center gap-3">
        <h2 className="text-[14px] leading-5 font-semibold">{TITLE}</h2>
        <span className="ml-auto flex">
          <Toggle label={TITLE} checked={shown(flip, saved)} disabled={saved === undefined || flip.isPending} onChange={(v) => flip.mutate(v)} />
        </span>
      </div>
      <p className="text-[13.5px] text-bark-dim">{WHAT}</p>
      <Refusal error={flip.error} />
    </>
  );
}

export function ReleasesSwitch() {
  const { monorepo } = useMonorepo();
  const plain = usePlainRepo();
  const repos = useSuspenseQuery(reposQuery(monorepo)).data;
  const saved = useQueries({ queries: repos.map((r) => repoQuery(monorepo, r.name)) }).map((q) => q.data?.releases_public);

  if (plain) {
    return (
      <section className="mt-11">
        <Plain repo={plain} saved={saved[repos.indexOf(plain)]} />
      </section>
    );
  }

  if (!repos.length) return null;

  return (
    <section className="mt-11">
      <h2 className="mb-1.5 text-[14px] leading-5 font-semibold">{TITLE}</h2>
      <p className="text-[13.5px] text-bark-dim">{WHAT}</p>
      <ul aria-label={TITLE} className="mt-3.5 border-t border-rule-faint">
        {repos.map((r, i) => (
          <ProjectRow key={r.name} repo={r} saved={saved[i]} />
        ))}
      </ul>
    </section>
  );
}
