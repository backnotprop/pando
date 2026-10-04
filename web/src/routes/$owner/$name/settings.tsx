// Settings, for owners: the name (Rename; the old name keeps leading here),
// and Delete, which you type the full owner/name to enable (ruling).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { deleteMonorepo, rename } from "../../../api/actions";
import { button, Empty, field, Refusal, SectionHead } from "../../../ui/controls";
import { OwnHead, useMonorepo } from "./-frame/heads";

export const Route = createFileRoute("/$owner/$name/settings")({
  component: Settings,
});

function Rename() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState<string>(monorepo.name);

  const move = useMutation({
    mutationFn: () => rename(monorepo, name.trim().toLowerCase()),
    onSuccess: async (to) => {
      await qc.invalidateQueries({ queryKey: ["monorepos"] });
      await navigate({ to: "/$owner/$name/settings", params: { owner: to.owner, name: to.name } });
    },
  });

  return (
    <section>
      <SectionHead title="Name" className="mb-3" />
      <form
        className="flex items-center gap-2.5 phone:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();

          if (name.trim().toLowerCase() !== monorepo.name) move.mutate();
        }}
      >
        <span className="inline-flex h-[34px] items-center rounded-lg border border-rootline px-3 text-[13px] text-ash">{monorepo.owner}/</span>
        <input className={`${field} w-[220px]`} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className={button("quiet")} disabled={move.isPending}>
          Rename
        </button>
      </form>
      <Refusal error={move.error} />
    </section>
  );
}

function Delete() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const hint = `Type ${monorepo.full} to delete`;

  const remove = useMutation({
    mutationFn: () => deleteMonorepo(monorepo),
    onSuccess: async () => {
      await navigate({ to: "/" });
      qc.removeQueries({ queryKey: ["m", monorepo.owner, monorepo.name] });
      await qc.invalidateQueries({ queryKey: ["monorepos"] });
      await qc.invalidateQueries({ queryKey: ["activity"] });
      await qc.invalidateQueries({ queryKey: ["needs"] });
    },
  });

  return (
    <section className="mt-11">
      <SectionHead title="Delete this repository" className="mb-3" />
      <form
        className="flex items-center gap-2.5 phone:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();

          if (typed === monorepo.full) remove.mutate();
        }}
      >
        <input className={`${field} w-[280px] phone:w-full`} placeholder={hint} aria-label={hint} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button type="submit" className={button("danger")} disabled={typed !== monorepo.full || remove.isPending}>
          Delete {monorepo.full}
        </button>
      </form>
      <Refusal error={remove.error} />
    </section>
  );
}

function Settings() {
  const { monorepo, info } = useMonorepo();

  return (
    <>
      <OwnHead tab="settings" />
      <div className="max-w-[880px]">
        {info.role === "owner" ? (
          <>
            <Rename />
            <Delete />
          </>
        ) : (
          <Empty>Only an owner can rename or delete {monorepo.full}.</Empty>
        )}
      </div>
    </>
  );
}
