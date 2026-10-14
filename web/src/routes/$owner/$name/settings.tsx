// Settings, for owners: the name (Rename; the old name keeps leading here),
// its one-line description (shown under its name), who can download releases, the issue labels, Transfer to an org you are in or to yourself (mock
// `transfer`; the old address keeps leading here too), and Delete, which you
// type the full owner/name to enable (ruling).
import type { Login } from "@pando/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { deleteMonorepo, describe, rename } from "../../../api/actions";
import { myOrgsQuery, transfer } from "../../../api/orgs";
import { meQuery, monorepoQuery } from "../../../api/queries";
import { Avatar } from "../../../ui/Avatar";
import { button, Empty, field, Lnk, Refusal, SectionHead } from "../../../ui/controls";
import { Select } from "../../../ui/dropdown";
import { OwnHead, useMonorepo } from "./-frame/heads";
import { LabelsSettings } from "./-issues/LabelsSettings";
import { Mirror } from "./-settings/Mirror";
import { ReleasesSwitch } from "./-settings/Releases";
import { RiskReviewSettings } from "./-settings/RiskReview";

export const Route = createFileRoute("/$owner/$name/settings")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(myOrgsQuery),
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

/** The one line under its name, in its rows and its header (at most 160 characters; empty clears it). */
function Description() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const saved = useSuspenseQuery(monorepoQuery(monorepo)).data.description ?? "";
  const [text, setText] = useState<string>(saved);

  const save = useMutation({
    mutationFn: () => describe(monorepo, text),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: monorepoQuery(monorepo).queryKey, exact: true }), qc.invalidateQueries({ queryKey: ["monorepos"] })]),
  });

  return (
    <section className="mt-11">
      <SectionHead title="Description" className="mb-3" />
      <form
        className="flex items-center gap-2.5 phone:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <input className={`${field} w-[520px] phone:w-full`} aria-label="Description" maxLength={160} value={text} onChange={(e) => setText(e.target.value)} placeholder="One line about this repository" />
        <button type="submit" className={button("quiet")} disabled={save.isPending || text.trim() === saved}>
          Save
        </button>
        {save.isSuccess && text.trim() === saved ? <span className="text-[13px] text-bark-dim">Saved.</span> : null}
      </form>
      <Refusal error={save.error} />
    </section>
  );
}

/** The new owner: an org you are in, or you (the server lets a monorepo come back to a person only if they own it themselves). */
function Transfer() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useSuspenseQuery(meQuery).data;
  const orgs = useSuspenseQuery(myOrgsQuery).data;
  const targets = [me.login, ...orgs.map((o) => o.login)].filter((o) => o !== monorepo.owner);
  const [picked, setPicked] = useState<string>("");
  const to = targets.find((t) => t === picked) ?? targets[0] ?? null;
  const [typed, setTyped] = useState("");
  const hint = `Type ${monorepo.full} to transfer`;

  const move = useMutation({
    mutationFn: (owner: Login) => transfer(monorepo, owner),
    onSuccess: async (moved) => {
      await qc.invalidateQueries({ queryKey: ["monorepos"] });
      await navigate({ to: "/$owner/$name/settings", params: { owner: moved.owner, name: moved.name } });
    },
  });

  return (
    <section className="mt-11">
      <SectionHead title="Transfer" className="mb-3" />
      {to ? (
        <>
          <form
            className="flex items-center gap-2.5 phone:flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();

              if (typed === monorepo.full) move.mutate(to);
            }}
          >
            <Select label="New owner" value={to} onChange={setPicked} lead={<Avatar name={to} org={to !== me.login} size={18} />}>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <input className={`${field} w-[280px] phone:w-full`} placeholder={hint} aria-label={hint} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button type="submit" className={button("solid")} disabled={typed !== monorepo.full || move.isPending}>
              Transfer
            </button>
          </form>
          <p className="mt-3 text-[13.5px] text-bark-dim">
            <span className="text-bark">{monorepo.full}</span> will be <span className="text-bark">{`${to}/${monorepo.name}`}</span>. The old address keeps working.
          </p>
          <Refusal error={move.error} />
        </>
      ) : (
        <Empty>
          You are in no organization to move it into. <Lnk to="/orgs/new">New organization</Lnk>
        </Empty>
      )}
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
            <Description />
            <ReleasesSwitch />
            <RiskReviewSettings />
            <Mirror />
            <LabelsSettings />
            <Transfer />
            <Delete />
          </>
        ) : (
          <Empty>Only an owner can rename or delete {monorepo.full}.</Empty>
        )}
      </div>
    </>
  );
}
