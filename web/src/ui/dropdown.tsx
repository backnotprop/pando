// Every dropdown's arrow, in one place so none drifts from the prototype's:
// Pierre's chevron, centred on the trigger's line, at the size and inset each
// kind of trigger has in v3/prototype.html. Native selects draw no arrow of
// their own (the browser's sits against the border); they take the same
// chevron, 8 px inside the border, as the home filter's.
import type { ChangeEvent, ReactNode } from "react";
import { Chevron } from "./Icons";

/**
 * The arrow of a dropdown trigger. `box` (the default) is 14 px, after the
 * trigger's own padding (the home filter, the branch picker); `button` is
 * 13 px with 6 px before it (Clone, the prototype's .btn .chev); `switch` is
 * the breadcrumb switchers' 10 by 14 (the prototype's button kept the
 * browser's 6 px side padding, which narrows the chevron).
 */
export function Caret({ kind = "box" }: { kind?: "box" | "button" | "switch" }) {
  const size = kind === "button" ? "ml-1.5 size-[13px]" : kind === "switch" ? "h-3.5 w-2.5" : "size-3.5";

  return <Chevron data-caret="" className={`block flex-none ${size}`} />;
}

/** The fields a native select is drawn with: the form field's (32 px) and the Clone panel's smaller one (28 px). */
const SELECT = {
  field: "h-8 rounded-[7px] border border-rootline bg-air pr-7 pl-3 text-[13.5px] text-bark",
  small: "h-7 rounded-[7px] border border-rootline bg-air pr-[26px] pl-2 text-[12.5px] leading-[15px] text-bark",
};

/**
 * A native select (the keyboard, the phone's own picker), its arrow the
 * prototype's chevron: 14 px, centred, 9 px from the outer edge (1 px border
 * and 8 px, as the home filter's). Its options are paths and names, so SF Pro
 * Text (owner ruling on mono use, variant C). `wide` fills its row.
 */
export function Select({
  label,
  value,
  onChange,
  children,
  size = "field",
  wide = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  size?: keyof typeof SELECT;
  wide?: boolean;
}) {
  return (
    <span className={`relative min-w-0 ${wide ? "flex w-full" : "inline-flex"}`}>
      <select
        aria-label={label}
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        className={`min-w-0 cursor-pointer appearance-none focus:border-ash focus:outline-none ${SELECT[size]} ${wide ? "w-full" : ""}`}
      >
        {children}
      </select>
      <Chevron aria-hidden="true" data-caret="" className="pointer-events-none absolute top-1/2 right-[9px] block size-3.5 -translate-y-1/2 text-bark-dim" />
    </span>
  );
}
