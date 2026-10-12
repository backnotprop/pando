// The comment panel beside an artifact (SEAMS.html): Plannotator's
// AnnotationPanel, embedded, in Pando's colours, with Pando's pieces in its
// slots. Above it: Comments with its count, a whole-file comment (Plannotator's
// composer), and Open | Resolved. In each card's header: the person's machine,
// "On v2" when it was made on another version and still placed, "Resolved by"
// in the Resolved list. At each thread's foot: Reply (a plain box, Cancel and
// Reply), Resolve or Reopen, and "Made on v2" when it cannot be placed on this
// version (the panel's own Unanchored chip says so). A resolved thread folds
// to one line under the open ones and leaves the document.
import type { Artifact, ArtifactThread } from "@pando/contract";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { CommentPopover } from "@plannotator/ui/components/CommentPopover";
import type { Annotation } from "@plannotator/ui/types";
import { type AnnotationScope, groupAnnotationsByDocument } from "@plannotator/ui/utils/annotationScope";
import { type KeyboardEvent, useRef, useState } from "react";
import { button, field } from "../../controls";
import { CheckIcon } from "../../Icons";
import { ago, useNow } from "../../time";
import type { ReviewActions } from "../Artifact";
import { byId, hasPlace, panelAnnotations, rootAnnotation } from "./threads";

export type Filter = "open" | "resolved";

const linkButton = "cursor-pointer text-[12.5px] text-bark-dim hover:text-bark disabled:cursor-default disabled:opacity-50";

/** Waits on an action, keeping what it refused to say under the panel. */
function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);

    try {
      await run();

      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));

      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, act };
}

/** The reply box: a plain field, Cancel and Reply; Mod+Enter sends it. */
function ReplyBox({ onSend, onCancel, busy }: { onSend: (body: string) => void; onCancel: () => void; busy: boolean }) {
  const [text, setText] = useState("");

  const send = () => {
    if (text.trim()) onSend(text.trim());
  };

  return (
    <div className="grid gap-2">
      <textarea
        aria-label="Reply"
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();

          if (e.key === "Escape") onCancel();
        }}
        className={`${field} h-auto min-h-[72px] w-full resize-y py-2 leading-5`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className={button("quiet", 28)} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={button("solid", 28)} disabled={busy || !text.trim()} onClick={send}>
          Reply
        </button>
      </div>
    </div>
  );
}

export interface PanelProps {
  artifact: Artifact;
  version: number;
  threads: readonly ArtifactThread[];
  branch: { artifacts: readonly Artifact[]; threads: readonly ArtifactThread[] } | null;
  me: string | null;
  actions: ReviewActions;
  /** Roots the document could not place on this version. */
  unanchored: ReadonlySet<string>;
  filter: Filter;
  onFilter: (f: Filter) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export function Panel({ artifact, version, threads, branch, me, actions, unanchored, filter, onFilter, selected, onSelect }: PanelProps) {
  const clock = useNow();
  const { busy, error, act } = useAct();
  const [replying, setReplying] = useState<string | null>(null);
  const [scope, setScope] = useState<AnnotationScope>("current");
  const [composing, setComposing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const open = threads.filter((t) => t.state === "open");
  const resolved = threads.filter((t) => t.state === "resolved");
  const shown = filter === "open" ? open : resolved;
  const annotations = panelAnnotations(shown);
  const index = byId(threads);

  // All files: every artifact on the branch, this one first, each with the threads of the list shown.
  const groups =
    scope === "all" && branch
      ? groupAnnotationsByDocument(
          branch.artifacts.map((a) => ({
            path: a.name,
            annotations: a.id === artifact.id ? annotations : panelAnnotations(branch.threads.filter((t) => t.artifact === a.id && t.state === filter)),
          })),
          artifact.name,
        )
      : undefined;

  /** The card a thread's foot sits under: its last reply, or the root. */
  const isThreadEnd = (id: string) => {
    const at = index.get(id);

    return !!at && (at.thread.replies.at(-1)?.id ?? at.thread.id) === id;
  };

  const header = (a: Annotation) => {
    const at = index.get(a.id);

    if (!at) return null;
    const { comment, thread } = at;
    const root = comment.id === thread.id;
    const elsewhere = root && comment.version !== version && hasPlace(rootAnnotation(thread)) && !unanchored.has(thread.id);

    return (
      // data-own: the panel's own Edit and Delete show only on your comments (doc.css).
      <span data-own={me !== null && comment.author === me ? "true" : "false"} className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        {comment.machine ? <span className="truncate">{comment.machine}</span> : null}
        {elsewhere ? <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium">On v{comment.version}</span> : null}
        {root && thread.state === "resolved" && thread.resolved_by ? <span className="truncate">Resolved by {thread.resolved_by}</span> : null}
      </span>
    );
  };

  const footer = (a: Annotation) => {
    const at = index.get(a.id);

    if (!at || !isThreadEnd(a.id)) return null;
    const { thread } = at;
    const lost = unanchored.has(thread.id);

    if (replying === thread.id && me) {
      return (
        <ReplyBox
          busy={busy}
          onCancel={() => setReplying(null)}
          onSend={(body) =>
            void act(() => actions.reply(thread.id, body)).then((ok) => {
              if (ok) setReplying(null);
            })
          }
        />
      );
    }

    return (
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {me && thread.state === "open" ? (
          <button type="button" className={linkButton} onClick={() => setReplying(thread.id)}>
            Reply
          </button>
        ) : null}
        {me ? (
          <button type="button" className={linkButton} disabled={busy} onClick={() => void act(() => actions.setState(thread.id, thread.state === "open" ? "resolved" : "open"))}>
            {thread.state === "open" ? "Resolve" : "Reopen"}
          </button>
        ) : null}
        {lost && thread.version !== version ? (
          <button type="button" className={`${linkButton} text-clay hover:text-bark`} onClick={() => actions.openVersion(thread.version)}>
            Made on v{thread.version}
          </button>
        ) : null}
      </span>
    );
  };

  return (
    <section aria-label="Comments" className="pn-panel overflow-hidden rounded-[10px] border border-rootline bg-soil">
      <div className="flex items-center gap-2.5 border-b border-rootline px-4 py-3">
        <h2 className="text-[15px] font-semibold text-bark">Comments</h2>
        <span className="rounded-full bg-loam px-2 text-[12px] leading-5 text-bark-dim">{open.length}</span>
        {me ? (
          <button ref={opener} type="button" className={`${button("quiet", 28)} ml-auto`} onClick={() => setComposing(true)}>
            Comment on the file
          </button>
        ) : null}
      </div>
      <div role="group" aria-label="Show" className="flex gap-4 border-b border-rootline px-4 py-2.5 text-[13px]">
        {(["open", "resolved"] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} className="cursor-pointer text-ash aria-pressed:font-semibold aria-pressed:text-bark" onClick={() => onFilter(f)}>
            {f === "open" ? "Open" : "Resolved"} {f === "open" ? open.length : resolved.length}
          </button>
        ))}
      </div>
      <AnnotationPanel
        isOpen
        presentation="embedded"
        annotations={annotations}
        blocks={[]}
        selectedId={selected}
        onSelect={(id) => onSelect(id)}
        onDelete={(id) => void act(() => actions.remove(id))}
        onEdit={(id, updates) => {
          const c = index.get(id)?.comment;

          if (c && updates.text !== undefined) void act(() => actions.edit(id, updates.text ?? "", c.body_version));
        }}
        readOnly={!me}
        sharingEnabled={false}
        unanchoredIds={unanchored}
        renderCardHeader={header}
        renderCardFooter={footer}
        annotationScope={branch ? scope : undefined}
        onAnnotationScopeChange={branch ? setScope : undefined}
        documentGroups={groups}
        onSelectInDocument={(path, id) => (path === artifact.name ? onSelect(id) : actions.openArtifact(path))}
        onDeleteInDocument={(_path, id) => void act(() => actions.remove(id))}
      />
      {!annotations.length && scope === "current" ? <p className="px-4 pb-4 text-[13px] text-ash">{filter === "open" ? "No open comments." : "No resolved comments."}</p> : null}
      {filter === "open" && resolved.length ? (
        <ul aria-label="Resolved threads" className="grid gap-1.5 px-2 pb-2">
          {resolved.map((t) => (
            <li key={t.id} className="min-w-0">
              <button
                type="button"
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border border-rule-faint px-3 py-2 text-left text-[12.5px] text-bark-dim hover:border-rootline"
                onClick={() => {
                  onFilter("resolved");
                  onSelect(t.id);
                }}
              >
                <CheckIcon className="size-3.5 flex-none" />
                <span className="whitespace-nowrap">
                  Resolved by <span className="font-semibold text-bark">{t.resolved_by}</span> {t.resolved_at ? ago(t.resolved_at, clock) : ""}
                </span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-ash">{rootAnnotation(t).originalText ? `"${rootAnnotation(t).originalText}"` : t.body}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="px-4 pb-3 text-[13px] text-rust">{error}</p> : null}
      {composing && opener.current ? (
        <CommentPopover
          anchorEl={opener.current}
          contextText=""
          isGlobal
          allowImages={false}
          onSubmit={(text) => {
            setComposing(false);
            void act(() => actions.add(null, text));
          }}
          onClose={() => setComposing(false)}
        />
      ) : null}
    </section>
  );
}
