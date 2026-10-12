// A branch's Artifacts tab (SPEC.md 8): the documents uploaded to its page,
// newest first (kind, title and name, version and size, open comments, who
// uploaded the newest version and from where), Add at the top and a drop zone
// under the list; the Merge box and the rest of Overview's right column stay
// beside it. With `?artifact=<name>` the tab is that artifact's page instead.
import type { Artifact, Branch, Repo } from "@pando/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { artifactListQuery } from "../../../../api/artifacts";
import { Cmd, Empty } from "../../../../ui/controls";
import { ChatIcon } from "../../../../ui/Icons";
import { type ArtifactAt, branchArtifactsLink } from "../../../../ui/paths";
import { clock } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { AddButton, AddDialog, DropZone, useAdding } from "./Add";
import { ArtifactPage } from "./ArtifactPage";
import { fromWhere, KindIcon, sizeOf } from "./parts";

function commentsWord(a: Artifact) {
  const { open, resolved } = a.comments;

  if (!open && !resolved) return "No comments";

  return [open ? `${open} open` : null, resolved ? `${resolved} resolved` : null].filter(Boolean).join(", ");
}

function Rows({ repo, b, artifacts }: { repo: Repo; b: Branch; artifacts: readonly Artifact[] }) {
  const { monorepo } = useMonorepo();

  return (
    <ul aria-label="Artifacts" className="overflow-hidden rounded-[10px] border border-rootline">
      {artifacts.map((a) => (
        <li
          key={a.id}
          className="grid grid-cols-[16px_minmax(0,1fr)_170px_auto] items-start gap-x-4 gap-y-1 border-t border-rootline px-4 py-3.5 first:border-t-0 phone:grid-cols-[16px_minmax(0,1fr)]"
        >
          <span className="pt-0.5 text-bark-dim">
            <KindIcon kind={a.kind} />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <Link {...branchArtifactsLink(monorepo.full, repo.path, b.name, { artifact: a.name })} className="truncate text-[14px] text-link hover:underline">
                {a.title ?? a.name}
              </Link>
              {a.title ? <span className="truncate text-[13px] text-ash">{a.name}</span> : null}
            </span>
            <span className="mt-1 block text-[12.5px] text-ash">
              v{a.latest.n} · {sizeOf(a.latest)}
            </span>
          </span>
          <span className="flex items-center gap-2 pt-0.5 text-[13px] text-bark-dim phone:col-start-2">
            {a.comments.open || a.comments.resolved ? <ChatIcon className="size-4 flex-none" /> : null}
            {commentsWord(a)}
          </span>
          <span className="pt-0.5 text-right text-[13px] whitespace-nowrap text-ash phone:col-start-2 phone:text-left">
            <span className="font-semibold text-bark-dim">{a.latest.uploaded_by}</span> {fromWhere(a.latest)} {clock(a.latest.created_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function List({ repo, b, aside }: { repo: Repo; b: Branch; aside: ReactNode }) {
  const { monorepo } = useMonorepo();
  const list = useQuery(artifactListQuery(monorepo, repo.name, b.name));
  const adding = useAdding();
  const artifacts = list.data?.artifacts ?? [];

  let body: ReactNode;

  if (list.isError) body = <Empty>The artifacts could not be read.</Empty>;
  else if (!list.data) body = null;
  else if (!artifacts.length) {
    body = (
      <div className="mt-9 grid gap-4 phone:mt-0">
        <DropZone adding={adding} empty>
          <AddButton adding={adding} big />
        </DropZone>
        <div className="min-w-0">
          <Cmd text={`pando artifact add ${b.name} plan.md`} />
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="mb-4 flex justify-end">
          <AddButton adding={adding} />
        </div>
        <Rows repo={repo} b={b} artifacts={artifacts} />
        <DropZone adding={adding} />
      </>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-16 narrow:grid-cols-[minmax(0,1fr)] narrow:gap-10">
      <section aria-label="Artifacts">
        {body}
        <AddDialog repo={repo} b={b} adding={adding} existing={artifacts} />
      </section>
      {aside}
    </div>
  );
}

export function ArtifactsTab({ repo, b, at, aside }: { repo: Repo; b: Branch; at: ArtifactAt; aside: ReactNode }) {
  if (at.artifact) return <ArtifactPage repo={repo} b={b} name={at.artifact} at={at} />;

  return <List repo={repo} b={b} aside={aside} />;
}
