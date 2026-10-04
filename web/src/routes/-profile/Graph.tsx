// The contribution graph (profile SPEC 4.1, mock `graph`): a square per day
// of the last year, 53 week columns from a Sunday, Sunday on top, in five
// steps by the person's own quartiles (`levels`), coloured by the theme
// (graph.css). Hover, or the arrow keys once the grid has focus, show a day's
// count and its split; a click or Enter picks the day. On a phone it scrolls
// sideways inside its box, starting at today. Your own work landing while it
// is open makes its day glow once.
import type { ContributionDay, Contributions } from "@pando/contract";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { DOCS } from "../../ui/paths";
import { count } from "./words";

const DAY_MS = 86_400_000;

const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "Saturday, October 3". */
export const longDay = (d: string) => new Date(parse(d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/** A square's words, for the popover's first line and a screen reader: "212 contributions on Saturday, October 3". */
export const dayLabel = (n: number, d: string) => `${n ? count(n, "contribution", "contributions") : "No contributions"} on ${longDay(d)}`;

/** "180 commits, 24 branches opened, 8 reviews". */
function splitOf(d: ContributionDay | undefined): string {
  if (!d) return "";

  return [
    d.commit ? count(d.commit, "commit", "commits") : "",
    d.branch ? count(d.branch, "branch opened", "branches opened") : "",
    d.review ? count(d.review, "review", "reviews") : "",
    d.created ? count(d.created, "repository made", "repositories made") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The step of a day's count: 0 for none, then the highest level it reaches. */
export function stepOf(n: number, levels: readonly number[]): number {
  let step = 0;

  for (const [i, l] of levels.entries()) if (n >= l) step = i + 1;

  return step;
}

const cellId = (d: string) => `day-${d}`;

/** The arrow keys' steps, in days: a row is a weekday, a column a week. */
const ARROWS = new Map([
  ["ArrowUp", -1],
  ["ArrowDown", 1],
  ["ArrowLeft", -7],
  ["ArrowRight", 7],
]);

const WEEKDAYS = [
  { row: 1, label: "Mon" },
  { row: 3, label: "Wed" },
  { row: 5, label: "Fri" },
];

/** Month names over the first column of each month; one that would crowd the next (under 3 columns) is left out. */
function monthLabels(from: string, weeks: number): { col: number; label: string }[] {
  const out: { col: number; label: string }[] = [];
  let last = "";

  for (let w = 0; w < weeks; w++) {
    const sunday = new Date(parse(from) + w * 7 * DAY_MS);
    // The first column names the month of its first day; later ones the month their Sunday is in.
    const month = sunday.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

    if (month !== last) out.push({ col: w, label: month });
    last = month;
  }

  return out.filter((m, i) => !(i === 0 && (out[1]?.col ?? weeks) - m.col < 3));
}

interface Tip {
  date: string;
  /** The square's centre and top, in the box. */
  x: number;
  y: number;
}

export function Graph({ c, picked, onPick, glow }: { c: Contributions; picked: string | null; onPick: (day: string | null) => void; glow: { day: string; n: number } | null }) {
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  // The day the arrow keys move from, and whether the keyboard is driving (its day keeps the popover and the ring).
  const [focus, setFocus] = useState<string | null>(null);
  const [keys, setKeys] = useState(false);
  const first = parse(c.from);
  const last = parse(c.to);
  const total = Math.round((last - first) / DAY_MS) + 1;
  const weeks = Math.ceil(total / 7);
  const byDate = new Map(c.days.map((d) => [d.date, d]));

  // A phone shows the box's right end first: this week.
  useLayoutEffect(() => {
    const s = scroller.current;

    if (s) s.scrollLeft = s.scrollWidth;
  }, []);

  // The popover stays inside the box; its arrow points at the square.
  useLayoutEffect(() => {
    const el = tipEl.current;
    const b = box.current;

    if (!el || !b || !tip) return;
    const w = el.offsetWidth;
    const left = Math.max(4, Math.min(tip.x - w / 2, b.clientWidth - w - 4));
    el.style.left = `${left}px`;
    el.style.setProperty("--ax", `${tip.x - left}px`);
  }, [tip]);

  const show = (date: string) => {
    const cell = document.getElementById(cellId(date));
    const b = box.current;

    if (!cell || !b) return;
    const r = cell.getBoundingClientRect();
    const o = b.getBoundingClientRect();
    setTip({ date, x: r.left + r.width / 2 - o.left, y: r.top - o.top });
  };

  const move = (date: string) => {
    setFocus(date);
    setKeys(true);
    document.getElementById(cellId(date))?.scrollIntoView({ block: "nearest", inline: "nearest" });
    show(date);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = parse(focus ?? picked ?? c.to);
    const days = ARROWS.get(e.key);

    if (days !== undefined) {
      e.preventDefault();
      move(iso(Math.min(last, Math.max(first, at + days * DAY_MS))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? c.from : c.to);
    } else if ((e.key === "Enter" || e.key === " ") && focus) {
      e.preventDefault();
      onPick(focus === picked ? null : focus);
    } else if (e.key === "Escape") {
      setTip(null);
    }
  };

  const cells = Array.from({ length: total }, (_, i) => {
    const date = iso(first + i * DAY_MS);
    const d = byDate.get(date);
    const n = d?.n ?? 0;
    const step = stepOf(n, c.levels);
    const marked = date === picked || (keys && date === focus) || date === tip?.date;
    const glowing = glow?.day === date;

    return (
      <div
        key={glowing ? `${date}:${glow.n}` : date}
        id={cellId(date)}
        role="gridcell"
        aria-label={dayLabel(n, date)}
        aria-selected={date === picked}
        data-date={date}
        data-step={step}
        style={{ gridRow: (i % 7) + 2, gridColumn: Math.floor(i / 7) + 2, background: `var(--graph-${step})` }}
        className={`cursor-pointer rounded-[2px] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bark)_4%,transparent)] ${marked ? "outline-[1.5px] outline-offset-1 outline-bark outline-solid" : ""} ${glowing ? "graph-glow" : ""}`}
        onMouseEnter={() => show(date)}
        onClick={() => {
          setFocus(date);
          onPick(date === picked ? null : date);
        }}
      />
    );
  });

  const rows = Array.from({ length: 7 }, (_, dow) => (
    <div key={dow} role="row" className="contents">
      {cells.filter((_, i) => i % 7 === dow)}
    </div>
  ));

  const tipDay = tip ? byDate.get(tip.date) : undefined;

  return (
    <div ref={box} className="relative rounded-[10px] border border-rootline px-[18px] pt-4 pb-3 phone:px-3 phone:pt-3.5 phone:pb-2.5">
      <div ref={scroller} className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          role="grid"
          aria-label={`Contributions from ${longDay(c.from)} to ${longDay(c.to)}: arrow keys move between days, Enter shows a day`}
          aria-activedescendant={focus ? cellId(focus) : undefined}
          tabIndex={0}
          onKeyDown={onKey}
          onPointerDown={() => setKeys(false)}
          onFocus={(e) => {
            // Tabbed to: the popover opens on the picked day, else today. A click only focuses.
            if (e.currentTarget.matches(":focus-visible")) move(focus ?? picked ?? c.to);
          }}
          onBlur={() => {
            setFocus(null);
            setKeys(false);
            setTip(null);
          }}
          onMouseLeave={() => (keys && focus ? show(focus) : setTip(null))}
          style={{ gridTemplateColumns: `30px repeat(${weeks}, 12px)` }}
          className="grid w-max grid-rows-[15px_repeat(7,12px)] gap-[2.5px] rounded-[3px] focus-visible:outline-offset-4"
        >
          {monthLabels(c.from, weeks).map((m) => (
            <span key={m.col} aria-hidden="true" style={{ gridRow: 1, gridColumn: m.col + 2 }} className="text-[11.5px] leading-[13px] whitespace-nowrap text-ash">
              {m.label}
            </span>
          ))}
          {WEEKDAYS.map((d) => (
            <span key={d.label} aria-hidden="true" style={{ gridRow: d.row + 2, gridColumn: 1 }} className="text-[11px] leading-3 text-ash">
              {d.label}
            </span>
          ))}
          {rows}
        </div>
      </div>
      {tip ? (
        <div
          ref={tipEl}
          role="tooltip"
          style={{ top: tip.y - 8 }}
          className="pointer-events-none absolute z-10 -translate-y-full rounded-[9px] border border-rootline bg-pop px-3 pt-[9px] pb-2.5 whitespace-nowrap shadow-[0_4px_14px_var(--shadow)] after:absolute after:-bottom-1.5 after:left-(--ax) after:-ml-[5px] after:size-2.5 after:rotate-45 after:border-r after:border-b after:border-rootline after:bg-pop after:content-['']"
        >
          <b className="block text-[13.5px] font-semibold text-bark">{dayLabel(tipDay?.n ?? 0, tip.date)}</b>
          {tipDay ? <span className="mt-[3px] block text-[12.5px] text-bark-dim">{splitOf(tipDay)}</span> : null}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-3 text-[12px] text-ash">
        <a href={`${DOCS}/profiles#what-counts`} className="border-b border-ash-half pb-px hover:border-bark hover:text-bark phone:hidden">
          How contributions count
        </a>
        <span className="ml-auto flex items-center gap-1" aria-hidden="true">
          <span className="mr-1">Less</span>
          {[0, 1, 2, 3, 4].map((s) => (
            <i key={s} className="block size-[11px] rounded-[2px]" style={{ background: `var(--graph-${s})` }} />
          ))}
          <span className="ml-1">More</span>
        </span>
      </div>
    </div>
  );
}
