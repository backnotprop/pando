// Pieces the Mirror to GitHub section and its setup dialog share: the switch
// (Base UI's), GitHub's mark, a source's name and the GitHub name it suggests,
// and Change, the menu of the installation's repositories.
import type { GithubRepo, GithubRepos } from "@pando/contract";
import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import type { SVGProps } from "react";
import { CheckIcon } from "../../../../ui/Icons";
import { menuItem, MenuPopup, MenuRule } from "../../../../ui/menu";

/** GitHub's mark, the Primer Octicons mark-github (MIT), shown as the CI tab shows Buildkite's. */
export const GithubMark = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path
      fill="currentColor"
      d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
    />
  </svg>
);

/** Opens in a new tab. */
const OutIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
    <path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.25 2.75 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A quiet text button: Details, Change. */
export const textButton = "inline-flex cursor-pointer items-center gap-[5px] text-[13px] whitespace-nowrap text-bark-dim hover:text-bark disabled:cursor-default disabled:opacity-40";

const SWITCH = {
  md: { root: "h-5 w-[34px]", thumb: "size-3.5 data-checked:translate-x-3.5" },
  sm: { root: "h-4 w-7", thumb: "size-2.5 data-checked:translate-x-3" },
};

/** The one switch: on is ink, off a hollow track. */
export function Toggle({ label, checked, onChange, disabled = false, size = "md" }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; size?: keyof typeof SWITCH }) {
  return (
    <Switch.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className={`relative inline-flex flex-none cursor-pointer items-center rounded-full bg-loam p-[3px] shadow-[inset_0_0_0_1px_var(--rule-hi)] data-checked:bg-bark data-checked:shadow-none data-disabled:cursor-default data-disabled:opacity-40 ${SWITCH[size].root}`}
    >
      <Switch.Thumb className={`block rounded-full bg-ash transition-transform duration-150 ease-pando data-checked:bg-soil motion-reduce:transition-none ${SWITCH[size].thumb}`} />
    </Switch.Root>
  );
}

/** A source as the section names it: a project by its last segment, the files outside projects/, or the whole repository. */
export function sourceName(path: string, full: string): string {
  if (path === "") return "Files outside projects/";

  if (path === "*" || path === ".") return full;

  return path.split("/").pop() ?? path;
}

/** The GitHub repository name a source suggests: the project's, `<repository>-files` for the files outside projects/, else the repository's. */
export function suggestedName(path: string, repository: string): string {
  if (path === "") return `${repository}-files`;

  if (path === "*" || path === ".") return repository;

  return path.split("/").pop() ?? repository;
}

/** Where a source goes: an existing GitHub repository, or one Pando creates (private). */
export type Pick = { github: GithubRepo; create: null } | { github: null; create: string };

const shortName = (r: GithubRepo) => r.full_name.split("/").pop()?.toLowerCase() ?? "";

/** The GitHub repository with the source's name, or Create when there is none. */
export function pickByName(list: GithubRepos | undefined, name: string): Pick {
  const same = list?.repos.find((r) => shortName(r) === name.toLowerCase());

  return same ? { github: same, create: null } : { github: null, create: name };
}

/** Create's name in Change: the source's, or `<name>-mirror` when that one is taken. */
const createName = (list: GithubRepos | undefined, name: string) => (list?.repos.some((r) => shortName(r) === name.toLowerCase()) ? `${name}-mirror` : name);

/**
 * Change: the installation's repositories (Public or Private), Create, and
 * Add repositories on GitHub (a new tab). The list is read again when the
 * tab regains focus, so a repository added on GitHub shows on return.
 */
export function ChangeMenu({ list, account, name, current, onPick, disabled = false }: { list: GithubRepos | undefined; account: string; name: string; current: Pick | null; onPick: (p: Pick) => void; disabled?: boolean }) {
  const create = createName(list, name);

  return (
    <Menu.Root>
      <Menu.Trigger className={textButton} disabled={disabled}>
        Change
      </Menu.Trigger>
      <MenuPopup>
        {list?.repos.map((r) => (
          <Menu.Item key={r.id} className={menuItem} onClick={() => onPick({ github: r, create: null })}>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{r.full_name}</span>
            <span className="ml-auto text-[12px] text-ash">{r.private ? "Private" : "Public"}</span>
            {current?.github?.id === r.id ? <CheckIcon className="size-3.5 flex-none text-bark" /> : <span className="size-3.5 flex-none" />}
          </Menu.Item>
        ))}
        {list?.repos.length ? <MenuRule /> : null}
        <Menu.Item className={menuItem} onClick={() => onPick({ github: null, create })}>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            Create {account}/{create}
          </span>
          <span className="ml-auto text-[12px] text-ash">Private</span>
          {current?.create === create ? <CheckIcon className="size-3.5 flex-none text-bark" /> : <span className="size-3.5 flex-none" />}
        </Menu.Item>
        {list ? (
          <Menu.Item className={menuItem} render={<a href={list.add_url} target="_blank" rel="noopener noreferrer" />}>
            <OutIcon className="size-3.5 flex-none" />
            Add repositories on GitHub
          </Menu.Item>
        ) : null}
      </MenuPopup>
    </Menu.Root>
  );
}
