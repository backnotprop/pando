// New agent (owner, 2026-10-05: "branch should have an option to create a new
// one ... maybe add ability to select existing"): what to do, the project and
// the model, and the branch as a plain choice. New branch (the default) is
// made off main as agent/<its number>; Existing branch picks one of the
// project's open branches, which the agent works on as it is. It acts as the
// person, through a credential made for it (cloud-<n>).
import { Dialog } from "@base-ui/react/dialog";
import type { RepoName } from "@pando/contract";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { agentsKey, checksWords, launchAgent, MODELS } from "../../../../api/agents";
import { branchesQuery } from "../../../../api/projects";
import { reposQuery } from "../../../../api/queries";
import { button, Refusal } from "../../../../ui/controls";
import { Select } from "../../../../ui/dropdown";
import { SearchIcon } from "../../../../ui/IssueIcons";
import { Leaf } from "../../../../ui/Leaf";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";

const segment = "inline-flex h-7 cursor-pointer items-center rounded-[7px] px-3 text-[13px] text-bark-dim aria-pressed:bg-pop-hi aria-pressed:font-semibold aria-pressed:text-bark";

/** The project's open branches to pick from, with a box to find one. */
function BranchPick({ repo, chosen, onChoose }: { repo: RepoName; chosen: string | null; onChoose: (b: string) => void }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const [find, setFind] = useState("");
  const open = useInfiniteQuery(branchesQuery(monorepo, repo, "open"));
  const branches = (open.data?.pages.flatMap((p) => p.branches) ?? []).filter((b) => b.name.toLowerCase().includes(find.trim().toLowerCase()));

  return (
    <div className="mt-2 grid max-h-[220px] gap-0.5 overflow-auto rounded-[9px] p-1 shadow-[inset_0_0_0_1px_var(--rootline)]">
      <label className="mb-0.5 flex h-8 items-center gap-2 rounded-[7px] bg-air px-2.5 text-[13px] text-ash">
        <SearchIcon className="size-3.5 flex-none" />
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a branch" aria-label="Find a branch" className="min-w-0 flex-1 bg-transparent text-bark placeholder:text-ash focus:outline-none" />
      </label>
      {branches.map((b) => (
        <button
          key={b.name}
          type="button"
          aria-pressed={chosen === b.name}
          onClick={() => onChoose(b.name)}
          className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13px] hover:bg-pop-hi aria-pressed:bg-loam"
        >
          <code className="overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-bark">{b.name}</code>
          <span className="text-[12px] whitespace-nowrap text-ash">
            {b.pushed_machine ? `${b.author ?? "someone"} · ${b.pushed_machine}` : (b.author ?? "")}
            {b.updated_at ? ` · ${ago(b.updated_at, clock)}` : ""}
          </span>
          <span className="col-span-2 text-[12px] text-ash">
            {[b.stale || b.ahead === null ? null : `${b.ahead} commit${b.ahead === 1 ? "" : "s"} ahead of main`, checksWords(b.checks.state) || null].filter(Boolean).join(" · ")}
          </span>
        </button>
      ))}
      {open.isSuccess && !branches.length ? <p className="px-2.5 py-2 text-[13px] text-ash">{find ? "No open branch matches." : "No open branches."}</p> : null}
    </div>
  );
}

export function NewAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { monorepo, info } = useMonorepo();
  const qc = useQueryClient();
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const projects = info.kind === "monorepo" ? repos.filter((r) => r.path !== ".") : repos;
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState<RepoName | null>(null);
  const [model, setModel] = useState<string>(MODELS[0].id);
  const [existing, setExisting] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const chosenRepo = repo ?? projects[0]?.name ?? null;

  const reset = () => {
    setPrompt("");
    setExisting(false);
    setBranch(null);
  };

  const start = useMutation({
    mutationFn: () => launchAgent(monorepo, { prompt: prompt.trim(), repo: chosenRepo ?? "", model, branch: existing ? branch : null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentsKey(monorepo) });
      reset();
      onClose();
    },
  });

  const ready = prompt.trim() && chosenRepo && (!existing || branch) && !start.isPending;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-10 bg-[color-mix(in_srgb,var(--soil)_72%,transparent)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[112px] left-1/2 z-10 w-[560px] max-w-[calc(100%-32px)] -translate-x-1/2 rounded-xl border border-rootline bg-pop px-[22px] pt-5 pb-5 shadow-pop outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 phone:top-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();

              if (ready) start.mutate();
            }}
          >
            <Dialog.Title className="mb-3.5 flex items-center gap-2.5 text-[16px] font-semibold">
              <Leaf state="idle" size={20} />
              New agent
            </Dialog.Title>
            <label className="grid gap-1.5 text-[13px]">
              <span className="font-semibold text-bark">What to do</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should change"
                rows={5}
                className="min-h-32 resize-y rounded-lg border border-rootline bg-air px-3 py-2.5 text-[14px] leading-[21px] text-bark placeholder:text-ash focus:border-ash focus:outline-none"
              />
            </label>
            <div className="mt-3.5 grid grid-cols-2 gap-3 phone:grid-cols-1">
              {projects.length > 1 ? (
                <label className="grid gap-1.5 text-[13px]">
                  <span className="font-semibold text-bark">Project</span>
                  <Select
                    label="Project"
                    value={chosenRepo ?? ""}
                    wide
                    onChange={(v) => {
                      setRepo(projects.find((r) => r.name === v)?.name ?? null);
                      setBranch(null);
                    }}
                  >
                    {projects.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.path}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <label className="grid gap-1.5 text-[13px]">
                <span className="font-semibold text-bark">Model</span>
                <Select label="Model" value={model} wide onChange={setModel}>
                  {MODELS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="mt-3.5 grid gap-1.5 text-[13px]">
              <span className="font-semibold text-bark">Branch</span>
              <div className="flex flex-wrap items-center gap-2.5">
                <span role="group" aria-label="Branch" className="inline-flex gap-0.5 rounded-[9px] bg-air p-[3px] shadow-[inset_0_0_0_1px_var(--rootline)]">
                  <button type="button" aria-pressed={!existing} className={segment} onClick={() => setExisting(false)}>
                    New branch
                  </button>
                  <button type="button" aria-pressed={existing} className={segment} onClick={() => setExisting(true)}>
                    Existing branch
                  </button>
                </span>
                {existing ? null : (
                  <span className="text-ash">
                    made off main as <code className="font-mono text-[12.5px] text-link">agent/</code> and the agent&apos;s number
                  </span>
                )}
              </div>
              {existing && chosenRepo ? <BranchPick repo={chosenRepo} chosen={branch} onChoose={setBranch} /> : null}
            </div>
            <Refusal error={start.error} />
            <div className="mt-5 flex items-center justify-end gap-2.5">
              <span className="mr-auto text-[12.5px] text-ash">Acts as you</span>
              <button type="button" className={button("quiet")} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className={button("solid")} disabled={!ready}>
                Start
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

