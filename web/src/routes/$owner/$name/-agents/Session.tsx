// An agent session's page (the mocks accepted 2026-10-05): the leaf and "Agent
// #9 on <its branch>", Stop for the person who started it (or an owner); its
// state, who started it as which machine, the program and model, when it
// started and its issue; then the conversation, live, with the message box
// fixed under it for the person who started it and no box for anyone else.
// On the right: the branch's commits, its files changed, and the sandbox
// (where its files are, and the tokens spent).
import type { AgentMessage, AgentSession, Repo } from "@pando/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentModelsQuery, agentQuery, agentsKey, sendAgent, stopAgent } from "../../../../api/agents";
import { branchDiffQuery, commitsQuery } from "../../../../api/projects";
import { reposQuery } from "../../../../api/queries";
import { Composer } from "../../../../conversation/Composer";
import { Conversation } from "../../../../conversation/Conversation";
import { fromAgent } from "../../../../conversation/fromAgent";
import { Thread, useShownFromEnd } from "../../../../conversation/Thread";
import { useAgentMessages } from "../../../../live/agent";
import { fallback, useRows } from "../../../../live/rows";
import { Avatar } from "../../../../ui/Avatar";
import { button, SectionHead } from "../../../../ui/controls";
import { Leaf } from "../../../../ui/Leaf";
import { branchLink, issueLink, ownerLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, dayAndTime, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { useMe } from "../-issues/parts";
import { leafOf, StateWords } from "./parts";

const count = new Intl.NumberFormat("en-US");

/** The tokens a session's answers spent, as the model's provider counted them. */
function tokens(messages: readonly AgentMessage[]) {
  const t = { input: 0, cached: 0, output: 0 };

  for (const m of messages) {
    t.input += m.usage?.input ?? 0;
    t.cached += m.usage?.cache_read ?? 0;
    t.output += m.usage?.output ?? 0;
  }

  return t;
}

function Side({ s, repo, messages }: { s: AgentSession; repo: Repo | undefined; messages: readonly AgentMessage[] }) {
  const { monorepo } = useMonorepo();
  const branch = s.branch;
  const on = Boolean(repo && branch);
  // SAFETY: with no project or no branch both reads are disabled, so the empty names are never sent.
  const repoName = repo?.name ?? ("" as Repo["name"]);
  const commits = useQuery({ ...commitsQuery(monorepo, repoName, branch ?? ""), enabled: on, retry: false }).data;
  const files = useQuery({ ...branchDiffQuery(monorepo, repoName, branch ?? ""), enabled: on, retry: false }).data?.files ?? [];
  const t = tokens(messages);
  const row = "grid grid-cols-[110px_minmax(0,1fr)] gap-3 text-[13.5px]";

  return (
    <aside className="grid content-start gap-9 narrow:hidden">
      {commits ? (
        <section>
          <SectionHead title="Commits" count={commits.total} />
          <ul className="grid gap-2">
            {commits.commits.slice(0, 8).map((c) => (
              <li key={c.sha} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-[13px]">
                <code className="font-mono text-[12.5px] text-link">{c.sha.slice(0, 7)}</code>
                <span className="truncate text-bark">{c.title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {files.length ? (
        <section>
          <SectionHead title="Files changed" count={files.length} />
          <ul className="grid gap-1.5">
            {files.slice(0, 12).map((f) => (
              <li key={f.path} className="flex min-w-0 items-baseline gap-2 text-[13px]">
                <span className="truncate text-link">{f.path}</span>
                {f.additions === null ? null : (
                  <span className="text-[12px] whitespace-nowrap text-ash">
                    +{f.additions} −{f.deletions ?? 0}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <SectionHead title="Sandbox" />
        <div className="grid gap-2.5">
          {s.workspace ? (
            <p className={row}>
              <span className="text-ash">Workspace</span>
              <span className="text-bark">{s.workspace === "mount" ? "the branch, mounted" : "a clone of the branch"}</span>
            </p>
          ) : null}
          <p className={row}>
            <span className="text-ash">Tokens in</span>
            <span className="text-bark">
              {count.format(t.input)}
              {t.cached ? ` (${count.format(t.cached)} cached)` : ""}
            </span>
          </p>
          <p className={row}>
            <span className="text-ash">Tokens out</span>
            <span className="text-bark">{count.format(t.output)}</span>
          </p>
        </div>
      </section>
    </aside>
  );
}

export function AgentSessionPage({ n }: { n: number }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const me = useMe();
  const clock = useNow();
  const live = useRows(monorepo, [`agent:${n}`], () => void qc.invalidateQueries({ queryKey: agentQuery(monorepo, n).queryKey }));
  const s = useQuery({ ...agentQuery(monorepo, n), refetchInterval: fallback(live) }).data;
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const models = useQuery(agentModelsQuery(monorepo)).data ?? [];
  const messages = useAgentMessages(monorepo, n) ?? [];
  const model = models.find((x) => x.id === s?.model)?.name ?? s?.model ?? "";
  const items = s ? fromAgent(messages, { person: s.launched_by, program: "Pi", model, working: s.status === "working" }) : [];
  const { shown, older } = useShownFromEnd(items);

  if (!s) return null;

  const repo = repos.find((r) => r.name === s.repo);
  const l = leafOf(s);
  const prompts = items.filter((i) => i.kind === "prompt").length;
  const steps = items.filter((i) => i.kind === "step").length;
  const mine = s.launched_by === me;
  const running = s.status === "working" || s.status === "waiting";

  const stop = async () => {
    qc.setQueryData(agentQuery(monorepo, n).queryKey, await stopAgent(monorepo, n));
    void qc.invalidateQueries({ queryKey: agentsKey(monorepo) });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-16 narrow:grid-cols-[minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex items-start gap-4">
          <h1 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[26px] leading-8 tracking-[-.018em] phone:text-[21px]">
            <Leaf state={l.state} tone={l.tone} size={32} label={s.status} />
            <span>
              Agent <span className="text-ash">#{s.number}</span>
              {s.branch ? " on" : ""}
            </span>
            {s.branch ? (
              <Ref kind="object" link={branchLink(monorepo.full, repo?.path ?? ".", s.branch)} mono className="font-mono text-[24px] phone:text-[18px]">
                {s.branch}
              </Ref>
            ) : null}
          </h1>
          {running && mine ? (
            <button type="button" className={`${button("quiet")} ml-auto text-rust`} onClick={() => void stop()}>
              Stop
            </button>
          ) : null}
        </div>
        <p className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[14px] text-bark-dim">
          <span className="rounded-[14px] bg-loam px-3 py-1 text-[13px] font-semibold">
            <StateWords s={s} me={me} />
          </span>
          <Avatar name={s.launched_by} size={18} />
          <Ref kind="person" link={ownerLink(s.launched_by)}>
            {s.launched_by}
          </Ref>
          <span>on {s.machine}</span>
          <span className="text-ash">·</span>
          <span>Pi, {model}</span>
          <span className="text-ash">·</span>
          <span title={s.created_at}>started {dayAndTime(s.created_at, clock, true)}, last activity {ago(s.updated_at, clock)}</span>
          {s.issue === null ? null : (
            <>
              <span className="text-ash">·</span>
              <Ref kind="object" link={issueLink(monorepo.full, s.issue)}>
                #{s.issue}
              </Ref>
            </>
          )}
        </p>
        <p className="mt-1.5 text-[13.5px] text-ash">
          {prompts} prompt{prompts === 1 ? "" : "s"} · {steps} step{steps === 1 ? "" : "s"}
        </p>
        <div className="mt-6 h-[calc(100dvh-330px)] min-h-[420px] phone:h-[calc(100dvh-260px)]">
          <Thread items={shown} older={older} dock={mine ? <Composer placeholder="Message the agent" hint={s.status === "working" ? "Taken after the current step" : "Acts as you"} send={async (text) => void (await sendAgent(monorepo, n, text))} /> : undefined}>
            <Conversation items={shown} full={monorepo.full} />
          </Thread>
        </div>
      </div>
      <Side s={s} repo={repo} messages={messages} />
    </div>
  );
}
