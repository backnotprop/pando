// Browsing files the way GitHub does (owner ruling): one folder at a time as a
// list, folders first, each row with its last change and when; the
// latest-change bar on top; the folder's README underneath.
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Avatar } from "../../../../ui/Avatar";
import { lnk } from "../../../../ui/controls";
import { FileIcon, FolderIcon, RepoIcon } from "../../../../ui/Icons";
import type { MetaVersion } from "@pando/contract";
import { Markdown } from "../../../../ui/Markdown";
import type { AppLink } from "../../../../ui/paths";
import { ago, since, useNow } from "../../../../ui/time";

export interface Row {
  kind: "up" | "dir" | "project" | "file";
  name: string;
  link: AppLink;
  change: string;
  at: number | null;
}

/** Who saved a version: their login, else the author's name ("Ana Lima <ana@x>" as "Ana Lima") for saves made before logins were kept. */
export const saverOf = (v: MetaVersion) => v.login ?? (v.author.replace(/\s*<[^>]*>\s*$/, "").trim() || v.author);

const ICONS = { up: FolderIcon, dir: FolderIcon, project: RepoIcon, file: FileIcon };

/** The bar over a list or a file: who, what, where, when, and History. */
export function ChangeBar({ who, title, id, at, history }: { who: string; title: string; id: string; at: number; history: AppLink }) {
  const clock = useNow();

  return (
    <div className="flex min-h-12 items-center gap-2.5 bg-loam px-4 py-2 text-[13.5px] phone:flex-wrap">
      <Avatar name={who} size={20} />
      <span className="flex-none text-[13px] text-bark">{who}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-bark-dim phone:order-3 phone:basis-full">{title}</span>
      <span className="ml-auto flex flex-none items-center gap-4">
        <span className="font-mono text-[12.5px] leading-[15px] text-ash phone:hidden">{id}</span>
        <span className="font-mono text-[12.5px] whitespace-nowrap text-ash">{ago(at, clock)}</span>
        <Link {...history} className={lnk}>
          History
        </Link>
      </span>
    </div>
  );
}

/** The bar for a version: its author, its path, "saved" or "deleted", when. */
export const versionBar = (v: MetaVersion, title: string, history: AppLink) => (
  <ChangeBar who={saverOf(v)} title={title} id={v.deleted ? "deleted" : "saved"} at={v.at} history={history} />
);

export function FileList({ bar, rows }: { bar: ReactNode; rows: readonly Row[] }) {
  const clock = useNow();

  return (
    <div className="overflow-hidden rounded-[10px] border border-rootline">
      {bar}
      <ul aria-label="Files">
        {rows.map((r) => {
          const Icon = ICONS[r.kind];

          return (
            <li key={`${r.kind}:${r.name}`} className={`border-t border-rule-faint ${bar ? "" : "first:border-t-0"}`}>
              <Link
                {...r.link}
                aria-label={r.kind === "up" ? "Up one folder" : undefined}
                className="grid min-h-10 grid-cols-[16px_minmax(0,300px)_minmax(0,1fr)_72px] items-center gap-3.5 px-4 hover:bg-air focus-visible:outline-offset-[-1.5px] narrow:grid-cols-[16px_minmax(0,220px)_minmax(0,1fr)_64px] phone:grid-cols-[16px_minmax(0,1fr)_52px] phone:px-3"
              >
                <Icon className={`block size-4 ${r.kind === "file" ? "text-ash" : "text-bark-dim"}`} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-bark">{r.name}</span>
                <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-ash phone:hidden">{r.change}</span>
                <span className="text-right font-mono text-[12.5px] whitespace-nowrap text-ash">{r.at ? since(r.at, clock) : ""}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Readme({ name, text }: { name: string; text: string }) {
  return (
    <section className="mt-6 overflow-hidden rounded-[10px] border border-rootline">
      <h3 className="flex items-center gap-2 border-b border-rule-faint px-4 py-[11px] font-mono text-[13px] leading-[16px] text-bark-dim">
        <FileIcon className="inline-block size-4 text-ash" />
        {name}
      </h3>
      <div className="px-[26px] pt-[22px] pb-2.5">
        <Markdown text={text} />
      </div>
    </section>
  );
}
