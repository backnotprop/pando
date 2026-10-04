// New issue (SPEC.md 7.4): a title, the description in the editor, and the
// sidebar's three pickers on the draft. Create issue sends one POST with an
// idempotency key kept across retries, then opens the new issue's page.
import type { Label } from "@pando/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createIssue, issueKey, labelsQuery, newKey } from "../../../../api/issues";
import { reposQuery } from "../../../../api/queries";
import { button, field, lnk, Refusal } from "../../../../ui/controls";
import { Title } from "../../../../ui/pages";
import { issueLink, issuesLink } from "../../../../ui/paths";
import { useMonorepo } from "../-frame/heads";
import { Editor } from "./Editor";
import { type FactChange, FactSections } from "./Sidebar";

export function NewIssue({ project }: { project: string | null }) {
  const { monorepo } = useMonorepo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const known = useQuery(labelsQuery(monorepo)).data ?? [];
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignees, setAssignees] = useState<readonly string[]>([]);
  const [labels, setLabels] = useState<readonly Label[]>([]);
  const [chosen, setProject] = useState<string | null>(project);
  // One key for this issue, kept across retries: a lost answer never makes a second one.
  const [attempt] = useState(newKey);

  const create = useMutation({
    mutationFn: () => createIssue(monorepo, { title: title.trim(), body, labels: labels.map((l) => l.name), assignees, project: chosen }, attempt),
    onSuccess: (issue) => {
      qc.setQueryData(issueKey(monorepo, issue.number), issue);
      void navigate(issueLink(monorepo.full, issue.number));
    },
  });

  const change = (c: FactChange) => {
    if (c.assignees) setAssignees((a) => [...a.filter((x) => !c.assignees?.remove.includes(x)), ...(c.assignees?.add ?? [])]);

    if (c.labels) setLabels((l) => [...l.filter((x) => !c.labels?.remove.includes(x.name)), ...known.filter((x) => c.labels?.add.includes(x.name))]);

    if (c.project !== undefined) setProject(c.project);
  };

  const submit = () => {
    if (title.trim() && !create.isPending) create.mutate();
  };

  return (
    <>
      <Title>New issue</Title>
      <div className="mt-[22px] mb-7 h-px bg-rootline" />
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-14 narrow:grid-cols-[minmax(0,1fr)_260px] narrow:gap-10 phone:grid-cols-[minmax(0,1fr)] phone:gap-[22px]">
        <form
          className="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="mb-[18px] flex flex-col gap-2">
            <span className="text-[13px] font-semibold text-bark-dim">Title</span>
            <input autoFocus required maxLength={256} value={title} onChange={(e) => setTitle(e.target.value)} className={`${field} h-[38px] text-[15px]`} />
          </label>
          <div className="mb-2 text-[13px] font-semibold text-bark-dim">Description</div>
          <Editor label="Description" value={body} onChange={setBody} full={monorepo.full} placeholder="Add a description" tall ground="air" onSubmit={submit} />
          <div className="mt-4 flex items-center justify-end gap-4">
            <Refusal error={create.error} />
            <button type="button" className={lnk} onClick={() => void navigate(issuesLink(monorepo.full))}>
              Cancel
            </button>
            <button type="submit" className={button("solid")} disabled={!title.trim() || create.isPending}>
              Create issue
            </button>
          </div>
        </form>
        <aside aria-label="Details" className="phone:order-first">
          <FactSections facts={{ assignees, labels, project: chosen, projectPath: repos.find((r) => r.name === chosen)?.path ?? null }} onChange={change} />
        </aside>
      </div>
    </>
  );
}
