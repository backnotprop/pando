// A commit's page, like GitHub's /commit/{sha}: its title and message, its
// author (their picture when the email is a Pando person's) and committed
// time, the branch it came from or the branch it merges, Copy sha and its
// parents; on the right its checks with their CI service's mark; then the
// files it changed against its first parent, in Files changed's read-only
// view (FilesChanged.tsx). The address takes a full sha or the start of one.
import type { CommitPage as CommitAnswer, Repo } from "@pando/contract";
import { type QueryClient, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { isMissing } from "../../../../api/client";
import type { MonorepoRef } from "../../../../api/names";
import { commitDiffQuery, commitQuery } from "../../../../api/projects";
import { rereadRuns, useRows } from "../../../../live/rows";
import { Avatar } from "../../../../ui/Avatar";
import { CopyButton, Lnk, SectionHead } from "../../../../ui/controls";
import { Title } from "../../../../ui/pages";
import { branchLink, commitLink, ownerLink, repoLink } from "../../../../ui/paths";
import { Ref } from "../../../../ui/Ref";
import { ago, dayAndTime, useNow } from "../../../../ui/time";
import { loadColourViews } from "../-code/coloured";
import { tool } from "../-code/FileView";
import { useMonorepo } from "../-frame/heads";
import { firstFiles } from "./Branch";
import { CheckRows } from "./Checks";
import { FilesChanged } from "./FilesChanged";

/** The commit, then its diff's first screen of files (the rest stream in); an unknown sha is the page's not found. */
export async function loadCommit(qc: QueryClient, m: MonorepoRef, repo: Repo, ref: string) {
  void loadColourViews();

  const page = await qc.ensureQueryData(commitQuery(m, repo.name, ref)).catch((error: Error) => {
    if (isMissing(error)) throw notFound();

    throw error;
  });

  const diff = commitDiffQuery(m, repo.name, page.commit.sha);

  await firstFiles(qc, diff.queryKey, qc.prefetchQuery(diff));
}

const short = (sha: string) => sha.slice(0, 7);

/** "Ana Lima and Bo committed 3 minutes ago": the author (their page and picture when Pando knows them), any co-authors, the committed time. */
function Byline({ page }: { page: CommitAnswer }) {
  const clock = useNow();
  const c = page.commit;
  const name = c.author.name ?? c.author.email ?? "someone";
  const person = page.author_person;
  const co = c.co_authors.map((a) => a.name);
  const at = c.committer.date ?? c.author.date;

  return (
    <p className="mt-4 flex items-center gap-2 text-[14px] text-bark-dim">
      <Avatar name={person?.login ?? name} picture={person?.picture_url ?? null} size={20} />
      <span className="min-w-0">
        {person ? (
          <Ref kind="person" link={ownerLink(person.login)}>
            {name}
          </Ref>
        ) : (
          <span className="font-semibold text-bark">{name}</span>
        )}
        {co.length ? ` and ${co.join(", ")}` : ""}
        {at ? (
          <>
            {" "}
            <span title={dayAndTime(at, clock)}>committed {ago(at, clock)}</span>
          </>
        ) : null}
      </span>
    </p>
  );
}

/** Where it came from: the branch it was pushed on (and its merge), or the branch it merges into main. */
function Origin({ repo, page }: { repo: Repo; page: CommitAnswer }) {
  const { monorepo } = useMonorepo();

  const branchRef = (name: string, state: string) =>
    state === "deleted" ? (
      <code className="text-[13px] text-bark">{name}</code>
    ) : (
      <Ref kind="object" mono text link={branchLink(monorepo.full, repo.path, name)}>
        {name}
      </Ref>
    );

  if (page.merge_of) return <p className="mt-2 text-[14px] text-bark-dim">Merge of {branchRef(page.merge_of.name, page.merge_of.state)} into main.</p>;

  const b = page.branch;

  if (!b) return null;
  const merged = b.merge_commit && b.merge_commit !== page.commit.sha ? b.merge_commit : null;

  return (
    <p className="mt-2 text-[14px] text-bark-dim">
      On {branchRef(b.name, b.state)}
      {b.state === "deleted" ? " (deleted)" : ""}
      {merged ? (
        <>
          , merged into main in{" "}
          <Ref kind="object" mono text link={commitLink(monorepo.full, repo.path, merged)}>
            {short(merged)}
          </Ref>
        </>
      ) : null}
      .
    </p>
  );
}

/** The full sha with Copy sha, and its parents, each opening its own page. */
function Ids({ repo, page }: { repo: Repo; page: CommitAnswer }) {
  const { monorepo } = useMonorepo();
  const { sha, parents } = page.commit;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ash">
      <span className="flex min-w-0 items-center gap-2.5">
        <code className="min-w-0 overflow-hidden font-mono text-[13px] text-ellipsis text-bark-dim">{sha}</code>
        <CopyButton text={sha} label="Copy sha" className={tool} />
      </span>
      <span>
        {parents.length ? `${parents.length === 1 ? "Parent" : "Parents"} ` : "No parent: the first commit"}
        {parents.map((p, i) => (
          <span key={p}>
            {i ? ", " : ""}
            <Ref kind="object" mono link={commitLink(monorepo.full, repo.path, p)}>
              {short(p)}
            </Ref>
          </span>
        ))}
      </span>
    </div>
  );
}

/** The diff, as soon as its start has come; why there is none if it failed. */
function Files({ repo, sha }: { repo: Repo; sha: string }) {
  const { monorepo } = useMonorepo();
  const diff = useQuery(commitDiffQuery(monorepo, repo.name, sha));
  const start = diff.data?.start;

  if (diff.isError) return <p className="py-2.5 text-[13.5px] text-ash">The files changed could not be read.</p>;

  if (!diff.data || !start) return null;
  const ends = { after: start.sha, before: start.parent, files_total: start.files_total, too_many_files: start.too_many_files };

  return <FilesChanged repo={repo} what="commit" diff={diff.data} ends={ends} reading={diff.isFetching} readAgain={() => void diff.refetch()} />;
}

export function CommitPage({ repo, sha: ref }: { repo: Repo; sha: string }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const query = commitQuery(monorepo, repo.name, ref);

  // Its checks come live: a status on it reads the page again (live/rows.ts), its CI jobs patch their runs; all read once more when the socket opens.
  const live = useRows(monorepo, [`repo:${repo.name}`], () => {
    void qc.invalidateQueries({ queryKey: query.queryKey, exact: true });
    // Its runs too, keeping any job or build frame that lands while they are read.
    void rereadRuns(qc, monorepo, repo.name);
  });

  const page = useSuspenseQuery(query).data;
  const c = page.commit;
  const body = c.message.slice(c.title.length).trim();
  const total = useQuery(commitDiffQuery(monorepo, repo.name, c.sha)).data?.start?.files_total;

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-8">
        <div className="min-w-0">
          <Title>{c.title || "(no message)"}</Title>
          {body ? <p className="mt-3 max-w-[46em] text-[14px] leading-[21px] whitespace-pre-wrap text-bark-dim">{body}</p> : null}
          <Byline page={page} />
          <Origin repo={repo} page={page} />
          <Ids repo={repo} page={page} />
        </div>
        <aside aria-label="Checks">
          <SectionHead title="Checks" />
          <CheckRows repo={repo} sha={c.sha} checks={page.checks} live={live} />
        </aside>
      </div>
      <div className="mt-10">
        <SectionHead title="Files changed" count={total} />
        <Files repo={repo} sha={c.sha} />
      </div>
    </>
  );
}

/** An address with no such commit: says so (and when the start of a sha names more than one), with the way back to the code. */
export function NoCommit({ repo, sha }: { repo: Repo | undefined; sha: string }) {
  const { monorepo } = useMonorepo();
  const where = !repo || repo.path === "." ? monorepo.full : repo.path;
  const qc = useQueryClient();
  const why = repo ? qc.getQueryState(commitQuery(monorepo, repo.name, sha).queryKey)?.error?.message : undefined;

  return (
    <>
      <Title>
        No commit <code className="font-mono text-[0.85em]">{sha}</code> in {where}.
      </Title>
      <p className="mt-2 text-[14px] text-bark-dim">{why?.startsWith("more than one") ? "More than one commit starts with it: give more of its sha." : "A commit opens by its full sha, or its first 7 characters or more."}</p>
      {repo ? (
        <p className="mt-3 text-[14px] text-bark-dim">
          <Lnk {...repoLink(monorepo.full, repo.path)}>Back to the code</Lnk>
        </p>
      ) : null}
    </>
  );
}
