// The branch picker on a repo's code pages: names lead (owner note), each
// branch's state small and quiet beside it; main is marked default.
import { Popover } from "@base-ui/react/popover";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Repo } from "@pando/contract";
import { branchesQuery } from "../../../../api/projects";
import { Caret } from "../../../../ui/dropdown";
import { BranchIcon } from "../../../../ui/Icons";
import type { AppLink } from "../../../../ui/paths";
import { branchesLink } from "../../../../ui/paths";
import { useMonorepo } from "../-frame/heads";
import { stateOf, unknownWhy } from "./state";

const QUIET = { ready: "text-bark-dim", bad: "text-rust", wait: "text-ash", merged: "text-ash" };

const row = "flex w-full items-center rounded-md px-2.5 text-left text-[13.5px] text-bark-dim outline-none hover:bg-pop-hi hover:text-bark focus-visible:bg-pop-hi";

const item = `${row} h-[34px] gap-2.5 data-current:bg-pop-hi`;

const footer = `${row} h-8 gap-3`;

/** `at(branch)` is where picking a branch goes: this same folder or file on that branch. */
export function BranchPicker({ repo, gitRef, at }: { repo: Repo; gitRef: string | null; at: (ref: string | null) => AppLink }) {
  const { monorepo } = useMonorepo();
  const [find, setFind] = useState("");
  const open = useInfiniteQuery(branchesQuery(monorepo, repo.name, "open")).data?.pages.flatMap((p) => p.branches) ?? [];
  const shown = open.filter((b) => b.name.toLowerCase().includes(find.trim().toLowerCase()));
  const current = gitRef ?? "main";

  return (
    <Popover.Root onOpenChange={() => setFind("")}>
      <Popover.Trigger className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-[7px] border border-rootline bg-loam pr-2.5 pl-[11px] font-mono text-[13px] leading-[16px] text-bark hover:border-rule-hi data-popup-open:border-rule-hi">
        <BranchIcon className="size-[15px] flex-none text-ash" />
        {current}
        <Caret />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-10">
          <Popover.Popup className="w-[330px] origin-(--transform-origin) rounded-[10px] border border-rootline bg-pop p-1.5 shadow-pop outline-none transition-[opacity,scale] duration-150 ease-pando data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-opacity">
            <div className="px-2.5 pt-2 pb-1.5 text-[12px] text-ash">Switch branch</div>
            <div className="px-1 pt-1 pb-2">
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Find a branch"
                aria-label="Find a branch"
                autoComplete="off"
                className="h-[30px] w-full min-w-0 rounded-[7px] border border-rootline bg-air px-3 text-[13px] text-bark placeholder:text-ash focus:border-ash focus:outline-none"
              />
            </div>
            <nav aria-label="Branches">
              {"main".includes(find.trim().toLowerCase()) ? (
                <Link {...at(null)} data-current={current === "main" || undefined} className={item}>
                  <BranchIcon className="size-3.5 flex-none text-ash" />
                  <span className="overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap text-bark">main</span>
                  <span className="ml-auto rounded-full border border-rootline px-1.5 text-[11px] leading-[17px] text-ash">default</span>
                </Link>
              ) : null}
              {shown.map((b) => {
                const s = stateOf(b);

                return (
                  <Link key={b.name} {...at(b.name)} data-current={current === b.name || undefined} className={item}>
                    <BranchIcon className="size-3.5 flex-none text-ash" />
                    <span className="overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap text-bark">{b.name}</span>
                    <span title={unknownWhy(b) ?? undefined} className={`ml-auto text-[12px] whitespace-nowrap ${QUIET[s.tone]}`}>
                      {s.text}
                    </span>
                  </Link>
                );
              })}
            </nav>
            <hr className="mx-1 my-1.5 border-t border-rootline" />
            <Link {...branchesLink(monorepo.full, repo.path)} className={footer}>
              View all branches
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
