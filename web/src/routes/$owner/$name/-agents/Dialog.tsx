// The frame every agent dialog shares (New agent, Address with agent, Review
// with agent): a leaf and the title, the fields, the model as the server lists
// them, a refusal, then "Acts as you", Cancel and Start.
import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { agentModelsQuery } from "../../../../api/agents";
import { button, Refusal } from "../../../../ui/controls";
import { Select } from "../../../../ui/dropdown";
import { Leaf } from "../../../../ui/Leaf";
import { useMonorepo } from "../-frame/heads";

export const fieldLabel = "grid gap-1.5 text-[13px]";

/** The model chosen in a dialog: the person's pick, else the server's first. Read only while the dialog is open. */
export function useModel(open: boolean) {
  const { monorepo } = useMonorepo();
  const models = useQuery({ ...agentModelsQuery(monorepo), enabled: open }).data ?? [];
  const [chosen, setModel] = useState<string | null>(null);

  return { model: chosen ?? models[0]?.id ?? null, models, setModel };
}

export function ModelField({ pick }: { pick: ReturnType<typeof useModel> }) {
  return (
    <label className={fieldLabel}>
      <span className="font-semibold text-bark">Model</span>
      <Select label="Model" value={pick.model ?? ""} wide onChange={pick.setModel}>
        {pick.models.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function AgentDialog({ open, onClose, title, ready, error, onStart, children }: { open: boolean; onClose: () => void; title: ReactNode; ready: boolean; error: Error | null; onStart: () => void; children: ReactNode }) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-10 bg-[color-mix(in_srgb,var(--soil)_72%,transparent)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[112px] left-1/2 z-10 w-[560px] max-w-[calc(100%-32px)] -translate-x-1/2 rounded-xl border border-rootline bg-pop px-[22px] pt-5 pb-5 shadow-pop outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 phone:top-6">
          <form
            className="grid gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();

              if (ready) onStart();
            }}
          >
            <Dialog.Title className="flex items-center gap-2.5 text-[16px] font-semibold">
              <Leaf state="idle" size={20} />
              {title}
            </Dialog.Title>
            {children}
            <Refusal error={error} />
            <div className="mt-1.5 flex items-center justify-end gap-2.5">
              <span className="mr-auto text-[12.5px] text-ash">Acts as you</span>
              <button type="button" className={button("quiet")} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className={button("solid")} disabled={!ready}>
                Start
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
