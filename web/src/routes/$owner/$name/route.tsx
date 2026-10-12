// A monorepo's frame: it finds the monorepo, draws the breadcrumb from the
// address, and keeps the monorepo's own socket open while one of its pages is.
// When that socket says you no longer have access (removed, or out of its
// org), the page gives way to a plain message. Each page draws its own head
// (-frame/heads.tsx).
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, Outlet, redirect, useMatches } from "@tanstack/react-router";
import { Assistant } from "./-agents/Assistant";
import { useEffect, useState } from "react";
import { isMissing } from "../../../api/client";
import { monorepoRef } from "../../../api/names";
import { monorepoQuery } from "../../../api/queries";
import { startMonorepoFeed } from "../../../live/monorepo";
import { Lnk } from "../../../ui/controls";
import { Page, Title } from "../../../ui/pages";
import { agentsLink, blobLink, ciPipelineLink, codeBlobLink, codeLink, issuesLink, ownerLink, sessionsLink, tabLink, treeLink } from "../../../ui/paths";
import type { Crumb } from "../../../ui/TopBar";

export const Route = createFileRoute("/$owner/$name")({
  beforeLoad: ({ params }) => {
    try {
      return { monorepo: monorepoRef(params.owner, params.name) };
    } catch {
      throw notFound();
    }
  },
  loader: async ({ context: { queryClient, monorepo }, location }) => {
    const info = await queryClient.ensureQueryData(monorepoQuery(monorepo)).catch((error: Error) => {
      if (isMissing(error)) throw notFound();

      throw error;
    });

    // An old name (a rename keeps it as an alias) leads to the same page under the current one.
    if (info.full_name !== monorepo.full) {
      const rest = location.pathname.split("/").slice(3).join("/");

      throw redirect({ href: `/${info.full_name}${rest ? `/${rest}` : ""}${location.searchStr}`, replace: true });
    }

    return info;
  },
  component: MonorepoFrame,
});

/** Folder crumbs for a path, each opening its folder; the last one is the page. */
function pathCrumbs(parts: string[], folder: (dir: string) => Crumb["link"], lastLink?: Crumb["link"]): Crumb[] {
  return parts.map((p, i) =>
    i === parts.length - 1 ? { label: p, link: lastLink } : { label: p, link: folder(parts.slice(0, i + 1).join("/")), wide: true },
  );
}

/** The breadcrumb after owner / name, read from the address: `rest` is the path after /{owner}/{name}. */
function crumbsFor(full: string, plain: boolean, rest: string[]): Crumb[] {
  const [kind = "", ...parts] = rest;
  const repoPath = plain ? "." : `projects/${parts[0] ?? ""}`;

  // agents / #9
  if (kind === "agents" && parts[0]) return [{ label: "agents", link: agentsLink(full), wide: true }, { label: `#${parts[0]}` }];

  // issues / #34, issues / new
  if (kind === "issues" && parts[0]) return [{ label: "issues", link: issuesLink(full), wide: true }, { label: parts[0] === "new" ? "new" : `#${parts[0]}` }];

  if (kind === "projects" && !plain) {
    const [, sub = "", ...path] = parts;
    const deeper = sub === "branches" ? [{ label: path.length ? path.join("/") : "branches" }] : sub === "commit" ? commitCrumb(path) : codeCrumbs(full, repoPath, sub, path);
    // On a phone the project crumb drops out whenever a deeper crumb follows, so the breadcrumb never overlaps.
    const project: Crumb = { label: repoPath, link: deeper.length ? codeLink(full, repoPath, "") : undefined, project: repoPath, wide: deeper.length > 0 };

    return [project, ...deeper];
  }

  if (plain && kind === "branches") return parts.length ? [{ label: parts.join("/") }] : [{ label: "branches" }];

  if (plain && kind === "commit") return commitCrumb(parts);

  if (plain) return codeCrumbs(full, ".", kind, parts);

  if (kind === "tree" || kind === "blob") return pathCrumbs(parts, (dir) => treeLink(full, dir));

  if (kind === "history") return [...pathCrumbs(parts, (dir) => treeLink(full, dir), blobLink(full, parts.join("/"))), { label: "history" }];

  // ci / pando-ci / #1285
  if (kind === "ci" && parts.length) {
    const [pipeline = "", number] = parts;
    const ci: Crumb = { label: "ci", link: tabLink(full, "ci"), wide: true };

    return number ? [ci, { label: pipeline, link: ciPipelineLink(full, pipeline), wide: true }, { label: `#${number}` }] : [ci, { label: pipeline }];
  }

  // sessions / session
  if (kind === "sessions" && parts.length) return [{ label: "sessions", link: sessionsLink(full) }, { label: "session" }];

  return kind ? [{ label: kind }] : [];
}

/** A commit's page: "commit 94cf890". */
const commitCrumb = ([sha = ""]: string[]): Crumb[] => [{ label: `commit ${sha.slice(0, 7)}` }];

/** A repo's code pages: folders, a file, a file's history. */
function codeCrumbs(full: string, repoPath: string, kind: string, path: string[]): Crumb[] {
  const folder = (dir: string) => codeLink(full, repoPath, dir);

  if (kind === "history") return [...pathCrumbs(path, folder, codeBlobLink(full, repoPath, path.join("/"), null)), { label: "history" }];

  if (kind === "tree" || kind === "blob") return pathCrumbs(path, folder);

  return [];
}

function MonorepoFrame() {
  const { monorepo } = Route.useRouteContext();
  const info = Route.useLoaderData();
  // The breadcrumb follows the page on screen (its rendered match), not the address being loaded: while a link's page
  // is read, the old page stays, and so does its breadcrumb.
  const pathname = useMatches({ select: (matches) => matches.at(-1)?.pathname ?? "" });
  const queryClient = useQueryClient();

  const { owner, name } = monorepo;
  // The monorepo whose socket said you no longer have access (this frame stays mounted across monorepos).
  const [lostFull, setLostFull] = useState<string | null>(null);

  // One socket per monorepo, kept across its pages (the context object is new on each navigation).
  useEffect(() => {
    const ref = monorepoRef(owner, name);

    return startMonorepoFeed(queryClient, ref, () => {
      setLostFull(ref.full);
      void queryClient.invalidateQueries({ queryKey: ["monorepos"] });
    });
  }, [queryClient, owner, name]);

  const rest = pathname
    .split("/")
    .slice(3)
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

  const crumbs: Crumb[] = [
    { label: monorepo.owner, link: ownerLink(monorepo.owner), wide: true },
    { label: monorepo.name, monorepo: monorepo.full },
    ...crumbsFor(monorepo.full, info.kind === "repo", rest),
  ];

  return (
    <Page crumbs={crumbs}>
      {lostFull === monorepo.full ? (
        <>
          <Title>You no longer have access to {monorepo.full}.</Title>
          <p className="mt-2 text-[14px] text-bark-dim">
            <Lnk to="/">Back to your repositories</Lnk>
          </p>
        </>
      ) : (
        <>
          <Outlet />
          <Assistant />
        </>
      )}
    </Page>
  );
}

