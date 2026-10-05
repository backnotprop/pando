// Address with agent (owner, 2026-10-04; the branch named from the issue,
// owner, 2026-10-05): the branch, prefilled as the issue's number and its
// title's first words and changeable; words to add, optional; the project
// (the issue's when it names one) and the model. The branch is linked to the
// issue, so merging it closes the issue. It acts as the person.
import { Dialog } from "@base-ui/react/dialog";
import { type Issue, issueBranchName, type RepoName } from "@pando/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addressIssue, agentModelsQuery, agentsKey, BRANCH_NAME } from "../../../../api/agents";
import { issueKey } from "../../../../api/issues";
import { reposQuery } from "../../../../api/queries";
import { button, field, Refusal } from "../../../../ui/controls";
import { Select } from "../../../../ui/dropdown";
import { Leaf } from "../../../../ui/Leaf";
import { useMonorepo } from "../-frame/heads";

const label = "grid gap-1.5 text-[13px]";

export function AddressAgent({ issue, open, onClose }: { issue: Issue; open: boolean; onClose: () => void }) {
  const { monorepo, info } = useMonorepo();
  const qc = useQueryClient();
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const projects = info.kind === "monorepo" ? repos.filter((r) => r.path !== "." && r.path !== "meta") : repos;
  const models = useQuery(agentModelsQuery(monorepo)).data ?? [];
  const [chosenModel, setModel] = useState<string | null>(null);
  const model = chosenModel ?? models[0]?.id ?? null;
  const [repo, setRepo] = useState<RepoName | null>(null);
  const chosenRepo = repo ?? issue.project ?? (projects.length === 1 ? (projects[0]?.name ?? null) : null);
  const [name, setName] = useState<string | null>(null);
  const branch = (name ?? issueBranchName(issue.number, issue.title)).trim();
  const nameWrong = !BRANCH_NAME.test(branch);
  const [prompt, setPrompt] = useState("");

  const start = useMutation({
    mutationFn: () => addressIssue(monorepo, issue.number, { branch, model: model ?? "", repo: chosenRepo, prompt: prompt.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentsKey(monorepo) });
      void qc.invalidateQueries({ queryKey: issueKey(monorepo, issue.number) });
      setName(null);
      setPrompt("");
      onClose();
    },
  });

  const ready = model && chosenRepo && !nameWrong && !start.isPending;

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
            className="grid gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();

              if (ready) start.mutate();
            }}
          >
            <Dialog.Title className="flex items-center gap-2.5 text-[16px] font-semibold">
              <Leaf state="idle" size={20} />
              Address with agent <span className="font-normal text-ash">#{issue.number}</span>
            </Dialog.Title>
            <label className={label}>
              <span className="font-semibold text-bark">Branch</span>
              <input value={name ?? branch} onChange={(e) => setName(e.target.value)} aria-invalid={nameWrong} className={`${field} h-[34px] font-mono text-[13px] aria-invalid:border-rust-half`} />
              <span className="text-[12.5px] text-ash">
                {nameWrong ? "Letters, digits and . _ / - only, not main." : `From the issue's number and title; change it if you like. Linked to #${issue.number}: merging it closes the issue.`}
              </span>
            </label>
            <label className={label}>
              <span className="font-semibold text-bark">
                Add <i className="font-normal text-ash">optional</i>
              </span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Anything the issue does not say"
                rows={3}
                className="resize-y rounded-lg border border-rootline bg-air px-3 py-2.5 text-[14px] leading-[21px] text-bark placeholder:text-ash focus:border-ash focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
              {projects.length > 1 ? (
                <label className={label}>
                  <span className="font-semibold text-bark">Project</span>
                  <Select label="Project" value={chosenRepo ?? ""} wide onChange={(v) => setRepo(projects.find((r) => r.name === v)?.name ?? null)}>
                    {chosenRepo ? null : <option value="">Choose a project</option>}
                    {projects.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.path}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <label className={label}>
                <span className="font-semibold text-bark">Model</span>
                <Select label="Model" value={model ?? ""} wide onChange={setModel}>
                  {models.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <Refusal error={start.error} />
            <div className="mt-1.5 flex items-center justify-end gap-2.5">
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
