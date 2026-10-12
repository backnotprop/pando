// One artifact on a branch's page (SPEC.md 8, "One artifact open"): back to
// the list, its name, the version menu ("v2 of 2"), Preview and Code for a
// document, Raw, Download and Copy link; who uploaded the version shown, from
// where, when, and its size. Under them the document and, beside it, the
// comment panel (ui/doc/Artifact.tsx, Plannotator's viewer and panel). The
// version is in the address (`&v=2`), Code too (`&plain=1`).
import type { Branch, Repo } from "@pando/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  addReply,
  addThread,
  artifactListQuery,
  artifactQuery,
  artifactsKey,
  branchThreadsQuery,
  deleteComment,
  documentQuery,
  editComment,
  fileHref,
  newKey,
  setThreadState,
  threadsQuery,
} from "../../../../api/artifacts";
import { meQuery } from "../../../../api/queries";
import { versionOf } from "../../../../api/search";
import { CopyButton, Empty } from "../../../../ui/controls";
import { ArtifactReview, type ReviewActions } from "../../../../ui/doc/Artifact";
import { Select } from "../../../../ui/dropdown";
import { Chevron } from "../../../../ui/Icons";
import { absolute, type ArtifactAt, branchArtifactsLink } from "../../../../ui/paths";
import { clock } from "../../../../ui/time";
import { FileBody, tool } from "../-code/FileView";
import { useMonorepo } from "../-frame/heads";
import { fromWhere, sizeOf } from "./parts";

const part = "inline-flex items-center px-2.5 whitespace-nowrap";

const on = `${part} bg-loam text-bark`;

const off = `${part} bg-soil text-bark-dim hover:text-bark`;

export function ArtifactPage({ repo, b, name, at }: { repo: Repo; b: Branch; name: string; at: ArtifactAt }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useQuery(meQuery).data?.login ?? null;
  const list = useQuery(artifactListQuery(monorepo, repo.name, b.name));
  const id = list.data?.artifacts.find((a) => a.name === name)?.id ?? null;
  const detail = useQuery({ ...artifactQuery(monorepo, id ?? ""), enabled: !!id }).data;
  const n = versionOf(at.v) ?? detail?.latest.n ?? 0;
  const shown = detail?.all_versions.find((v) => v.n === n) ?? null;
  const isImage = detail?.kind === "image";
  const text = useQuery({ ...documentQuery(monorepo, id ?? "", n), enabled: !!detail && !isImage && !!shown }).data;
  const threads = useQuery({ ...threadsQuery(monorepo, id ?? ""), enabled: !!id }).data;
  const branchThreads = useQuery(branchThreadsQuery(monorepo, repo.name, b.name)).data;
  const plain = at.plain === "1" && !isImage;

  const link = (where: ArtifactAt) => branchArtifactsLink(monorepo.full, repo.path, b.name, where);
  const done = () => qc.invalidateQueries({ queryKey: artifactsKey(monorepo) });

  // Each write reads the artifact's lists and threads again once it is answered (the socket brings others' too).
  const settled = <T,>(p: Promise<T>): Promise<void> => p.then(() => undefined).finally(done);

  const actions: ReviewActions = {
    add: (anchor, body) => (id ? settled(addThread(monorepo, id, n, anchor, body, newKey())) : Promise.resolve()),
    reply: (root, body) => (id ? settled(addReply(monorepo, id, root, body, newKey())) : Promise.resolve()),
    setState: (root, state) => settled(setThreadState(monorepo, root, state)),
    edit: (cid, body, base) => settled(editComment(monorepo, cid, body, base)),
    remove: (cid) => settled(deleteComment(monorepo, cid)),
    openVersion: (v) => void navigate(link({ artifact: name, v: String(v) })),
    openArtifact: (other) => void navigate(link({ artifact: other })),
  };

  if (list.data && !id) {
    return (
      <div>
        <Link {...link({})} className="text-[13.5px] text-bark-dim hover:text-bark">
          ‹ Artifacts
        </Link>
        <Empty>No artifact named {name} on this branch.</Empty>
      </div>
    );
  }

  // The document's text first: the viewer places comments on what it renders.
  if (!detail || !shown || (!isImage && text === undefined)) return <div className="min-h-24" />;

  const main = shown.files[0]?.path ?? detail.name;
  const raw = fileHref(monorepo, detail.id, n, main);
  const docView = !isImage;

  const head = (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <Link {...link({})} className="inline-flex items-center gap-1.5 text-[14px] text-bark-dim hover:text-bark">
          <Chevron className="size-3.5 rotate-90" />
          Artifacts
        </Link>
        <h2 className="min-w-0 truncate text-[15px] text-bark">{detail.name}</h2>
        <Select label="Version" size="small" value={String(n)} onChange={(v) => void navigate(link({ artifact: name, v: Number(v) === detail.latest.n ? undefined : v, plain: plain ? "1" : undefined }))}>
          {[...detail.all_versions].reverse().map((v) => (
            <option key={v.n} value={v.n}>
              v{v.n} of {detail.versions}
            </option>
          ))}
        </Select>
        <span className="ml-auto flex flex-wrap items-center gap-1.5 phone:ml-0">
          {docView ? (
            <span role="group" aria-label="View" className="inline-flex h-7 flex-none overflow-hidden rounded-md border border-rootline text-[12.5px] leading-[15px]">
              <Link {...link({ artifact: name, v: at.v })} activeOptions={{ exact: true, includeSearch: true }} className={plain ? off : on}>
                Preview
              </Link>
              <Link {...link({ artifact: name, v: at.v, plain: "1" })} activeOptions={{ exact: true, includeSearch: true }} className={`border-l border-rootline ${plain ? on : off}`}>
                Code
              </Link>
            </span>
          ) : null}
          <a href={raw} className={tool}>
            Raw
          </a>
          <a href={raw} download={detail.name} className={tool}>
            Download
          </a>
          <CopyButton text={absolute(location.href)} label="Copy link" className={tool} />
        </span>
      </div>
      <p className="mt-2.5 text-[13px] text-ash">
        {shown.uploaded_by} from {fromWhere(shown)}, {clock(shown.created_at)} · {sizeOf(shown)}
      </p>
    </div>
  );

  return (
    <ArtifactReview
      artifact={detail}
      version={n}
      text={isImage ? null : (text ?? null)}
      image={isImage ? raw : null}
      code={plain && text !== undefined ? <FileBody name={detail.name} text={text} /> : null}
      threads={threads?.threads ?? []}
      branch={branchThreads && list.data ? { artifacts: list.data.artifacts, threads: branchThreads.threads } : null}
      me={me}
      actions={actions}
      head={head}
    />
  );
}
