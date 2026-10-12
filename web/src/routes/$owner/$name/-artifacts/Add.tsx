// Adding artifacts from the browser: the drop zone under the list (and its
// "choose files"), the Add button above it, and the dialog that shows what a
// drop will make before anything is uploaded (one row per artifact, "New" or
// "v3 of banner.html"), then uploads them one by one.
import { Dialog } from "@base-ui/react/dialog";
import type { Artifact, Branch, Repo } from "@pando/contract";
import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { addArtifact, artifactsKey } from "../../../../api/artifacts";
import { button } from "../../../../ui/controls";
import { UploadIcon } from "../../../../ui/Icons";
import { useMonorepo } from "../-frame/heads";
import { group, type Group, type Grouping, kindOf, type Picked } from "./group";
import { bytes, KindIcon } from "./parts";

const ACCEPT = ".md,.markdown,.html,.htm,.png,.jpg,.jpeg,.gif,.webp,.svg";

const loose = (files: Iterable<File>): Picked[] => [...files].map((file) => ({ path: file.name, file, size: file.size, folder: null }));

/** Every file under a dropped folder, by its path from the folder's parent (`site/img/hero.png`). */
async function walk(entry: FileSystemEntry, folder: string): Promise<Picked[]> {
  if (entry.isFile) {
    // SAFETY: isFile is the File System API's own word that this entry is a FileSystemFileEntry.
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));

    return [{ path: entry.fullPath.replace(/^\//, ""), file, size: file.size, folder }];
  }

  // SAFETY: not a file, so a directory (the API's two kinds of entry).
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];

  // readEntries answers in batches until an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));

    if (!batch.length) break;
    children.push(...batch);
  }

  return (await Promise.all(children.map((c) => walk(c, folder)))).flat();
}

/** What a drop holds: loose files, and each dropped folder's files. Entries are taken before the first await (the drop's data goes after). */
async function fromDrop(dt: DataTransfer): Promise<Picked[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null);

  if (!entries.some((e) => e?.isDirectory)) return loose(dt.files);

  const out = await Promise.all(entries.map((e) => (e ? (e.isDirectory ? walk(e, e.name) : walk(e, "")) : Promise.resolve([]))));

  return out.flat().map((p) => (p.folder === "" ? { ...p, folder: null } : p));
}

/** Groups the files, reading each document's text first (several documents take the images their text names). */
async function grouped(picked: readonly Picked[]): Promise<Grouping> {
  const docs = picked.filter((p) => kindOf(p.path) === "markdown" || kindOf(p.path) === "html");
  const texts = new Map(await Promise.all(docs.map(async (d) => [d.path, await d.file.text()] as const)));

  return group(picked, texts);
}

/** Opens the dialog with what files make; Add (or a drop) calls it. */
export function useAdding() {
  const [picked, setPicked] = useState<readonly Picked[]>([]);
  const [grouping, setGrouping] = useState<Grouping | null>(null);

  const take = async (more: readonly Picked[]) => {
    const all = [...picked, ...more];

    setPicked(all);
    setGrouping(await grouped(all));
  };

  const close = () => {
    setPicked([]);
    setGrouping(null);
  };

  return { grouping, take, close };
}

type Adding = ReturnType<typeof useAdding>;

/** A hidden file input and what opens it. */
function useChooser(adding: Adding) {
  const input = useRef<HTMLInputElement>(null);

  const element = (
    <input
      ref={input}
      type="file"
      multiple
      accept={ACCEPT}
      aria-label="Choose files"
      className="hidden"
      onChange={(e) => {
        const files = e.currentTarget.files;

        if (files?.length) void adding.take(loose(files));
        e.currentTarget.value = "";
      }}
    />
  );

  return { element, open: () => input.current?.click() };
}

/** The handlers that make an element a drop target, and whether something is over it. */
function useDrop(onDrop: (picked: Picked[]) => void) {
  const [over, setOver] = useState(false);

  return {
    over,
    on: {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        void fromDrop(e.dataTransfer).then(onDrop);
      },
    },
  };
}

const chooseLink = "cursor-pointer border-b border-ash-half pb-px text-bark-dim hover:border-bark hover:text-bark";

/** The Add button at the top of the list. */
export function AddButton({ adding, big = false }: { adding: Adding; big?: boolean }) {
  const chooser = useChooser(adding);

  return (
    <>
      {chooser.element}
      <button type="button" className={`${button("quiet", big ? 32 : 30)} gap-2`} onClick={chooser.open}>
        <UploadIcon className="size-4" />
        Add
      </button>
    </>
  );
}

/** The dashed drop zone. `empty`: the branch has none yet, so it is the tab's whole body (the icon, the words, Add). */
export function DropZone({ adding, empty = false, children }: { adding: Adding; empty?: boolean; children?: ReactNode }) {
  const chooser = useChooser(adding);
  const drop = useDrop((p) => void adding.take(p));
  const ring = drop.over ? "border-bark bg-loam" : "border-rootline";

  if (empty) {
    return (
      <div data-drop-zone="" {...drop.on} className={`grid justify-items-center gap-4 rounded-[10px] border border-dashed px-6 py-8 text-center text-[13.5px] text-bark-dim ${ring}`}>
        <UploadIcon className="size-5 text-bark-dim" />
        <span>Drop Markdown, HTML or images</span>
        {children}
      </div>
    );
  }

  return (
    <div data-drop-zone="" {...drop.on} className={`mt-3 flex items-center justify-center gap-2.5 rounded-[10px] border border-dashed px-6 py-4 text-[13.5px] text-bark-dim ${ring}`}>
      {chooser.element}
      <UploadIcon className="size-4 flex-none" />
      <span>
        Drop Markdown, HTML or images, or{" "}
        <button type="button" className={chooseLink} onClick={chooser.open}>
          choose files
        </button>
      </span>
    </div>
  );
}

/** "New", or "v3 of banner.html" when the branch has one by that name. */
function whatItMakes(g: Group, existing: readonly Artifact[]) {
  const same = existing.find((a) => a.name === g.name);

  return same ? `v${same.latest.n + 1} of ${same.name}` : "New";
}

type RowState = { state: "waiting" } | { state: "adding" } | { state: "added"; n: number } | { state: "failed"; why: string };

function Row({ g, existing, state }: { g: Group; existing: readonly Artifact[]; state: RowState }) {
  const images = g.images.map((i) => i.path).join(", ");
  const said = state.state === "failed" ? state.why : g.problem;

  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t border-rule-faint px-4 py-3 first:border-t-0">
      <span className="pt-0.5 text-bark-dim">
        <KindIcon kind={g.kind} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] text-bark">{g.name}</span>
        <span className="block truncate text-[12.5px] text-ash">{images ? `with ${images} · ${bytes(g.size)}` : bytes(g.size)}</span>
        {said ? <span className="mt-1 block text-[12.5px] text-rust">{said}</span> : null}
      </span>
      <span className="text-right text-[12.5px] whitespace-nowrap text-bark">
        {g.problem ? "Left out" : state.state === "adding" ? "Adding" : state.state === "added" ? `Added v${state.n}` : whatItMakes(g, existing)}
      </span>
    </li>
  );
}

/** The dialog: what the drop makes, more can be dropped in, then Add uploads each in turn. */
export function AddDialog({ repo, b, adding, existing }: { repo: Repo; b: Branch; adding: Adding; existing: readonly Artifact[] }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [states, setStates] = useState<ReadonlyMap<Group, RowState>>(new Map());
  const [busy, setBusy] = useState(false);
  const chooser = useChooser(adding);
  const drop = useDrop((p) => void adding.take(p));
  const groups = adding.grouping?.groups ?? [];
  const ready = groups.filter((g) => !g.problem && states.get(g)?.state !== "added");

  const close = () => {
    if (busy) return;
    setStates(new Map());
    adding.close();
  };

  const add = async () => {
    setBusy(true);
    const next = new Map(states);
    let failed = false;

    for (const g of ready) {
      next.set(g, { state: "adding" });
      setStates(new Map(next));

      try {
        const made = await addArtifact(monorepo, repo.name, b.name, g);

        next.set(g, { state: "added", n: made.latest.n });
      } catch (error) {
        failed = true;
        next.set(g, { state: "failed", why: error instanceof Error ? error.message : String(error) });
      }

      setStates(new Map(next));
    }

    await qc.invalidateQueries({ queryKey: artifactsKey(monorepo) });
    setBusy(false);

    if (!failed) {
      setStates(new Map());
      adding.close();
    }
  };

  const skipped = adding.grouping?.skipped ?? [];

  return (
    <Dialog.Root
      open={adding.grouping !== null}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-10 bg-[color-mix(in_srgb,var(--soil)_72%,transparent)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[112px] left-1/2 z-10 w-[640px] max-w-[calc(100%-32px)] -translate-x-1/2 rounded-xl border border-rootline bg-pop px-[22px] pt-5 pb-5 shadow-pop outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 phone:top-6">
          <Dialog.Title className="mb-3.5 text-[16px] font-semibold">
            Add to <code className="font-mono font-normal">{b.name}</code>
          </Dialog.Title>
          {groups.length ? (
            <ul aria-label="What will be added" className="overflow-hidden rounded-[10px] border border-rootline bg-soil">
              {groups.map((g) => (
                <Row key={`${g.name}:${g.main.path}`} g={g} existing={existing} state={states.get(g) ?? { state: "waiting" }} />
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-ash">Nothing here is a Markdown, HTML or image file.</p>
          )}
          {skipped.length ? <p className="mt-2.5 text-[12.5px] text-ash">Left out: {skipped.join(", ")} (not a document or an image, or not the folder's document).</p> : null}
          <div
            data-drop-zone=""
            {...drop.on}
            className={`mt-3.5 grid justify-items-center gap-2 rounded-[10px] border border-dashed px-6 py-5 text-[13.5px] text-bark-dim ${drop.over ? "border-bark bg-loam" : "border-rootline"}`}
          >
            {chooser.element}
            <UploadIcon className="size-4" />
            <span>
              Drop more, or{" "}
              <button type="button" className={chooseLink} onClick={chooser.open}>
                choose files
              </button>
            </span>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2.5">
            <button type="button" className={button("quiet")} disabled={busy} onClick={close}>
              Cancel
            </button>
            <button type="button" className={button("solid")} disabled={busy || !ready.length} onClick={() => void add()}>
              Add {ready.length === 1 ? "1 artifact" : `${ready.length} artifacts`}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
