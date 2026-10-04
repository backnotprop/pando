// Edit profile (profile SPEC 4.3, mock `edit`): your name, bio, location and
// up to 4 links, as everyone signed in sees them on your profile. The picture
// is your sign-in's, or initials. A saved name stays when you sign in again.
// One sign-in email per person (owner ruling): no list of addresses here.
import type { Profile } from "@pando/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ownerQuery } from "../../api/orgs";
import { PROFILE_LIMITS, updateProfile } from "../../api/profile";
import { meQuery } from "../../api/queries";
import { Avatar } from "../../ui/Avatar";
import { button, field, Refusal } from "../../ui/controls";
import { ownerLink } from "../../ui/paths";
import { SettingsFrame } from "./-frame";

export const Route = createFileRoute("/settings/profile")({
  loader: async ({ context: { queryClient } }) => {
    const me = await queryClient.ensureQueryData(meQuery);

    await queryClient.ensureQueryData(ownerQuery(me.login));
  },
  component: EditProfile,
});

const Field = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <label className="flex flex-col gap-[7px]">
    <span className="text-[13px] leading-[18px] font-semibold text-bark-dim">{label}</span>
    {children}
    {hint ? <span className="text-[12.5px] text-ash">{hint}</span> : null}
  </label>
);

const input = `${field} h-[34px] w-full text-[14px]`;

/** The link fields: those saved, and one empty while there is room. */
const withRoom = (links: readonly string[]) => (links.length < PROFILE_LIMITS.links ? [...links, ""] : [...links]);

function Form({ person }: { person: Profile }) {
  const qc = useQueryClient();
  const [name, setName] = useState(person.name ?? "");
  const [bio, setBio] = useState(person.bio ?? "");
  const [location, setLocation] = useState(person.location ?? "");
  const [links, setLinks] = useState(withRoom(person.links));

  const save = useMutation({
    mutationFn: () => updateProfile({ name, bio, location, links }),
    onSuccess: (saved) => {
      qc.setQueryData(ownerQuery(saved.login).queryKey, saved);
      setLinks(withRoom(saved.links));
    },
  });

  const setLink = (i: number, v: string) => {
    const next = links.map((l, j) => (j === i ? v : l));

    setLinks(next.filter(Boolean).length === next.length ? withRoom(next) : next);
  };

  return (
    <form
      className="flex max-w-[600px] flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-[7px]">
        <span className="text-[13px] leading-[18px] font-semibold text-bark-dim">Picture</span>
        <span className="flex items-center gap-4">
          <Avatar name={person.login} picture={person.picture_url} size={64} />
          <span className="text-[13px] text-ash">{person.picture_url ? "From your sign-in" : "Initials"}</span>
        </span>
      </div>
      <Field label="Name">
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={PROFILE_LIMITS.name} placeholder={person.login} />
      </Field>
      <Field label="Bio" hint={<span className="block text-right">{`${bio.length} / ${PROFILE_LIMITS.bio}`}</span>}>
        <textarea
          className={`${field} h-auto w-full resize-none py-2 text-[14px] leading-[21px]`}
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={PROFILE_LIMITS.bio}
        />
      </Field>
      <Field label="Location">
        <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={PROFILE_LIMITS.location} placeholder="City or region" />
      </Field>
      <fieldset className="flex flex-col gap-[7px]">
        <legend className="mb-[7px] text-[13px] leading-[18px] font-semibold text-bark-dim">Links</legend>
        {links.map((l, i) => (
          <input
            key={i}
            aria-label={`Link ${i + 1}`}
            className={input}
            type="url"
            pattern="https://.*"
            value={l}
            onChange={(e) => setLink(i, e.target.value)}
            placeholder="https://"
            maxLength={PROFILE_LIMITS.link}
          />
        ))}
        <span className="text-[12.5px] text-ash">Up to {PROFILE_LIMITS.links}, each an https address.</span>
      </fieldset>
      <div className="mt-2 flex items-center gap-3 border-t border-rule-faint pt-5">
        <button type="submit" className={button("solid")} disabled={save.isPending}>
          Save profile
        </button>
        <Link {...ownerLink(person.login)} className={button("quiet")}>
          {save.isSuccess ? "Back to your profile" : "Cancel"}
        </Link>
        {save.isSuccess && !save.isPending ? <span className="text-[13px] text-bark-dim">Saved.</span> : null}
      </div>
      <Refusal error={save.error} />
    </form>
  );
}

function EditProfile() {
  const me = useSuspenseQuery(meQuery).data;
  const person = useSuspenseQuery(ownerQuery(me.login)).data;

  return (
    <SettingsFrame login={me.login} page="profile">
      <h1 className="mb-[22px] text-[24px] leading-[30px] tracking-[-.01em]">Profile</h1>
      {person.type === "user" ? <Form person={person} /> : null}
    </SettingsFrame>
  );
}
