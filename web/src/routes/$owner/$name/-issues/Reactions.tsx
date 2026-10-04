// GitHub's eight reactions (owner ruling), under a body or a comment: a
// quiet face that opens the eight, then each reaction given with its count.
// Yours is outlined; pressing it takes it back. Each name shows who on hover.
import { Popover } from "@base-ui/react/popover";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { react } from "../../../../api/issues";
import { REACTIONS, type Reaction, type ReactionContent } from "../../../../api/pending";
import { SmileIcon } from "../../../../ui/IssueIcons";
import { useMonorepo } from "../-frame/heads";
import { useMe } from "./parts";

export const EMOJI: Record<ReactionContent, { glyph: string; name: string }> = {
  "+1": { glyph: "👍", name: "Thumbs up" },
  "-1": { glyph: "👎", name: "Thumbs down" },
  laugh: { glyph: "😄", name: "Laugh" },
  hooray: { glyph: "🎉", name: "Hooray" },
  confused: { glyph: "😕", name: "Confused" },
  heart: { glyph: "❤️", name: "Heart" },
  rocket: { glyph: "🚀", name: "Rocket" },
  eyes: { glyph: "👀", name: "Eyes" },
};

const who = (r: Reaction, me: string | null) => {
  const names = r.by.map((l) => (l === me ? "you" : l));

  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
};

/** `comment` null: the issue's body. `onChange` takes the reactions as the server answered them. */
export function Reactions({ n, comment, reactions, onChange }: { n: number; comment: string | null; reactions: readonly Reaction[]; onChange: (next: readonly Reaction[]) => void }) {
  const { monorepo } = useMonorepo();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: ({ content, on }: { content: ReactionContent; on: boolean }) => react(monorepo, n, comment, content, on),
    onSuccess: onChange,
  });
  const given = REACTIONS.flatMap((c) => reactions.filter((r) => r.content === c && r.count > 0));
  const mine = (c: ReactionContent) => !!me && reactions.some((r) => r.content === c && r.by.includes(me));

  const press = (content: ReactionContent) => {
    setOpen(false);
    toggle.mutate({ content, on: !mine(content) });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3.5 phone:px-3.5">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label="Add a reaction"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-ash shadow-[inset_0_0_0_1px_var(--rule-soft)] hover:text-bark hover:shadow-[inset_0_0_0_1px_var(--rule-hi)] data-popup-open:text-bark"
        >
          <SmileIcon className="size-4" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={6} className="z-10">
            <Popover.Popup className="flex gap-0.5 rounded-[10px] border border-rootline bg-pop p-1.5 shadow-pop outline-none">
              {REACTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={EMOJI[c].name}
                  aria-pressed={mine(c)}
                  title={EMOJI[c].name}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-md text-[16px] hover:bg-pop-hi aria-pressed:bg-pop-hi"
                  onClick={() => press(c)}
                >
                  {EMOJI[c].glyph}
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {given.map((r) => (
        <button
          key={r.content}
          type="button"
          aria-label={`${EMOJI[r.content].name} ${r.count}`}
          aria-pressed={mine(r.content)}
          title={`${EMOJI[r.content].name}: ${who(r, me)}`}
          disabled={toggle.isPending}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-soft)] hover:text-bark aria-pressed:bg-loam aria-pressed:text-bark aria-pressed:shadow-[inset_0_0_0_1px_var(--ash-half)]"
          onClick={() => press(r.content)}
        >
          <span className="text-[14px] leading-none">{EMOJI[r.content].glyph}</span>
          {r.count}
        </button>
      ))}
    </div>
  );
}
