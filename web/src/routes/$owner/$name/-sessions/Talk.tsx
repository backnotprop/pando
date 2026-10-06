// A recorded session's conversation on its page: the shared conversation component (web/src/conversation), fed from
// the session's parsed entries, from prompt 1. The server reads about 2 MB of lines a page; More reads the next. Its
// person or an owner removes a turn from a prompt's head: asked once (sessions/session-own.html), then gone for every
// member at once, a line saying so in its place.
import { Popover } from "@base-ui/react/popover";
import type { Session } from "@pando/contract";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { removeTurn, sessionEntriesQuery, sessionsKey } from "../../../../api/sessions";
import { Conversation } from "../../../../conversation/Conversation";
import type { PromptItem } from "../../../../conversation/shape";
import { button, Refusal } from "../../../../ui/controls";
import { useMonorepo } from "../-frame/heads";
import { fromSession } from "./fromSession";

function RemoveTurn({ id, n }: { id: string; n: number }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);

    try {
      await removeTurn(monorepo, id, n);
      await qc.invalidateQueries({ queryKey: sessionsKey(monorepo) });
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setBusy(false);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger className="cursor-pointer text-[12.5px] text-ash hover:text-rust">Remove turn</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="w-[360px] rounded-[10px] border border-rootline bg-pop p-5 text-[13.5px] shadow-lg outline-none">
            <Popover.Title className="mb-1.5 text-[15px] font-semibold text-bark">Remove prompt {n} and its answers?</Popover.Title>
            <Popover.Description className="leading-5 text-bark-dim">For every member, at once. Pando keeps a line saying a turn was removed.</Popover.Description>
            <div className="mt-4 flex justify-end gap-2">
              <Popover.Close className={button("quiet", 30)}>Cancel</Popover.Close>
              <button type="button" className={`${button("quiet", 30)} border-rust text-rust`} disabled={busy} onClick={() => void go()}>
                Remove
              </button>
            </div>
            <Refusal error={error} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SessionTalk({ s, mayRemove }: { s: Session; mayRemove: boolean }) {
  const { monorepo } = useMonorepo();
  const q = useInfiniteQuery(sessionEntriesQuery(monorepo, s.id));
  const pages = q.data?.pages ?? [];
  const changes = pages[0]?.model_changes ?? [];

  const items = fromSession(
    pages.flatMap((p) => p.entries),
    { person: s.person, program: s.program, changes },
  );

  const action = (item: PromptItem) => (mayRemove && item.n ? <RemoveTurn id={s.id} n={item.n} /> : null);

  return (
    <section aria-label="Conversation" className="min-w-0 phone:order-2">
      {q.isPending ? null : items.length ? <Conversation items={items} full={monorepo.full} promptAction={action} /> : <p className="text-[13.5px] text-ash">Nothing recorded yet.</p>}
      <Refusal error={q.error} />
      {q.hasNextPage ? (
        <button type="button" className={`${button("quiet", 30)} mt-6`} disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          More
        </button>
      ) : null}
    </section>
  );
}
