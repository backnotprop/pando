// A recorded session's page (owner, 2026-10-05; sessions/session.html): "Session on <branch>", then who and on which
// machine, agent and model, start to end with its span, its issue, who can read it, its prompt and tool-call counts.
// The conversation, from prompt 1, is the shared conversation component's (web/src/conversation, the agents lane's).
// At the side: its commits, each with its own checks; the files in its commits; what is not shown. Its person or an
// owner deletes it: asked once, then gone at once. A deleted session's page is its stub: who deleted it, when, and the
// commits that still name it.
import { Popover } from "@base-ui/react/popover";
import type { Checks, RepoName, Session, SessionCommit } from "@pando/contract";
import { Routes } from "@pando/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { get, isMissing } from "../../../../api/client";
import { branchQuery } from "../../../../api/projects";
import { meQuery, reposQuery } from "../../../../api/queries";
import { deleteSession, sessionFilesQuery, sessionGone, sessionQuery, sessionsKey } from "../../../../api/sessions";
import { AgentMark, agentAndModel } from "../../../../ui/AgentMark";
import { Avatar } from "../../../../ui/Avatar";
import { button, Refusal } from "../../../../ui/controls";
import { NotFoundPage } from "../../../../ui/pages";
import { branchLink, codeBlobLink, commitLink, issueLink, sessionsLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { clock } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { SessionTalk } from "./Talk";
import { dayClock, sameDay, span } from "./Row";

/** "Oct 4, 09:12 to 11:22, 2 h 10 min" (the end's date only when it is another day). */
function when(s: Session): string {
  if (!s.started_at || !s.last_at) return "";

  return `${dayClock(s.started_at)} to ${sameDay(s.started_at, s.last_at) ? clock(s.last_at) : dayClock(s.last_at)}, ${span(s.started_at, s.last_at)}`;
}

const sep = <span aria-hidden="true" className="text-ash"> · </span>;

/** A commit's own checks: "ci passed · typecheck passed", or "no checks on this commit" (DETERMINISM.md row 27). */
export function CommitChecks({ repo, sha }: { repo: RepoName; sha: string }) {
  const { monorepo } = useMonorepo();

  const checks = useQuery({
    queryKey: [...sessionsKey(monorepo), "checks", repo, sha],
    queryFn: (): Promise<Checks> => {
      const route = Routes.combinedStatus(monorepo.owner, monorepo.name, repo, sha);

      return get(route.response, route.path);
    },
    staleTime: 30_000,
  }).data;

  if (!checks) return null;

  if (!checks.statuses.length) return <span className="text-ash">no checks on this commit</span>;

  return (
    <span className="text-bark-dim">
      {checks.statuses.map((s, i) => (
        <span key={s.context}>
          {i ? " · " : ""}
          <span className="font-semibold text-bark">{s.context}</span> {s.state === "success" ? "passed" : s.state === "pending" ? "running" : s.state === "failure" ? "failed" : "errored"}
        </span>
      ))}
    </span>
  );
}

function CommitList({ commits, paths }: { commits: readonly SessionCommit[]; paths: ReadonlyMap<string, string> }) {
  const { monorepo } = useMonorepo();

  return (
    <ul aria-label="Its commits" className="grid gap-3">
      {commits.map((c) => {
        const path = paths.get(c.repo);

        return (
          <li key={`${c.repo}:${c.sha}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[13px]">
            {path ? (
              <Ref kind="object" mono link={commitLink(monorepo.full, path, c.sha)}>
                {c.sha.slice(0, 7)}
              </Ref>
            ) : (
              <span className="font-mono text-[13px] text-link">{c.sha.slice(0, 7)}</span>
            )}
            <span className="text-bark">{c.title}</span>
            <span className="col-start-2 flex flex-wrap gap-x-2.5 text-[12.5px] text-ash">
              <span>{clock(c.committed_at)}</span>
              {c.on_main ? <span>on main</span> : null}
              <CommitChecks repo={c.repo} sha={c.sha} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "3 of the 6 commits on refresh-margin": its commits among the branch's own (DETERMINISM.md row 19). */
function OfBranch({ s, repo, branch, paths }: { s: Session; repo: RepoName; branch: string; paths: ReadonlyMap<string, string> }) {
  const { monorepo } = useMonorepo();
  const b = useQuery(branchQuery(monorepo, repo, branch)).data;
  const mine = s.commits.filter((c) => c.repo === repo && c.branch === branch).length;
  const path = paths.get(repo);

  if (!b || !path || b.ahead === null || !mine || b.state === "merged") return null;

  return (
    <p className="mt-3 text-[12.5px] text-ash">
      {mine} of the {b.ahead} commits on{" "}
      <Ref kind="object" mono link={branchLink(monorepo.full, path, branch)}>
        {branch}
      </Ref>
    </p>
  );
}

function Files({ id, s, paths }: { id: string; s: Session; paths: ReadonlyMap<string, string> }) {
  const { monorepo } = useMonorepo();
  const files = useQuery({ ...sessionFilesQuery(monorepo, id), enabled: s.commits.length > 0 }).data;
  const head = s.commits.at(-1)?.sha ?? null;

  if (!files?.length) return null;

  return (
    <section aria-label="Files in its commits" className="mt-8">
      <h2 className="mb-2.5 text-[13px] font-semibold text-bark-dim">
        Files in its commits <span className="font-normal text-ash">{files.length}</span>
      </h2>
      <ul className="grid gap-1.5 text-[13px]">
        {files.map((f) => (
          <li key={`${f.repo}:${f.path}`} className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {paths.get(f.repo) ? (
              <Ref kind="object" link={codeBlobLink(monorepo.full, f.repo_path, f.path, head)}>
                {f.repo_path === "." ? f.path : `${f.repo_path}/${f.path}`}
              </Ref>
            ) : (
              f.path
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotShown({ s }: { s: Session }) {
  const lines = [s.redactions ? `${s.redactions} value${s.redactions === 1 ? "" : "s"} redacted` : null, s.images ? `${s.images} image${s.images === 1 ? "" : "s"}` : null].filter((x) => x !== null);

  if (!lines.length) return null;

  return (
    <section aria-label="Not shown" className="mt-8">
      <h2 className="mb-2.5 text-[13px] font-semibold text-bark-dim">Not shown</h2>
      <ul className="grid gap-1.5 text-[13px] text-bark-dim">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

/** Delete session: one question, then gone for every member at once (no undo). */
function DeleteSession({ id, commits, person }: { id: string; commits: number; person: string }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useQuery(meQuery).data?.login ?? person;

  const go = async () => {
    setBusy(true);

    try {
      const row = await deleteSession(monorepo, id);

      await navigate(sessionsLink(monorepo.full));

      if (row.state === "deleted") sessionGone(qc, monorepo, row);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setBusy(false);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger className={`${button("quiet", 30)} text-rust`}>Delete session</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="w-[400px] rounded-[10px] border border-rootline bg-pop p-5 text-[13.5px] shadow-lg outline-none">
            <Popover.Title className="mb-1.5 text-[15px] font-semibold text-bark">Delete this session?</Popover.Title>
            <Popover.Description className="leading-5 text-bark-dim">
              Its prompts, answers and tool calls are deleted for every member, at once.
              {commits ? ` Its ${commits === 1 ? "commit stays; its row" : `${commits} commits stay; their rows`} will say "Session deleted by ${me}".` : ""}
            </Popover.Description>
            <div className="mt-4 flex justify-end gap-2">
              <Popover.Close className={button("quiet", 30)}>Cancel</Popover.Close>
              <button type="button" className={`${button("quiet", 30)} border-rust text-rust`} disabled={busy} onClick={() => void go()}>
                Delete session
              </button>
            </div>
            <Refusal error={error} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Deleted({ s, paths }: { s: Extract<NonNullable<ReturnType<typeof useSession>["data"]>, { state: "deleted" }>; paths: ReadonlyMap<string, string> }) {
  return (
    <>
      <h1 className="text-[26px] leading-8 tracking-[-.018em]">Session deleted</h1>
      <p className="mt-2 text-[14px] text-bark-dim">
        Deleted by <span className="font-semibold text-bark">{s.deleted_by}</span>, {dayClock(s.deleted_at)}. Its prompts, answers and tool calls are gone.
      </p>
      {s.commits.length ? (
        <section aria-label="Commits that name it" className="mt-8 max-w-[640px]">
          <h2 className="mb-2.5 text-[13px] font-semibold text-bark-dim">
            Commits that name it <span className="font-normal text-ash">{s.commits.length}</span>
          </h2>
          <CommitList commits={s.commits} paths={paths} />
        </section>
      ) : null}
    </>
  );
}

const useSession = (id: string) => {
  const { monorepo } = useMonorepo();

  return useQuery({ ...sessionQuery(monorepo, id), retry: (n, e) => !isMissing(e) && n < 2 });
};

export function SessionPage({ id }: { id: string }) {
  const { monorepo, info } = useMonorepo();
  const q = useSession(id);
  const me = useQuery(meQuery).data;
  const repos = useQuery(reposQuery(monorepo)).data ?? [];
  const paths = new Map(repos.map((r) => [r.name, r.path]));

  if (q.error && isMissing(q.error)) return <NotFoundPage />;

  const s = q.data;

  if (!s) return null;

  if (s.state === "deleted") return <Deleted s={s} paths={paths} />;
  const issue = s.issues[0];
  const leadPath = s.lead.repo ? paths.get(s.lead.repo) : undefined;
  const mayDelete = me?.login === s.person || info.role === "owner";

  return (
    <article data-session={s.id}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] leading-8 tracking-[-.018em]">
            {s.lead.branch ? (
              <>
                Session on{" "}
                {leadPath ? (
                  <Ref kind="object" mono link={branchLink(monorepo.full, leadPath, s.lead.branch)} className="text-[24px]">
                    {s.lead.branch}
                  </Ref>
                ) : (
                  <span className="font-mono text-[24px] text-link">{s.lead.branch}</span>
                )}
              </>
            ) : (
              "Session in the repository folder"
            )}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-1 text-[13.5px] text-bark-dim">
            <Avatar name={s.person} size={18} />
            <span className="ml-1 font-semibold text-bark">{s.person}</span> on {s.machine}
            {sep}
            <AgentMark program={s.program} />
            <span className="ml-1">{agentAndModel(s.program, s.models)}</span>
            {s.started_at ? (
              <>
                {sep}
                {s.state === "active" ? <span className="text-bark">active · </span> : null}
                {when(s)}
              </>
            ) : null}
            {issue ? (
              <>
                {sep}
                <Ref kind="object" link={issueLink(monorepo.full, issue.number)} label={`#${issue.number} ${issue.title}`}>
                  #{issue.number}
                </Ref>
              </>
            ) : null}
          </p>
          <p className="mt-1 text-[13px] text-ash">
            {s.prompts} prompt{s.prompts === 1 ? "" : "s"}
            {sep}
            {s.tool_calls} tool call{s.tool_calls === 1 ? "" : "s"}
            {s.subagents ? (
              <>
                {sep}
                {s.subagents} subagent{s.subagents === 1 ? "" : "s"}
              </>
            ) : null}
            {sep}members of {monorepo.full}
          </p>
        </div>
        {mayDelete ? <DeleteSession id={s.id} commits={s.commits.length} person={s.person} /> : null}
      </header>
      <div className="mt-8 grid grid-cols-[minmax(0,1fr)_320px] items-start gap-14 narrow:grid-cols-[minmax(0,1fr)_260px] phone:grid-cols-[minmax(0,1fr)] phone:gap-8">
        <SessionTalk s={s} mayRemove={mayDelete} />
        <aside className="min-w-0 phone:order-1">
          {s.commits.length ? (
            <section aria-label="Commits">
              <h2 className="mb-2.5 text-[13px] font-semibold text-bark-dim">
                Commits <span className="font-normal text-ash">{s.commits.length}</span>
              </h2>
              <CommitList commits={s.commits} paths={paths} />
              {s.lead.repo && s.lead.branch ? <OfBranch s={s} repo={s.lead.repo} branch={s.lead.branch} paths={paths} /> : null}
            </section>
          ) : (
            <p className="text-[13px] text-ash">No commits</p>
          )}
          <Files id={s.id} s={s} paths={paths} />
          <NotShown s={s} />
        </aside>
      </div>
    </article>
  );
}
