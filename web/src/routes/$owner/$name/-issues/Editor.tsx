// The editor (owner ruling): a plain text box with Write and Preview, as
// GitHub's; Preview through Plannotator's viewer. The raw Markdown is what
// is saved. Cmd or Ctrl and Enter does the form's main action.
import { type ReactNode, useState } from "react";
import { Markdown } from "./Markdown";

const tab = "h-7 cursor-pointer rounded-md px-2.5 text-[13px] leading-7 text-ash hover:text-bark aria-selected:bg-(--editor-bg) aria-selected:text-bark aria-selected:shadow-[inset_0_0_0_1px_var(--rootline)]";

export function Editor({
  label,
  value,
  onChange,
  full,
  placeholder,
  tall = false,
  ground = "soil",
  onSubmit,
  footer,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  /** The monorepo, for `#12` links in Preview. */
  full: string;
  placeholder: string;
  /** New issue's box (280 px); a comment's is 110 px. */
  tall?: boolean;
  ground?: "soil" | "air";
  onSubmit?: () => void;
  footer?: ReactNode;
}) {
  const [preview, setPreview] = useState(false);
  const bg = ground === "air" ? "bg-air [--editor-bg:var(--air)]" : "bg-soil [--editor-bg:var(--soil)]";

  return (
    <div className={`rounded-[10px] border border-rootline ${bg}`}>
      <div role="tablist" aria-label={label} className="flex h-[42px] items-center gap-1 rounded-t-[10px] border-b border-rule-faint bg-loam px-2.5">
        <button type="button" role="tab" aria-selected={!preview} className={tab} onClick={() => setPreview(false)}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={preview} className={tab} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className={`px-5 pt-4 pb-1 ${tall ? "min-h-[280px]" : "min-h-[110px]"}`}>
          {value.trim() ? <Markdown text={value} full={full} /> : <p className="pb-3 text-[14px] text-ash">Nothing to preview.</p>}
        </div>
      ) : (
        <textarea
          aria-label={label}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className={`block w-full resize-none bg-transparent [field-sizing:content] px-[18px] py-3.5 text-[14.5px] leading-[23px] text-bark placeholder:text-ash focus:outline-none ${tall ? "min-h-[280px]" : "min-h-[110px]"}`}
        />
      )}
      {footer ? <div className="flex items-center justify-end gap-2.5 px-3 pb-3 phone:flex-wrap">{footer}</div> : null}
    </div>
  );
}
