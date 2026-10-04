// Members: the people in a monorepo (or a plain repo), their role and when
// they were last active; an owner invites by email and removes people. A
// person who already has an account joins at once; anyone else is invited
// and listed until they sign up.
import type { Invite, Member } from "@pando/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { invite, removeMember, revokeInvite } from "../../../api/actions";
import { invitesQuery, meQuery, membersQuery } from "../../../api/queries";
import { Avatar } from "../../../ui/Avatar";
import { button, field, Refusal, row, SectionHead, thead } from "../../../ui/controls";
import { Select } from "../../../ui/dropdown";
import { ago, since, useNow } from "../../../ui/time";
import { OwnHead, useMonorepo } from "./-frame/heads";

export const Route = createFileRoute("/$owner/$name/members")({
  loader: ({ context: { queryClient, monorepo } }) => Promise.all([queryClient.ensureQueryData(membersQuery(monorepo)), queryClient.ensureQueryData(invitesQuery(monorepo))]),
  component: Members,
});

// On a phone: the person and their role (the prototype's rule).
const cols = "grid-cols-[minmax(0,1fr)_120px_110px_80px] phone:grid-cols-[minmax(0,1fr)_80px]";

const lastSeen = (at: string | null, clock: number) => (at === null ? "never" : since(at, clock) === "now" ? "now" : ago(at, clock));

/** Members and invites change together (an invite to someone with an account adds them). */
function useRefresh() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();

  return () => Promise.all([qc.invalidateQueries({ queryKey: membersQuery(monorepo).queryKey }), qc.invalidateQueries({ queryKey: invitesQuery(monorepo).queryKey })]);
}

function Remove({ member }: { member: Member }) {
  const { monorepo } = useMonorepo();
  const refresh = useRefresh();
  const remove = useMutation({ mutationFn: () => removeMember(monorepo, member.login), onSettled: refresh });

  return (
    <>
      <button type="button" aria-label={`Remove ${member.login}`} className={button("quiet")} disabled={remove.isPending} onClick={() => remove.mutate()}>
        Remove
      </button>
      <Refusal error={remove.error} />
    </>
  );
}

function People({ owner }: { owner: boolean }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const me = useSuspenseQuery(meQuery).data;
  // Owners first, then by login.
  const members = [...useSuspenseQuery(membersQuery(monorepo)).data].sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.login.localeCompare(b.login));

  return (
    <div>
      <div className={`${thead} ${cols}`}>
        <span>Person</span>
        <span>Role</span>
        <span className="phone:hidden">Active</span>
        <span className="phone:hidden" />
      </div>
      <ul aria-label="Members">
        {members.map((m) => (
          <li key={m.login} className="border-t border-rule-faint">
            <div className={`${row} ${cols}`}>
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={m.login} size={28} />
                <span className="flex min-w-0 flex-col gap-0.5 *:overflow-hidden *:text-ellipsis *:whitespace-nowrap">
                  <span>{m.name ?? m.login}</span>
                  <span className="text-[13px] text-ash">{m.login}</span>
                </span>
              </span>
              <span className="text-bark-dim">{m.role}</span>
              <span className="text-[12.5px] whitespace-nowrap text-ash phone:hidden">{lastSeen(m.last_active_at, clock)}</span>
              <span className="text-right phone:hidden">{m.login === me.login ? <span className="text-ash">you</span> : owner ? <Remove member={m} /> : null}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InviteForm() {
  const { monorepo } = useMonorepo();
  const refresh = useRefresh();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");

  const send = useMutation({
    mutationFn: () => invite(monorepo, email.trim(), role),
    onSuccess: () => setEmail(""),
    onSettled: refresh,
  });

  return (
    <div className="mt-11">
      <SectionHead title="Invite" className="mb-3" />
      <form
        className="flex items-center gap-2.5 phone:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <input
          className={`${field} w-[300px] phone:w-full`}
          type="email"
          required
          placeholder="name@example.com"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select label="Role" value={role} onChange={(v) => setRole(v === "owner" ? "owner" : "member")}>
          <option>member</option>
          <option>owner</option>
        </Select>
        <button type="submit" className={button("solid")} disabled={send.isPending}>
          Invite
        </button>
      </form>
      <Refusal error={send.error} />
    </div>
  );
}

function RevokeInvite({ email }: { email: string }) {
  const { monorepo } = useMonorepo();
  const refresh = useRefresh();
  const revoke = useMutation({ mutationFn: () => revokeInvite(monorepo, email), onSettled: refresh });

  return (
    <>
      <button type="button" aria-label={`Revoke the invite for ${email}`} className={button("quiet")} disabled={revoke.isPending} onClick={() => revoke.mutate()}>
        Revoke
      </button>
      <Refusal error={revoke.error} />
    </>
  );
}

function Invited({ invites, owner }: { invites: readonly Invite[]; owner: boolean }) {
  const clock = useNow();

  return (
    <div className="mt-11">
      <SectionHead title="Invited" count={invites.length} className="mb-3" />
      <ul aria-label="Invited">
        {invites.map((i) => (
          <li key={i.email} className="border-t border-rule-faint">
            <div className={`${row} ${cols}`}>
              <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap">{i.email}</span>
              <span className="text-bark-dim">{i.role}</span>
              <span className="text-[12.5px] whitespace-nowrap text-ash phone:hidden">{ago(i.created_at, clock)}</span>
              <span className="text-right phone:hidden">{owner ? <RevokeInvite email={i.email} /> : null}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Members() {
  const { monorepo, info } = useMonorepo();
  const invites = useSuspenseQuery(invitesQuery(monorepo)).data;
  const owner = info.role === "owner";

  return (
    <>
      <OwnHead tab="members" />
      <div className="max-w-[880px]">
        <People owner={owner} />
        {owner ? <InviteForm /> : null}
        {invites.length ? <Invited invites={invites} owner={owner} /> : null}
      </div>
    </>
  );
}
