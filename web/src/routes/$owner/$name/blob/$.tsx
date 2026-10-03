// A root file's page is the file, full width (owner note): its latest change
// with History, then Raw, Copy, Copy link and Copy raw link, then the file.
// `?v=` shows an older version. The free width on the right is kept for
// Plannotator's comment dock later.
import { Routes } from "@pando/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, useLocation } from "@tanstack/react-router";
import { entryQuery, fileQuery } from "../../../../api/queries";
import { fileSearch, versionOf } from "../../../../api/search";
import { CopyButton, lnk } from "../../../../ui/controls";
import { Markdown } from "../../../../ui/Markdown";
import { absolute, blobLink, historyLink, monoLink, treeLink } from "../../../../ui/paths";
import { ChangeBar, saverOf } from "../-code/FileList";

export const Route = createFileRoute("/$owner/$name/blob/$")({
  validateSearch: fileSearch,
  loaderDeps: ({ search }) => ({ v: versionOf(search.v) }),
  loader: async ({ context: { queryClient, monorepo }, params, deps }) => {
    const path = params._splat ?? "";

    const [entry, file] = await Promise.allSettled([
      queryClient.ensureQueryData(entryQuery(monorepo, path, deps.v)),
      queryClient.ensureQueryData(fileQuery(monorepo, path, deps.v)),
    ]);

    if (entry.status === "rejected") throw entry.reason;

    if (!entry.value || entry.value.deleted) throw notFound();

    if (file.status === "rejected") throw file.reason;
  },
  component: FilePage,
});

const tool =
  "inline-flex h-7 cursor-pointer items-center rounded-md border border-rootline bg-soil px-2.5 text-[12.5px] leading-[15px] whitespace-nowrap text-bark-dim hover:border-rule-hi hover:text-bark";

function Lines({ text }: { text: string }) {
  return (
    <pre className="m-0 overflow-x-auto py-3 font-mono text-[12.5px] leading-5 text-bark">
      {text.split("\n").map((line, i) => (
        <span key={i} className="grid grid-cols-[52px_minmax(0,1fr)] whitespace-pre">
          <i className="pr-[18px] text-right text-ash not-italic select-none">{i + 1}</i>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function FilePage() {
  const { monorepo } = Route.useRouteContext();
  const path = Route.useParams()._splat ?? "";
  const { v } = Route.useLoaderDeps();
  const location = useLocation();
  const entry = useSuspenseQuery(entryQuery(monorepo, path, v)).data;
  const { text } = useSuspenseQuery(fileQuery(monorepo, path, v)).data;

  if (!entry) return null;
  const full = monorepo.full;
  const parts = path.split("/");
  const name = parts.at(-1) ?? path;
  const raw = Routes.metaRawPath(monorepo.owner, monorepo.name, path, v);
  const what = entry.restored_from ? `Restored from version ${entry.restored_from}, as version ${entry.version}` : `Saved version ${entry.version}`;
  const preview = text !== null && !entry.large;

  return (
    <div className="max-w-[1000px]">
      <div className="mb-3.5 flex items-center gap-4 phone:flex-wrap">
        <span className="font-mono text-[13px] leading-[16px] text-ash">
          <Link {...monoLink(full)} className="text-bark-dim hover:text-bark">
            {monorepo.name}
          </Link>
          {" / "}
          {parts.slice(0, -1).map((p, i) => (
            <span key={i}>
              <Link {...treeLink(full, parts.slice(0, i + 1).join("/"))} className="text-bark-dim hover:text-bark">
                {p}
              </Link>
              {" / "}
            </span>
          ))}
          {name}
        </span>
      </div>
      {v ? (
        <p className="mb-3.5 flex items-center gap-3.5 rounded-lg bg-loam px-3.5 py-2.5 text-[13.5px] text-bark-dim">
          <span>Version {entry.version}</span>
          <Link {...blobLink(full, path)} className={`${lnk} ml-auto`}>
            Back to now
          </Link>
        </p>
      ) : null}
      <div className="overflow-hidden rounded-[10px] border border-rootline">
        <ChangeBar who={saverOf(entry)} title={what} id={`on ${entry.machine}`} at={entry.at} history={historyLink(full, path)} />
        {/* On a phone: the name on its own line, the four tools on one row below (design review, 2026-10-03). */}
        <div className="flex min-h-11 items-center gap-2 border-y border-rule-faint py-1.5 pr-2.5 pl-4 phone:flex-wrap phone:pb-2.5">
          <span className="mr-auto overflow-hidden font-mono text-[12.5px] leading-[15px] text-ellipsis whitespace-nowrap text-ash phone:basis-full">{name}</span>
          <span className="flex flex-wrap gap-1.5 phone:flex-nowrap">
            <a href={raw} className={tool}>
              Raw
            </a>
            {text === null ? null : <CopyButton text={text} className={tool} />}
            <CopyButton text={absolute(location.href)} label="Copy link" className={tool} />
            <CopyButton text={absolute(raw)} label="Copy raw link" className={tool} />
          </span>
        </div>
        {!preview ? (
          <p className="px-5 py-7 text-[13.5px] text-ash">No preview for this file.</p>
        ) : /\.(md|markdown)$/i.test(name) ? (
          <div className="px-[26px] pt-[22px] pb-2.5">
            <Markdown text={text} />
          </div>
        ) : (
          <Lines text={text} />
        )}
      </div>
    </div>
  );
}
