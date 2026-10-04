// Clone, prominent like GitHub's Code button (owner note): `pando clone` for
// the whole monorepo, and one project's plain git URL.
import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import type { Repo } from "@pando/contract";
import { Cmd } from "../../../../ui/controls";
import { Caret, Select } from "../../../../ui/dropdown";

const heading = "mb-2 text-[13px] leading-[18px] font-semibold text-bark";

/**
 * `pando clone` for the whole monorepo, then git for one project. On a
 * project's own page (`only`), its worktree command and its URL, no select.
 */
export function Clone({ full, repos, plain, only }: { full: string; repos: readonly Repo[]; plain: boolean; only?: Repo }) {
  const [path, setPath] = useState(only?.path ?? repos[0]?.path ?? "");
  const repo = repos.find((r) => r.path === path) ?? repos[0];

  return (
    <Popover.Root>
      <Popover.Trigger className="inline-flex h-8 cursor-pointer items-center justify-center rounded-[7px] bg-bark px-3.5 text-[13.5px] leading-[16px] font-semibold whitespace-nowrap text-soil hover:bg-bark-hi">
        Clone
        <Caret kind="button" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-10">
          <Popover.Popup className="w-[440px] max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-[10px] border border-rootline bg-pop p-4 shadow-pop outline-none transition-[opacity,scale] duration-150 ease-pando data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-opacity">
            <div>
              <h4 className={heading}>With Pando</h4>
              <Cmd text={`pando clone ${full}`} wide />
            </div>
            {only && only.path !== "." ? (
              <div className="mt-3.5 border-t border-rule-faint pt-3.5">
                <h4 className={heading}>A worktree for a new branch</h4>
                <Cmd text={`pando worktree add ${only.path} <branch>`} wide />
              </div>
            ) : null}
            {repo ? (
              <div className="mt-3.5 border-t border-rule-faint pt-3.5">
                <h4 className={heading}>{plain ? "With git" : "One project, with git"}</h4>
                {plain || only ? null : (
                  <div className="mb-2 flex items-center gap-2">
                    <Select label="Project" value={repo.path} onChange={setPath} size="small">
                      {repos.map((r) => (
                        <option key={r.path}>{r.path}</option>
                      ))}
                    </Select>
                  </div>
                )}
                <Cmd text={repo.clone_url} url wide />
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
