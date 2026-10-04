// A monorepo's frame: it finds the monorepo, draws the breadcrumb from the
// address, and keeps the monorepo's own socket open while one of its pages is.
// Each page draws its own head (-frame/heads.tsx).
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { isMissing } from "../../../api/client";
import { monorepoRef } from "../../../api/names";
import { monorepoQuery } from "../../../api/queries";
import { startMonorepoFeed } from "../../../live/monorepo";
import { Page } from "../../../ui/pages";
import { blobLink, codeBlobLink, codeLink, ownerLink, treeLink } from "../../../ui/paths";
import type { Crumb } from "../../../ui/TopBar";

export const Route = createFileRoute("/$owner/$name")({
  beforeLoad: ({ params }) => {
    try {
      return { monorepo: monorepoRef(params.owner, params.name) };
    } catch {
      throw notFound();
    }
  },
  loader: async ({ context: { queryClient, monorepo } }) => {
    try {
      return await queryClient.ensureQueryData(monorepoQuery(monorepo));
    } catch (error) {
      if (error instanceof Error && isMissing(error)) throw notFound();

      throw error;
    }
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

  if (kind === "projects" && !plain) {
    const [, sub = "", ...path] = parts;
    const deeper = sub === "branches" ? [{ label: path.length ? path.join("/") : "branches" }] : codeCrumbs(full, repoPath, sub, path);
    // On a phone the project crumb drops out whenever a deeper crumb follows, so the breadcrumb never overlaps.
    const project: Crumb = { label: repoPath, link: deeper.length ? codeLink(full, repoPath, "") : undefined, project: repoPath, wide: deeper.length > 0 };

    return [project, ...deeper];
  }

  if (plain && kind === "branches") return parts.length ? [{ label: parts.join("/") }] : [{ label: "branches" }];

  if (plain) return codeCrumbs(full, ".", kind, parts);

  if (kind === "tree" || kind === "blob") return pathCrumbs(parts, (dir) => treeLink(full, dir));

  if (kind === "history") return [...pathCrumbs(parts, (dir) => treeLink(full, dir), blobLink(full, parts.join("/"))), { label: "history" }];

  return kind ? [{ label: kind }] : [];
}

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
  const { pathname } = useLocation();
  const queryClient = useQueryClient();

  const { owner, name } = monorepo;

  // One socket per monorepo, kept across its pages (the context object is new on each navigation).
  useEffect(() => startMonorepoFeed(queryClient, monorepoRef(owner, name)), [queryClient, owner, name]);

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
      <Outlet />
    </Page>
  );
}

