// Pieces the CI pages and a branch's checks share: a build's or job's state in
// words, a list of builds, a build's facts, the service's mark, and a button
// that opens the terminal command for what the web does not do itself.
import { Popover } from "@base-ui/react/popover";
import type { CiBuild, CiState } from "@pando/contract";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { going } from "../../../../api/ci";
import { CheckMark } from "../../../../ui/activity";
import { Avatar } from "../../../../ui/Avatar";
import { button, Cmd } from "../../../../ui/controls";
import { ciBuildLink } from "../../../../ui/paths";
import { useArrivals } from "../../../../ui/arrival";
import { ago, elapsed, useSeconds } from "../../../../ui/time";

/** Words first, colour second: Rust only for a failure. */
const TONE: Record<CiState, string> = {
  passed: "text-bark-dim",
  failed: "font-semibold text-rust",
  running: "text-ash",
  queued: "text-ash",
  blocked: "text-ash",
  canceled: "text-ash",
  skipped: "text-ash",
};

/** A build's or a job's state in words; `fox-cool` takes Foxfire while its row arrives. */
export const BuildState = ({ state }: { state: CiState }) => <span className={`fox-cool text-[13px] whitespace-nowrap ${TONE[state]}`}>{state}</span>;

/** A CI service's name as people write it (Buildkite is the one Pando connects today). */
export const serviceName = (service: string) => (service === "buildkite" ? "Buildkite" : service);

/** The service's mark, where that service ran it (Buildkite only, for the contest). */
export const ServiceMark = ({ service, height }: { service: string; height?: number }) => (service === "buildkite" ? <CheckMark height={height} /> : null);

/** A build's facts: #1285 and its pipeline, then its branch and commit in mono; `branch` replaces the branch's plain name (a link). */
export function BuildFacts({ b, branch }: { b: CiBuild; branch?: ReactNode }) {
  return (
    <>
      <b className="font-normal text-bark-dim">#{b.number}</b>
      <span>{b.pipeline}</span>
      {branch ?? (b.branch ? <span className="font-mono">{b.branch}</span> : null)}
      {b.sha ? <span className="font-mono">{b.sha.slice(0, 7)}</span> : null}
      {/* Cancelled by Pando for a newer push to its branch. */}
      {b.superseded_by ? (
        <span>
          superseded by <span className="font-mono">{b.superseded_by.slice(0, 7)}</span>
        </span>
      ) : null}
    </>
  );
}

/** One line of a build's facts, in ash, its size given where it is used; on a phone it wraps. */
export const facts = "flex items-center gap-2.5 overflow-hidden whitespace-nowrap text-ash phone:flex-wrap phone:gap-y-0.5 phone:whitespace-normal";

const cols = "grid-cols-[72px_minmax(0,1fr)_140px_96px] phone:grid-cols-[64px_minmax(0,1fr)_auto]";

/** Builds, newest first: state, the commit's title with the build's facts, who pushed, when and how long. */
export function BuildList({ full, builds, label }: { full: string; builds: readonly CiBuild[]; label: string }) {
  const clock = useSeconds(builds.some((b) => going(b.state)));
  // A build that comes in, or moves, while the list is open plays the arrival.
  const arrived = useArrivals(builds.map((b) => ({ key: b.id, state: b.state })));

  return (
    <ul aria-label={label}>
      {builds.map((b) => (
        <li key={`${b.id}:${b.state}`} className={`border-t border-rule-faint ${arrived(b.id) ? "arrived" : ""}`}>
          <Link
            {...ciBuildLink(full, b.pipeline, b.number)}
            className={`-mx-2.5 grid min-h-14 items-center gap-4 rounded-[7px] px-2.5 py-2 hover:bg-air focus-visible:bg-air ${cols}`}
          >
            <BuildState state={b.state} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="fox-cool overflow-hidden text-ellipsis whitespace-nowrap text-bark">{b.message ?? `Build #${b.number}`}</span>
              {/* The prototype's .bmeta sets its font with the shorthand, so its line is the font's own height (15 px at 12.5 px). */}
              <span className={`${facts} text-[12.5px] leading-[15px]`}>
                <BuildFacts b={b} />
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[13px] whitespace-nowrap text-bark-dim phone:hidden">
              {b.pushed_by ? (
                <>
                  <Avatar name={b.pushed_by} size={18} />
                  <span className="min-w-0 overflow-hidden text-ellipsis">{b.pushed_by}</span>
                </>
              ) : null}
            </span>
            <span className="flex flex-col items-end gap-0.5 text-[12.5px] whitespace-nowrap text-ash">
              <span>{b.created_at ? ago(b.created_at, clock) : ""}</span>
              <span>{elapsed(b, clock)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A quiet button that opens a terminal command with Copy: for what needs a secret shown once, or the CLI does best. */
export function CommandButton({ label, heading, command, size = 32 }: { label: string; heading: string; command: string; size?: 32 | 28 }) {
  return (
    <Popover.Root>
      <Popover.Trigger className={button("quiet", size)}>{label}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-10">
          <Popover.Popup className="w-[520px] max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-[10px] border border-rootline bg-pop p-4 shadow-pop outline-none transition-[opacity,scale] duration-150 ease-pando data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-opacity">
            <h4 className="mb-2 text-[13px] leading-[18px] font-semibold text-bark">{heading}</h4>
            <Cmd text={command} wide />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
