// An organization's People (mock `org-people`): everyone in it with their
// role and when they were last active. Owners add people (an email: at once
// if they have an account, else at their first sign-in; a login: at once),
// change roles and remove people; anyone leaves from their own row. An org
// keeps at least one owner, and the page says so in plain words when a
// change would leave it without one.
import { type Invite, Login, type OrgInviteResult, type OrgMember, type OrgProfile } from "@pando/contract";
import { type QueryClient, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { inviteToOrg, isLastOwner, orgInvitesQuery, orgMembersQuery, ownerQuery, putOrgMember, removeOrgMember, revokeOrgInvite } from "../../../api/orgs";
import { meQuery } from "../../../api/queries";
import { Avatar } from "../../../ui/Avatar";
import { button, Empty, field, row, SectionHead, thead } from "../../../ui/controls";
import { Select } from "../../../ui/dropdown";
import { ago, since, useNow } from "../../../ui/time";
import { useOrg } from "../../-org/frame";
import { OrgHead } from "../../-org/OrgHead";

export const Route = createFileRoute("/orgs/$org/people")({
  loader: async ({ context: { queryClient, org } }) => {
    const who = await queryClient.ensureQueryData(ownerQuery(org));

    if (who.type === "org" && who.role) await Promise.all([queryClient.ensureQueryData(orgMembersQuery(org)), queryClient.ensureQueryData(orgInvitesQuery(org))]);
  },
  component: People,
});

type Role = "member" | "owner";

// On a phone: the person, their role and the row's action (Active drops out).
const cols = "grid-cols-[minmax(0,1fr)_170px_110px_110px] phone:grid-cols-[minmax(0,1fr)_96px_80px]";

const lastSeen = (at: string | null, clock: number) => (at === null ? "never" : since(at, clock) === "now" ? "now" : ago(at, clock));

const byRole = (a: OrgMember, b: OrgMember) => Number(b.role === "owner") - Number(a.role === "owner") || a.login.localeCompare(b.login);

const parseLogin = Schema.decodeUnknownResult(Login);

/** A change to the org's people: its lists, its head (count, your role), your orgs, and the Members tabs of its repositories. */
function refresh(qc: QueryClient, org: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["org", org] }),
    qc.invalidateQueries({ queryKey: ["owner", org] }),
    qc.invalidateQueries({ queryKey: ["orgs"] }),
    qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "m" && q.queryKey[1] === org && q.queryKey[3] === "members" }),
  ]);
}

/** A refusal under its row or form, in Rust; the last-owner rule in the org's own words. */
function Problem({ error, org, lastOwner }: { error: Error | null; org: string; lastOwner: string }) {
  if (!error) return null;

  return (
    <p role="alert" className="pb-2 text-[13px] text-rust">
      {isLastOwner(error) ? lastOwner.replace("{org}", org) : error.message}
    </p>
  );
}

function Person({ org, member, you }: { org: OrgProfile; member: OrgMember; you: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clock = useNow();
  const owner = org.role === "owner";

  const remove = useMutation({
    mutationFn: () => removeOrgMember(org.login, member.login),
    onSuccess: async () => {
      if (!you) return;
      // Leaving: its repositories go from your list, and its pages are no longer yours to see.
      await navigate({ to: "/" });
      await qc.invalidateQueries({ queryKey: ["monorepos"] });
      await qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onSettled: () => refresh(qc, org.login),
  });

  const role = useMutation({ mutationFn: (to: Role) => putOrgMember(org.login, member.login, to), onSettled: () => refresh(qc, org.login) });
  const action = you ? "Leave" : "Remove";

  return (
    <li className="border-t border-rule-faint">
      <div className={`${row} ${cols} min-h-[60px]`}>
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={member.login} size={28} />
          <span className="flex min-w-0 flex-col gap-0.5 *:overflow-hidden *:text-ellipsis *:whitespace-nowrap">
            <span>{member.name ?? member.login}</span>
            <span className="text-[12.5px] text-ash">{member.login}</span>
          </span>
        </span>
        <span className="text-bark-dim">
          {owner ? (
            <Select label={`Role of ${member.login}`} size="small" value={role.isPending ? role.variables : member.role} onChange={(v) => role.mutate(v === "owner" ? "owner" : "member")}>
              <option>member</option>
              <option>owner</option>
            </Select>
          ) : (
            member.role
          )}
        </span>
        <span className="text-[13px] whitespace-nowrap text-ash phone:hidden">{lastSeen(member.last_active_at, clock)}</span>
        <span className="text-right">
          {you || owner ? (
            <button type="button" aria-label={you ? `Leave ${org.login}` : `Remove ${member.login}`} className={button("quiet", 30)} disabled={remove.isPending} onClick={() => remove.mutate()}>
              {action}
            </button>
          ) : null}
        </span>
      </div>
      <Problem error={role.error} org={org.login} lastOwner="{org} needs an owner. Make someone else an owner first." />
      <Problem error={remove.error} org={org.login} lastOwner="You are the only owner of {org}. Make someone else an owner before you leave." />
    </li>
  );
}

/** What the last add did, in a line. */
function added(r: OrgInviteResult, org: string): string {
  return r.status === "added" ? `${r.member.name ?? r.member.login} is in ${org} now.` : `${r.invite.email} is invited, and joins ${org} at their first sign-in.`;
}

function AddPerson({ org }: { org: OrgProfile }) {
  const qc = useQueryClient();
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Role>("member");

  const send = useMutation({
    mutationFn: async (): Promise<OrgInviteResult> => {
      const text = who.trim();

      if (text.includes("@")) return inviteToOrg(org.login, text, role);
      const login = parseLogin(text.toLowerCase());

      if (Result.isFailure(login)) throw new Error("Type an email, or a person's login.");

      return { status: "added", member: await putOrgMember(org.login, login.success, role) };
    },
    onSuccess: () => setWho(""),
    onSettled: () => refresh(qc, org.login),
  });

  return (
    <div className="mt-9">
      <SectionHead title="Invite" className="mb-3" />
      <form
        className="flex items-center gap-2.5 phone:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <input className={`${field} w-[320px] phone:w-full`} required placeholder="Email or login" aria-label="Email or login" value={who} onChange={(e) => setWho(e.target.value)} />
        <Select label="Role" value={role} onChange={(v) => setRole(v === "owner" ? "owner" : "member")}>
          <option>member</option>
          <option>owner</option>
        </Select>
        <button type="submit" className={button("solid")} disabled={send.isPending}>
          Invite
        </button>
      </form>
      {send.data && !send.isPending ? <p className="mt-2 text-[13px] text-bark-dim">{added(send.data, org.login)}</p> : null}
      {send.error ? <p className="mt-2 text-[13px] text-rust">{send.error.message}</p> : null}
    </div>
  );
}

function Revoke({ org, email }: { org: Login; email: string }) {
  const qc = useQueryClient();
  const revoke = useMutation({ mutationFn: () => revokeOrgInvite(org, email), onSettled: () => refresh(qc, org) });

  return (
    <button type="button" aria-label={`Revoke the invite for ${email}`} className={button("quiet", 30)} disabled={revoke.isPending} onClick={() => revoke.mutate()}>
      Revoke
    </button>
  );
}

function Invited({ org, invites }: { org: OrgProfile; invites: readonly Invite[] }) {
  const clock = useNow();

  return (
    <div className="mt-9">
      <SectionHead title="Invited" count={invites.length} className="mb-1" />
      <ul aria-label="Invited">
        {invites.map((i) => (
          <li key={i.email} className="border-t border-rule-faint first:border-t-0">
            <div className={`${row} ${cols} min-h-[60px]`}>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{i.email}</span>
              <span className="text-bark-dim">{i.role}</span>
              <span className="text-[13px] whitespace-nowrap text-ash phone:hidden">{ago(i.created_at, clock)}</span>
              <span className="text-right">{org.role === "owner" ? <Revoke org={org.login} email={i.email} /> : null}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function List({ org }: { org: OrgProfile }) {
  const me = useSuspenseQuery(meQuery).data;
  const people = [...useSuspenseQuery(orgMembersQuery(org.login)).data].sort(byRole);
  const invites = useQuery(orgInvitesQuery(org.login)).data ?? [];

  return (
    <div className="max-w-[880px]">
      <div className={`${thead} ${cols}`}>
        <span>Person</span>
        <span>Role</span>
        <span className="phone:hidden">Active</span>
        <span />
      </div>
      <ul aria-label={`People in ${org.login}`}>
        {people.map((m) => (
          <Person key={m.login} org={org} member={m} you={m.login === me.login} />
        ))}
      </ul>
      {org.role === "owner" ? <AddPerson org={org} /> : null}
      {invites.length ? <Invited org={org} invites={invites} /> : null}
    </div>
  );
}

function People() {
  const org = useOrg();

  return (
    <>
      <OrgHead org={org} tab="people" />
      {org.role ? <List org={org} /> : <Empty>Only people in {org.login} can see who is in it.</Empty>}
    </>
  );
}
