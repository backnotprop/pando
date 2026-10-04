// A branch's Files changed tab, read only (comments stay in Plannotator): each
// changed file in its own box, as the code view draws a file. A header row
// (the path, what happened to it, its added and removed lines) opens and
// closes its unified diff, coloured by Diff.tsx (loaded on first use). A large
// diff starts closed; a file with no patch says why.
import type { BranchDiff, ChangedFile } from "@pando/contract";
import { lazy, Suspense, useState } from "react";
import { Empty } from "../../../../ui/controls";
import { Chevron } from "../../../../ui/Icons";

const Diff = lazy(() => import("../-code/Diff"));

/** Owner board: a file with more changed lines than this starts closed. */
const START_CLOSED = 400;

const WHY = {
  binary: "Binary file",
  too_large: "Too large to show (over 1 MiB, or over 20,000 changed lines)",
  budget: "Not shown: this branch's changes are over 2 MiB",
} as const;

const note = "border-t border-rule-faint px-4 py-3 text-[13px] leading-5 text-ash";

const changed = (f: ChangedFile) => (f.additions ?? 0) + (f.deletions ?? 0);

/** The patch's lines after its header, for the space the diff takes while it loads. */
const bodyLines = (patch: string) => patch.slice(Math.max(0, patch.indexOf("\n@@"))).split("\n").length - 1;

function Counts({ f }: { f: ChangedFile }) {
  if (f.additions === null || f.deletions === null || f.additions + f.deletions === 0) return null;

  return (
    <span className="flex flex-none gap-2 font-mono text-[12.5px] leading-[15px]">
      <span className="text-[var(--diffs-token-inserted)]">+{f.additions.toLocaleString("en-US")}</span>
      <span className="text-[var(--diffs-token-deleted)]">−{f.deletions.toLocaleString("en-US")}</span>
    </span>
  );
}

/** A path that may break after any `/`. */
const breakable = (path: string) => path.split("/").map((part, i, all) => (i < all.length - 1 ? [part, "/", <wbr key={i} />] : part));

function Path({ f }: { f: ChangedFile }) {
  return (
    // On a phone a long path wraps after a folder, so its file name is never cut off.
    <span className="min-w-0 flex-1 overflow-hidden font-mono text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-bark phone:whitespace-normal phone:[overflow-wrap:anywhere]">
      {f.old_path ? <span className="text-ash">{breakable(f.old_path)} → </span> : null}
      {breakable(f.path)}
    </span>
  );
}

function FileBox({ f, open, toggle }: { f: ChangedFile; open: boolean; toggle: () => void }) {
  const row = "flex min-h-11 w-full items-center gap-2.5 py-1.5 pr-4 pl-4 text-left";
  const status = <span className="flex-none text-[12.5px] leading-[15px] text-ash">{f.status}</span>;

  // No patch: the header and why, nothing to open (the chevron's room kept, so paths line up).
  if (f.patch === null) {
    return (
      <li className="overflow-hidden rounded-[10px] border border-rootline">
        <div className={row}>
          <span className="-ml-1 size-3.5 flex-none" />
          <Path f={f} />
          {status}
          <Counts f={f} />
        </div>
        <p className={note}>{WHY[f.patch_omitted ?? "too_large"]}</p>
      </li>
    );
  }

  const hunks = f.patch.includes("\n@@");

  return (
    <li className="overflow-hidden rounded-[10px] border border-rootline">
      <button type="button" aria-expanded={open} className={`${row} cursor-pointer hover:bg-loam`} onClick={toggle}>
        <Chevron className={`-ml-1 size-3.5 flex-none text-ash ${open ? "" : "-rotate-90"}`} />
        <Path f={f} />
        {status}
        <Counts f={f} />
      </button>
      {!open ? null : hunks ? (
        <div className="border-t border-rule-faint">
          <Suspense fallback={<div style={{ height: bodyLines(f.patch) * 20 + 24 }} />}>
            <Diff patch={f.patch} id={`${f.old_sha ?? "none"}..${f.new_sha ?? "none"}:${f.path}`} />
          </Suspense>
        </div>
      ) : (
        <p className={note}>{f.status === "renamed" ? "Renamed, no line changes." : "No line changes."}</p>
      )}
    </li>
  );
}

export function FilesChanged({ diff }: { diff: BranchDiff }) {
  // Open or closed by the person, per path; otherwise a large diff starts closed.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});

  if (!diff.files.length) return <Empty>No files changed.</Empty>;

  return (
    <>
      {diff.too_many_files ? (
        <p className="mb-3.5 rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
          The first {diff.files.length.toLocaleString("en-US")} of {diff.files_total.toLocaleString("en-US")} files.
        </p>
      ) : null}
      <ul aria-label="Files changed" className="grid gap-4">
        {diff.files.map((f) => {
          const open = chosen[f.path] ?? changed(f) <= START_CLOSED;

          return <FileBox key={f.path} f={f} open={open} toggle={() => setChosen((c) => ({ ...c, [f.path]: !open }))} />;
        })}
      </ul>
    </>
  );
}
