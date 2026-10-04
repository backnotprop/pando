// Your machines: every machine, sandbox and browser session that signs in as
// you, with Revoke; this browser's own session last. A new sandbox's
// credential is made in a terminal, so no secret is ever on screen.
import type { Credential } from "@pando/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { revokeCredential } from "../../api/actions";
import { credentialsQuery, meQuery } from "../../api/queries";
import { button, Cmd, Refusal, row, SectionHead, thead } from "../../ui/controls";
import { Page, Title } from "../../ui/pages";
import { ownerLink } from "../../ui/paths";
import { ago, since, useNow } from "../../ui/time";

export const Route = createFileRoute("/settings/machines")({
  loader: ({ context: { queryClient } }) => Promise.all([queryClient.ensureQueryData(meQuery), queryClient.ensureQueryData(credentialsQuery)]),
  component: YourMachines,
});

const cols = "grid-cols-[minmax(0,1fr)_120px_110px_90px] phone:grid-cols-[minmax(0,1fr)_auto]";

/** The lowest sandbox-N not taken, for the command's suggested name. */
function nextSandbox(credentials: readonly Credential[]): string {
  const taken = new Set(credentials.map((c) => c.name));
  let n = 1;

  while (taken.has(`sandbox-${n}`)) n++;

  return `sandbox-${n}`;
}

function Revoke({ id }: { id: string }) {
  const qc = useQueryClient();

  const revoke = useMutation({
    mutationFn: () => revokeCredential(id),
    onSettled: () => qc.invalidateQueries({ queryKey: credentialsQuery.queryKey }),
  });

  return (
    <>
      <button type="button" className={button("quiet", 28)} disabled={revoke.isPending} onClick={() => revoke.mutate()}>
        Revoke
      </button>
      <Refusal error={revoke.error} />
    </>
  );
}

function YourMachines() {
  const me = useSuspenseQuery(meQuery).data;
  const clock = useNow();
  const all = useSuspenseQuery(credentialsQuery).data;
  // This browser's own session goes last, named for what it is.
  const rows = [...all.filter((c) => c.id !== me.credential.id), me.credential];

  return (
    <Page crumbs={[{ label: me.login, link: ownerLink(me.login) }, { label: "machines" }]}>
      <div className="max-w-[880px]">
        <Title>Your machines</Title>
        <div className="mt-7">
          <div className={`${thead} ${cols}`}>
            <span>Name</span>
            <span className="phone:hidden">Kind</span>
            <span className="phone:hidden">Last used</span>
            <span />
          </div>
          <ul aria-label="Your machines">
            {rows.map((c) => {
              const here = c.id === me.credential.id;
              const used = here ? clock : c.last_used_at;

              return (
                <li key={c.id} className="border-t border-rule-faint">
                  <div className={`${row} ${cols}`}>
                    <span className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap">{here ? "this browser" : c.name}</span>
                    <span className="text-bark-dim phone:hidden">{c.kind}</span>
                    <span className="text-[12.5px] whitespace-nowrap text-ash phone:hidden">
                      {used === null ? "never" : since(used, clock) === "now" ? "now" : ago(used, clock)}
                    </span>
                    <span className="text-right">{here ? <span className="text-ash">this session</span> : <Revoke id={c.id} />}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-11">
          <SectionHead title="Add a cloud sandbox" className="mb-3" />
          <Cmd text={`pando credential create --name ${nextSandbox(all)}`} />
        </div>
      </div>
    </Page>
  );
}
