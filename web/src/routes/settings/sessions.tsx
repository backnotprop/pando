// Your settings, Sessions (owner, 2026-10-04: Settings holds only the switches; sessions/settings-sessions.html):
// whether each machine records, as it last reported; what you do not record, on every machine (the repository's own
// rules in .pando/pando.toml are its, not listed here); data folders a machine found beyond the usual places; and
// Delete sessions by repository, project and age, asked once, then at once.
import { Popover } from "@base-ui/react/popover";
import type { MonorepoSummary } from "@pando/contract";
import { Routes } from "@pando/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { get } from "../../api/client";
import { monorepoRef } from "../../api/names";
import { meQuery, monoreposQuery, reposQuery } from "../../api/queries";
import { deleteMany, sessionExclusionsQuery, sessionMachinesQuery, setExclusions } from "../../api/sessions";
import { AgentMark } from "../../ui/AgentMark";
import { button, Cmd, Refusal, row, SectionHead, thead } from "../../ui/controls";
import { Select } from "../../ui/dropdown";
import { Title } from "../../ui/pages";
import { monoLink, personSessionsLink } from "../../ui/paths";
import { Ref } from "../../ui/Ref";
import { ago, useNow } from "../../ui/time";
import { SettingsFrame } from "./-frame";

export const Route = createFileRoute("/settings/sessions")({
  loader: ({ context: { queryClient } }) => Promise.all([queryClient.ensureQueryData(meQuery), queryClient.ensureQueryData(monoreposQuery)]),
  component: SessionSettings,
});

const AGES = [
  { days: undefined, label: "Any age" },
  { days: 7, label: "Older than 7 days" },
  { days: 30, label: "Older than 30 days" },
  { days: 90, label: "Older than 90 days" },
] as const;

function Recording() {
  const clock = useNow();
  const machines = useQuery(sessionMachinesQuery).data ?? [];
  const cols = "grid-cols-[minmax(0,1fr)_120px_220px] phone:grid-cols-[minmax(0,1fr)_auto]";

  return (
    <section aria-label="Recording" className="mt-9">
      <SectionHead title="Recording" />
      {machines.length ? (
        <>
          <div className={`${thead} ${cols} border-b border-rule-faint`}>
            <span>Machine</span>
            <span className="phone:hidden">Kind</span>
            <span>As the machine last reported</span>
          </div>
          <ul>
            {machines.map((m) => (
              <li key={m.credential_id} className={`${row} ${cols} border-b border-rule-faint text-[14px]`}>
                <span className="min-w-0 overflow-hidden text-ellipsis text-bark">{m.machine}</span>
                <span className="text-bark-dim phone:hidden">{m.kind === "machine" ? "laptop" : m.kind}</span>
                <span className="text-[13.5px] text-ash">
                  <span className={m.recording ? "text-bark" : ""}>{m.recording ? "On" : "Off"}</span> · reported {ago(m.updated_at, clock)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-[13.5px] text-ash">No machine has reported yet.</p>
      )}
      <div className="mt-4">
        <Cmd text="pando session enable" />
      </div>
    </section>
  );
}

function NotRecorded({ mine }: { mine: readonly MonorepoSummary[] }) {
  const qc = useQueryClient();
  const list = useQuery(sessionExclusionsQuery).data ?? [];
  const [adding, setAdding] = useState(false);
  const [mono, setMono] = useState<string>(mine[0]?.full_name ?? "");
  const [project, setProject] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const picked = mine.find((m) => m.full_name === mono);
  const repos = useQuery({ ...reposQuery(monorepoRef(picked?.owner ?? "x", picked?.name ?? "x")), enabled: Boolean(picked && picked.kind === "monorepo") }).data ?? [];

  const save = async (next: { monorepo: string; project: string | null }[]) => {
    try {
      await setExclusions(next);
      await qc.invalidateQueries({ queryKey: sessionExclusionsQuery.queryKey });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  };

  const current = list.map((x) => ({ monorepo: x.monorepo, project: x.project }));

  return (
    <section aria-label="Not recorded" className="mt-11">
      <SectionHead title="Not recorded" />
      {list.length ? (
        <ul className="border-t border-rule-faint">
          {list.map((x) => (
            <li key={`${x.monorepo}:${x.project ?? ""}`} className={`${row} grid-cols-[minmax(0,1fr)_160px_auto] border-b border-rule-faint text-[14px]`}>
              <span className="min-w-0">
                <Ref kind="object" link={monoLink(x.monorepo)}>
                  {x.monorepo}
                </Ref>
                {x.project ? <span className="ml-1.5 text-bark-dim">{x.project}</span> : null}
              </span>
              <span className="text-bark-dim">{x.project ? "One project" : "Whole repository"}</span>
              <button type="button" className={button("quiet", 30)} onClick={() => void save(current.filter((c) => !(c.monorepo === x.monorepo && c.project === x.project)))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13.5px] text-ash">Every repository you belong to is recorded.</p>
      )}
      {adding ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Select label="Repository" value={mono} onChange={(v) => { setMono(v); setProject(""); }}>
            {mine.map((m) => (
              <option key={m.full_name} value={m.full_name}>
                {m.full_name}
              </option>
            ))}
          </Select>
          {repos.length ? (
            <Select label="Project" value={project} onChange={setProject}>
              <option value="">Whole repository</option>
              {repos.filter((r) => r.path !== ".").map((r) => (
                <option key={r.path} value={r.path}>
                  {r.path}
                </option>
              ))}
            </Select>
          ) : null}
          <button
            type="button"
            className={button("solid", 32)}
            disabled={!mono}
            onClick={() => {
              void save([...current, { monorepo: mono, project: project || null }]);
              setAdding(false);
            }}
          >
            Add
          </button>
          <button type="button" className={button("quiet", 32)} onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={`${button("quiet", 32)} mt-4`} onClick={() => setAdding(true)}>
          Add a repository or project
        </button>
      )}
      <Refusal error={error} />
    </section>
  );
}

function DataFolders() {
  const clock = useNow();
  const machines = useQuery(sessionMachinesQuery).data ?? [];
  const folders = machines.flatMap((m) => m.stores.filter((s) => s.found !== "default").map((s) => ({ ...s, machine: m.machine, at: m.updated_at })));

  return (
    <section aria-label="Data folders" className="mt-11">
      <SectionHead title="Data folders" />
      {folders.length ? (
        <ul className="border-t border-rule-faint">
          {folders.map((f) => (
            <li key={`${f.machine}:${f.program}:${f.path}`} className={`${row} grid-cols-[minmax(0,1fr)_auto] border-b border-rule-faint`}>
              <span className="flex min-w-0 items-center gap-2 font-mono text-[13px] text-bark">
                <AgentMark program={f.program} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.path}</span>
              </span>
              <span className="text-[13px] text-ash">
                {f.machine}, {f.found}, reported {ago(f.at, clock)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13.5px] text-ash">Only the usual places.</p>
      )}
      <div className="mt-4">
        <Cmd text="pando session paths add <folder> --program <name>" />
      </div>
    </section>
  );
}

function DeleteSessions({ mine, me }: { mine: readonly MonorepoSummary[]; me: string }) {
  const qc = useQueryClient();
  const [mono, setMono] = useState<string>(mine[0]?.full_name ?? "");
  const [project, setProject] = useState("");
  const [age, setAge] = useState("30");
  const [error, setError] = useState<Error | null>(null);
  const picked = mine.find((m) => m.full_name === mono);
  const ref = monorepoRef(picked?.owner ?? "x", picked?.name ?? "x");
  const repos = useQuery({ ...reposQuery(ref), enabled: Boolean(picked && picked.kind === "monorepo") }).data ?? [];
  const repoName = repos.find((r) => r.path === project)?.name;
  const days = age ? Number(age) : undefined;
  const filters = { person: me, ...(repoName ? { repo: repoName } : {}), ...(days === undefined ? {} : { olderThanDays: days }), limit: 1 };

  const count = useQuery({
    queryKey: ["m", ref.owner, ref.name, "sessions", "count", filters],
    queryFn: () => {
      const route = Routes.listSessions(ref.owner, ref.name, filters);

      return get(route.response, route.path).then((r) => r.counts.active + r.counts.inactive);
    },
    enabled: Boolean(picked),
  }).data;

  const go = async () => {
    try {
      await deleteMany(ref, { ...(repoName ? { repo: repoName } : {}), ...(days === undefined ? {} : { olderThanDays: days }) });
      await qc.invalidateQueries({ queryKey: ["m", ref.owner, ref.name, "sessions"] });
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  };

  return (
    <section aria-label="Delete sessions" className="mt-11">
      <SectionHead title="Delete sessions" />
      <div className="flex flex-wrap items-center gap-2">
        <Select label="Repository" value={mono} onChange={(v) => { setMono(v); setProject(""); }}>
          {mine.map((m) => (
            <option key={m.full_name} value={m.full_name}>
              {m.full_name}
            </option>
          ))}
        </Select>
        {repos.length > 1 ? (
          <Select label="Project" value={project} onChange={setProject}>
            <option value="">All projects</option>
            {repos.filter((r) => r.path !== ".").map((r) => (
              <option key={r.path} value={r.path}>
                {r.path}
              </option>
            ))}
          </Select>
        ) : null}
        <Select label="Age" value={age} onChange={setAge}>
          {AGES.map((a) => (
            <option key={a.label} value={a.days === undefined ? "" : String(a.days)}>
              {a.label}
            </option>
          ))}
        </Select>
        <Popover.Root>
          <Popover.Trigger className={`${button("quiet", 32)} border-rust text-rust`} disabled={!count}>
            Delete {count ?? ""} session{count === 1 ? "" : "s"}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={8}>
              <Popover.Popup className="w-[380px] rounded-[10px] border border-rootline bg-pop p-5 text-[13.5px] shadow-lg outline-none">
                <Popover.Title className="mb-1.5 text-[15px] font-semibold text-bark">
                  Delete {count} session{count === 1 ? "" : "s"}?
                </Popover.Title>
                <Popover.Description className="leading-5 text-bark-dim">Your sessions there are deleted for every member, at once. Their commits stay.</Popover.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <Popover.Close className={button("quiet", 30)}>Cancel</Popover.Close>
                  <Popover.Close className={`${button("quiet", 30)} border-rust text-rust`} onClick={() => void go()}>
                    Delete
                  </Popover.Close>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <Refusal error={error} />
    </section>
  );
}

function SessionSettings() {
  const me = useSuspenseQuery(meQuery).data;
  const mine = useSuspenseQuery(monoreposQuery).data;

  return (
    <SettingsFrame login={me.login} page="sessions">
      <Title>Sessions</Title>
      <p className="mt-2 text-[14px] text-bark-dim">
        Your sessions are on{" "}
        <Ref kind="object" text link={personSessionsLink(me.login)}>
          your profile
        </Ref>
        .
      </p>
      <Recording />
      <NotRecorded mine={mine} />
      <DataFolders />
      {mine.length ? <DeleteSessions mine={mine} me={me.login} /> : null}
    </SettingsFrame>
  );
}
