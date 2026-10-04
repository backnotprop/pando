// A quiet picker (the prototype's menu, on Base UI's Popover): a heading, a
// box to find a row when the list is long, and rows with a check beside the
// chosen ones. One choice applies at once; with several (labels, assignees)
// the choice applies when the picker closes, as one change (SPEC.md 7.3).
import { Popover } from "@base-ui/react/popover";
import { type ReactNode, useState } from "react";
import { CheckIcon } from "../../../../ui/Icons";

export interface PickOption {
  id: string;
  /** What the find box matches. */
  text: string;
  /** How the row shows (the text when omitted). */
  node?: ReactNode;
  /** A quiet line under it. */
  hint?: string;
}

const row =
  "flex min-h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13.5px] text-bark-dim outline-none hover:bg-pop-hi hover:text-bark focus-visible:bg-pop-hi aria-pressed:text-bark";

export function Picker({
  label,
  heading,
  trigger,
  triggerClass,
  options,
  selected,
  multi = false,
  findAt = 8,
  align = "end",
  onDone,
}: {
  /** The trigger's name for assistive technology (and the tests). */
  label: string;
  heading: string;
  trigger: ReactNode;
  triggerClass: string;
  options: readonly PickOption[];
  selected: readonly string[];
  multi?: boolean;
  /** Past this many rows the picker has a find box. */
  findAt?: number;
  align?: "start" | "end";
  onDone: (chosen: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>(selected);
  const shown = options.filter((o) => o.text.toLowerCase().includes(find.trim().toLowerCase()));

  const toggle = (next: boolean) => {
    if (next) {
      setChosen(selected);
      setFind("");
    } else if (multi && (chosen.length !== selected.length || chosen.some((c) => !selected.includes(c)))) {
      onDone(chosen);
    }

    setOpen(next);
  };

  const pick = (id: string) => {
    if (!multi) {
      setOpen(false);

      if (!selected.includes(id) || selected.length !== 1) onDone([id]);

      return;
    }

    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };

  return (
    <Popover.Root open={open} onOpenChange={toggle}>
      <Popover.Trigger aria-label={label} className={triggerClass}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={6} className="z-10">
          <Popover.Popup className="max-h-[min(420px,var(--available-height))] w-[290px] origin-(--transform-origin) overflow-y-auto rounded-[10px] border border-rootline bg-pop p-1.5 shadow-pop outline-none transition-[opacity,scale] duration-150 ease-pando data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-opacity">
            <div className="px-2.5 pt-2 pb-1.5 text-[12px] text-ash">{heading}</div>
            {options.length > findAt ? (
              <div className="px-1 pt-1 pb-2">
                <input
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  placeholder={`Filter ${heading.toLowerCase()}`}
                  aria-label={`Filter ${heading.toLowerCase()}`}
                  autoComplete="off"
                  className="h-[30px] w-full min-w-0 rounded-[7px] border border-rootline bg-air px-3 text-[13px] text-bark placeholder:text-ash focus:border-ash focus:outline-none"
                />
              </div>
            ) : null}
            <div role="group" aria-label={heading}>
              {shown.map((o) => {
                const on = (multi ? chosen : selected).includes(o.id);

                return (
                  <button key={o.id} type="button" aria-pressed={on} className={row} onClick={() => pick(o.id)}>
                    <span className="w-3.5 flex-none">{on ? <CheckIcon className="size-3.5 text-bark" /> : null}</span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">{o.node ?? o.text}</span>
                      {o.hint ? <span className="text-[12px] text-ash">{o.hint}</span> : null}
                    </span>
                  </button>
                );
              })}
              {shown.length ? null : <p className="px-2.5 py-1.5 text-[13px] text-ash">Nothing matches.</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
