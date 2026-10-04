// Add pipeline, for owners: a small form in a panel (the project, the
// pipeline's slug, and the Buildkite organization when more than one is
// connected) that registers the project's Buildkite hook, so each push starts
// a build of that pipeline. No secret is involved, so it happens here; the
// pipeline joins the list when the hook is made.
import { Popover } from "@base-ui/react/popover";
import type { CiConnection, RepoName } from "@pando/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addPipeline } from "../../../../api/actions";
import { ciQuery } from "../../../../api/ci";
import { button, field, Refusal } from "../../../../ui/controls";
import { Select } from "../../../../ui/dropdown";
import { useMonorepo } from "../-frame/heads";

/** A Buildkite pipeline's slug, as in buildkite.com/<org>/<pipeline> (the CLI's rule). */
const SLUG = "[a-z0-9][a-z0-9_\\-]{0,99}";

const label = "mb-1.5 block text-[12px] text-ash";

export function AddPipeline({ projects, project, connections }: { projects: readonly { repo: RepoName; path: string }[]; project: RepoName; connections: readonly CiConnection[] }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState<string>(project);
  const [slug, setSlug] = useState("");
  const [org, setOrg] = useState(connections[0]?.organization ?? "");
  const chosen = projects.find((p) => p.repo === repo)?.repo ?? project;

  const add = useMutation({
    mutationFn: () => addPipeline(monorepo, chosen, org, slug.trim().toLowerCase()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ciQuery(monorepo).queryKey });
      setOpen(false);
      setSlug("");
    },
  });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={button("quiet", 28)}>Add pipeline</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-10">
          <Popover.Popup className="w-[340px] max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-[10px] border border-rootline bg-pop p-4 text-left shadow-pop outline-none transition-[opacity,scale] duration-150 ease-pando data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-opacity">
            <form
              aria-label="Add pipeline"
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                add.mutate();
              }}
            >
              <label>
                <span className={label}>Project</span>
                <Select label="Project" value={chosen} onChange={setRepo} wide>
                  {projects.map((p) => (
                    <option key={p.repo} value={p.repo}>
                      {p.path}
                    </option>
                  ))}
                </Select>
              </label>
              {connections.length > 1 ? (
                <label>
                  <span className={label}>Organization</span>
                  <Select label="Organization" value={org} onChange={setOrg} wide>
                    {connections.map((c) => (
                      <option key={c.id}>{c.organization}</option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <label>
                <span className={label}>Pipeline</span>
                <input
                  className={`${field} w-full`}
                  required
                  pattern={SLUG}
                  placeholder="pipeline-slug"
                  autoComplete="off"
                  spellCheck={false}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </label>
              <span>
                <button type="submit" className={button("solid", 30)} disabled={add.isPending}>
                  Add pipeline
                </button>
              </span>
              <Refusal error={add.error} />
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
