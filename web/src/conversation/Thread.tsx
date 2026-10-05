// The frame a conversation scrolls in (owner, 2026-10-05): the message box is
// fixed at the bottom and the view follows the newest line while the person is
// at the bottom; scrolled up, it stays put and "Jump to latest" shows. Older
// turns load as the person scrolls near the top, the view keeping its place.
// With no box (`dock` absent) the conversation is read-only: someone who cannot
// send sees no box at all. The frame takes its parent's height.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Chevron } from "../ui/Icons";
import { Leaf } from "../ui/Leaf";
import type { ConversationItem } from "./shape";

/** How near the bottom still counts as at the bottom, and how near the top loads older turns (px). */
const NEAR = 48;

const NEAR_TOP = 240;

/** Items shown at first, and how many more each load of older ones adds. */
const PAGE = 80;

/** Older turns: whether there are more, whether they are loading, and how to load them. */
export interface Older {
  more: boolean;
  loading: boolean;
  load: () => void;
}

/** The items to draw, and how to reach older ones. */
export interface Shown {
  shown: readonly ConversationItem[];
  older: Older;
}

/**
 * A whole transcript read at once, shown from its end: the last PAGE items,
 * PAGE more each time the person nears the top. A feeder that pages from its
 * server passes its own Older instead.
 */
export function useShownFromEnd(items: readonly ConversationItem[]): Shown {
  const [count, setCount] = useState(PAGE);

  return {
    shown: items.length > count ? items.slice(items.length - count) : items,
    older: { more: items.length > count, loading: false, load: () => setCount((c) => c + PAGE) },
  };
}

export function Thread({ items, older, dock, children }: { items: readonly ConversationItem[]; older?: Older; dock?: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const follow = useRef(true);
  // The first item and the height before older ones came in, to keep the place.
  const first = useRef<string | undefined>(undefined);
  const height = useRef(0);
  const firstKey = items[0]?.key;
  const lastKey = items.at(-1)?.key;

  useLayoutEffect(() => {
    const el = box.current;

    if (!el) return;

    if (first.current !== undefined && firstKey !== first.current && !follow.current) el.scrollTop += el.scrollHeight - height.current;
    else if (follow.current) el.scrollTop = el.scrollHeight;
    first.current = firstKey;
    height.current = el.scrollHeight;
  }, [firstKey, lastKey, items.length]);

  // A step running grows the last line; a live view follows it while at the end.
  useEffect(() => {
    const el = box.current;

    if (!el) return;

    const seen = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
      height.current = el.scrollHeight;
    });

    for (const child of el.children) seen.observe(child);

    return () => seen.disconnect();
  }, []);

  const onScroll = () => {
    const el = box.current;

    if (!el) return;

    const end = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;

    follow.current = end;
    setAtEnd(end);

    if (el.scrollTop < NEAR_TOP && older?.more && !older.loading) {
      height.current = el.scrollHeight;
      older.load();
    }
  };

  const jump = () => {
    const el = box.current;

    if (!el) return;

    follow.current = true;
    setAtEnd(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Conversation" role="log">
        <div className="px-1 pt-1 pb-6">
          {older?.more ? (
            <p className="mb-4 flex items-center gap-2 text-[12.5px] text-ash">
              <Leaf state="thinking" size={12} />
              Loading earlier steps
            </p>
          ) : null}
          {children}
        </div>
      </div>
      <div className="relative">
        {atEnd ? null : (
          <button
            type="button"
            onClick={jump}
            className="absolute -top-12 left-1/2 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-rootline bg-pop px-3.5 text-[13px] text-bark shadow-pop"
          >
            <Chevron className="size-3" />
            Jump to latest
          </button>
        )}
        {dock}
      </div>
    </div>
  );
}
