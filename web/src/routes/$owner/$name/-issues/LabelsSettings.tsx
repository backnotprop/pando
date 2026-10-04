// Labels in Settings, for owners (SPEC.md 7.6): each label's chip, its
// description and open issues, with Edit and Delete; New label opens an
// inline form with a name, a description and the eight colours. A rename or a
// delete moves on every issue at once (the server's one step).
import { type Label, LabelColor } from "@pando/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { createLabel, deleteLabel, editLabel, issuesKey, labelsKey, labelsQuery } from "../../../../api/issues";
import { button, Empty, field, lnk, Refusal, SectionHead } from "../../../../ui/controls";
import { useMonorepo } from "../-frame/heads";
import { LabelChip } from "./parts";

/** The form for a new label or an edit: name, description, a colour, and the chip as it will show. */
function LabelForm({ start, action, onDone }: { start: Label; action: string; onDone: () => void }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [label, setLabel] = useState<Label>(start);
  const editing = start.name !== "";

  const save = useMutation({
    mutationFn: () => {
      const next = { ...label, name: label.name.trim(), description: label.description?.trim() || null };

      return editing ? editLabel(monorepo, start.name, next) : createLabel(monorepo, next);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: labelsKey(monorepo) });

      // A rename or a new colour shows on every issue that has it.
      if (editing) await qc.invalidateQueries({ queryKey: issuesKey(monorepo) });
      onDone();
    },
  });

  return (
    <form
      aria-label={editing ? `Edit ${start.name}` : "New label"}
      className="mb-3.5 rounded-[10px] bg-loam p-4"
      onSubmit={(e) => {
        e.preventDefault();

        if (label.name.trim()) save.mutate();
      }}
    >
      <div className="grid grid-cols-[200px_minmax(0,1fr)_auto] items-end gap-3 phone:grid-cols-[minmax(0,1fr)]">
        <label className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-bark-dim">Name</span>
          <input autoFocus required maxLength={50} value={label.name} onChange={(e) => setLabel({ ...label, name: e.target.value })} className={`${field} h-[34px]`} />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-bark-dim">Description</span>
          <input maxLength={100} value={label.description ?? ""} onChange={(e) => setLabel({ ...label, description: e.target.value })} className={`${field} h-[34px]`} />
        </label>
        <span className="flex items-center gap-4">
          <button type="button" className={`${lnk} text-[13px]`} onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className={button("solid")} disabled={!label.name.trim() || save.isPending}>
            {action}
          </button>
        </span>
      </div>
      <div role="radiogroup" aria-label="Colour" className="mt-3.5 flex h-[34px] items-center gap-2">
        {LabelColor.literals.map((c) => {
          // SAFETY: React passes custom properties through style; CSSProperties has no index for "--" names.
          const style = { "--dot": `var(--label-${c})` } as CSSProperties;

          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={label.color === c}
              aria-label={c}
              title={c}
              style={style}
              className="size-5 cursor-pointer rounded-full bg-(--dot) aria-checked:shadow-[0_0_0_2px_var(--loam),0_0_0_3.5px_var(--bark)]"
              onClick={() => setLabel({ ...label, color: c })}
            />
          );
        })}
      </div>
      <p className="mt-2.5 flex items-center gap-2.5 text-[12.5px] text-ash">
        Preview <LabelChip label={{ ...label, name: label.name.trim() || "label" }} />
      </p>
      <Refusal error={save.error} />
    </form>
  );
}

const cols = "grid-cols-[200px_minmax(0,1fr)_90px_110px] phone:grid-cols-[minmax(0,1fr)_auto]";

export function LabelsSettings() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const labels = useQuery(labelsQuery(monorepo)).data ?? [];
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (name: string) => deleteLabel(monorepo, name),
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: labelsKey(monorepo) });
      await qc.invalidateQueries({ queryKey: issuesKey(monorepo) });
    },
  });

  return (
    <section className="mt-11" aria-label="Labels">
      <SectionHead
        title="Labels"
        count={labels.length}
        className="mb-3"
        right={
          <button type="button" className={button("quiet")} onClick={() => setMaking(true)}>
            New label
          </button>
        }
      />
      {making ? <LabelForm start={{ name: "", color: "gray", description: null }} action="Create label" onDone={() => setMaking(false)} /> : null}
      {labels.length ? (
        <ul aria-label="Labels">
          {labels.map((l) =>
            editing === l.name ? (
              <li key={l.name}>
                <LabelForm start={l} action="Save" onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={l.name} className="border-t border-rule-faint">
                <div className={`grid min-h-[50px] items-center gap-4 py-2 ${cols}`}>
                  <span className="justify-self-start">
                    <LabelChip label={l} />
                  </span>
                  <span className="text-[13.5px] text-bark-dim phone:hidden">{l.description}</span>
                  <span className="text-[13px] text-ash phone:hidden">{l.open_issues ? `${l.open_issues} open` : "none open"}</span>
                  {deleting === l.name ? (
                    <span className="flex items-center justify-end gap-3 text-[13px]">
                      <button type="button" className={`${lnk} border-rust-half text-rust`} disabled={remove.isPending} onClick={() => remove.mutate(l.name)}>
                        Delete {l.name}
                      </button>
                      <button type="button" className={lnk} onClick={() => setDeleting(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex justify-end gap-4 text-[13px]">
                      <button type="button" aria-label={`Edit ${l.name}`} className={lnk} onClick={() => setEditing(l.name)}>
                        Edit
                      </button>
                      <button type="button" aria-label={`Delete ${l.name}`} className={`${lnk} border-rust-half text-rust`} onClick={() => setDeleting(l.name)}>
                        Delete
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      ) : (
        <Empty>No labels yet.</Empty>
      )}
      <Refusal error={remove.error} />
    </section>
  );
}
