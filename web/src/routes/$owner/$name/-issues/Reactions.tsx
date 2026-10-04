// GitHub's eight reactions (owner ruling) on a body or a comment: a quiet
// face in its header opens the eight; under the text, each reaction given with
// its count. Yours is outlined; pressing it takes it back. Hover names who.
import { Popover } from "@base-ui/react/popover";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { react } from "../../../../api/issues";
import { ReactionContent, type ReactionGroup } from "@pando/contract";
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

const who = (r: ReactionGroup, me: string | null) => {
  const names = r.by.map((l) => (l === me ? "you" : l));

  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
};

export interface Reacting {
  given: readonly ReactionGroup[];
  me: string | null;
  mine: (c: ReactionContent) => boolean;
  press: (c: ReactionContent) => void;
  pending: boolean;
}

/** A body's or a comment's reactions and how to toggle yours. `comment` null: the issue's body. `onChange` takes the reactions as the server answered them. */
export function useReactions(n: number, comment: string | null, reactions: readonly ReactionGroup[], onChange: (next: readonly ReactionGroup[]) => void): Reacting {
  const { monorepo } = useMonorepo();
  const me = useMe();

  const toggle = useMutation({
    mutationFn: ({ content, on }: { content: ReactionContent; on: boolean }) => react(monorepo, n, comment, content, on),
    onSuccess: onChange,
  });

  const mine = (c: ReactionContent) => !!me && reactions.some((r) => r.content === c && r.by.includes(me));

  return {
    given: ReactionContent.literals.flatMap((c) => reactions.filter((r) => r.content === c && r.count > 0)),
    me,
    mine,
    press: (content) => toggle.mutate({ content, on: !mine(content) }),
    pending: toggle.isPending,
  };
}

/** The quiet face in a box's header that opens the eight. */
export function AddReaction({ r }: { r: Reacting }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Add a reaction"
        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-ash hover:bg-pop-hi hover:text-bark data-popup-open:bg-pop-hi data-popup-open:text-bark"
      >
        <SmileIcon className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-10">
          <Popover.Popup className="flex gap-0.5 rounded-[10px] border border-rootline bg-pop p-1.5 shadow-pop outline-none">
            {ReactionContent.literals.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={EMOJI[c].name}
                aria-pressed={r.mine(c)}
                title={EMOJI[c].name}
                className="flex size-8 cursor-pointer items-center justify-center rounded-md text-[16px] hover:bg-pop-hi aria-pressed:bg-pop-hi"
                onClick={() => {
                  setOpen(false);
                  r.press(c);
                }}
              >
                {EMOJI[c].glyph}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Each reaction given, with its count, under the text; none, no row. */
export function ReactionPills({ r }: { r: Reacting }) {
  if (!r.given.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3.5 phone:px-3.5">
      {r.given.map((g) => (
        <button
          key={g.content}
          type="button"
          aria-label={`${EMOJI[g.content].name} ${g.count}`}
          aria-pressed={r.mine(g.content)}
          title={`${EMOJI[g.content].name}: ${who(g, r.me)}`}
          disabled={r.pending}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-bark-dim shadow-[inset_0_0_0_1px_var(--rule-soft)] hover:text-bark aria-pressed:bg-loam aria-pressed:text-bark aria-pressed:shadow-[inset_0_0_0_1px_var(--ash-half)]"
          onClick={() => r.press(g.content)}
        >
          <span className="text-[14px] leading-none">{EMOJI[g.content].glyph}</span>
          {g.count}
        </button>
      ))}
    </div>
  );
}
