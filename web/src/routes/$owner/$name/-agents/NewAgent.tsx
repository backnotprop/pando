// New agent (owner, 2026-10-05: "branch should have an option to create a new
// one ... maybe add ability to select existing"): what to do, the project and
// the model (as the server lists them), and the branch as a plain choice. New
// branch (the default) needs a name the person types (owner, 2026-10-05: "a
// new branch has to have a semantic name"); one that exists is offered as the
// existing branch. Existing branch picks one of the project's open branches,
// which the agent works on as it is. It acts as the person, through a
// credential made for it (cloud-<n>).
import type { RepoName } from "@pando/contract";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { agentsKey, BRANCH_NAME, checksWords, launchAgent } from "../../../../api/agents";
import { branchesQuery } from "../../../../api/projects";
import { reposQuery } from "../../../../api/queries";
import { field, lnk } from "../../../../ui/controls";
import { Select } from "../../../../ui/dropdown";
import { SearchIcon } from "../../../../ui/IssueIcons";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { AgentDialog, fieldLabel, ModelField, useModel } from "./Dialog";

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
  const pick = useModel(open);
  const model = pick.model;
  const [existing, setExisting] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [name, setName] = useState("");
  const chosenRepo = repo ?? projects[0]?.name ?? null;
  // The project's open branches: a new name that is one of them is offered as the existing branch.
  // SAFETY: with no project the query is disabled, so the empty name is never sent.
  const openBranches = useInfiniteQuery({ ...branchesQuery(monorepo, chosenRepo ?? ("" as RepoName), "open"), enabled: chosenRepo !== null });
  const taken = new Set((openBranches.data?.pages.flatMap((p) => p.branches) ?? []).map((b) => b.name));
  const typed = name.trim();
  const nameWrong = typed !== "" && !BRANCH_NAME.test(typed);
  const nameTaken = typed !== "" && taken.has(typed);
  const chosenBranch = existing ? branch : typed && !nameWrong && !nameTaken ? typed : null;

  const reset = () => {
    setPrompt("");
    setExisting(false);
    setBranch(null);
    setName("");
  };

  const start = useMutation({
    mutationFn: () => launchAgent(monorepo, { prompt: prompt.trim(), repo: chosenRepo ?? "", model: model ?? "", branch: chosenBranch ?? "" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentsKey(monorepo) });
      reset();
      onClose();
    },
  });

  const ready = prompt.trim() && chosenRepo && model && chosenBranch && !start.isPending;

  return (
    <AgentDialog open={open} onClose={onClose} title="New agent" ready={Boolean(ready)} error={start.error} onStart={() => start.mutate()}>
      <label className={fieldLabel}>
        <span className="font-semibold text-bark">What to do</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should change"
          rows={5}
          className="min-h-32 resize-y rounded-lg border border-rootline bg-air px-3 py-2.5 text-[14px] leading-[21px] text-bark placeholder:text-ash focus:border-ash focus:outline-none"
        />
      </label>
      <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
        {projects.length > 1 ? (
          <label className={fieldLabel}>
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
        <ModelField pick={pick} />
      </div>
      <div className="grid gap-1.5 text-[13px]">
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
        </div>
        {existing ? null : (
          <>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name it for the change, e.g. theme-light-default"
              aria-label="New branch name"
              aria-invalid={nameWrong || nameTaken}
              className={`${field} h-[34px] font-mono text-[13px] placeholder:font-sans aria-invalid:border-rust-half`}
            />
            {nameTaken ? (
              <p className="text-[12.5px] text-bark-dim">
                <code className="font-mono">{typed}</code> already exists.{" "}
                <button
                  type="button"
                  className={lnk}
                  onClick={() => {
                    setBranch(typed);
                    setExisting(true);
                  }}
                >
                  Use the existing branch
                </button>
              </p>
            ) : (
              <p className="text-[12.5px] text-ash">{nameWrong ? "Letters, digits and . _ / - only, not main." : "Required. It becomes the worktree folder on every machine."}</p>
            )}
          </>
        )}
        {existing && chosenRepo ? <BranchPick repo={chosenRepo} chosen={branch} onChoose={setBranch} /> : null}
      </div>
    </AgentDialog>
  );
}

