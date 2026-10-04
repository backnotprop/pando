// An organization's Settings, for its owners: the display name, description
// and website its page shows. Renaming and deleting an org come later.
import type { OrgProfile } from "@pando/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ORG_LIMITS, updateOrg } from "../../../api/orgs";
import { button, Empty, field, Refusal } from "../../../ui/controls";
import { useOrg } from "../../-org/frame";
import { OrgHead } from "../../-org/OrgHead";

export const Route = createFileRoute("/orgs/$org/settings")({
  component: Settings,
});

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="flex flex-col gap-2">
    <span className="text-[14px] leading-5 font-semibold">{label}</span>
    {children}
    {hint ? <span className="text-[12.5px] text-ash">{hint}</span> : null}
  </label>
);

function Details({ org }: { org: OrgProfile }) {
  const qc = useQueryClient();
  const [fields, setFields] = useState({ name: org.name ?? "", description: org.description ?? "", website: org.website ?? "" });
  const set = (key: keyof typeof fields) => (e: { target: { value: string } }) => setFields({ ...fields, [key]: e.target.value });

  const save = useMutation({
    mutationFn: () => updateOrg(org.login, { name: fields.name.trim(), description: fields.description.trim(), website: fields.website.trim() }),
    onSuccess: async (saved) => {
      qc.setQueryData(["owner", org.login], saved);
      await qc.invalidateQueries({ queryKey: ["orgs"] });
    },
  });

  return (
    <form
      className="flex max-w-[560px] flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Display name" hint={`Shown beside ${org.login} on its page. Up to ${ORG_LIMITS.name} characters.`}>
        <input className={field} value={fields.name} onChange={set("name")} placeholder={org.login} maxLength={ORG_LIMITS.name} />
      </Field>
      <Field label="Description" hint={`${fields.description.length} / ${ORG_LIMITS.description}`}>
        <input className={field} value={fields.description} onChange={set("description")} maxLength={ORG_LIMITS.description} />
      </Field>
      <Field label="Website" hint="An https address.">
        <input className={field} type="url" pattern="https://.*" value={fields.website} onChange={set("website")} placeholder="https://" maxLength={ORG_LIMITS.website} />
      </Field>
      <div className="flex items-center gap-3">
        <button type="submit" className={button("solid")} disabled={save.isPending}>
          Save
        </button>
        {save.isSuccess && !save.isPending ? <span className="text-[13px] text-bark-dim">Saved.</span> : null}
      </div>
      <Refusal error={save.error} />
    </form>
  );
}

function Settings() {
  const org = useOrg();

  return (
    <>
      <OrgHead org={org} tab="settings" />
      {org.role === "owner" ? <Details org={org} /> : <Empty>Only an owner of {org.login} can change its settings.</Empty>}
    </>
  );
}
