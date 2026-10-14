// The repository assistant (the mocks accepted 2026-10-05): a leaf button at
// the bottom right of every repository page opens a panel on the right. Its
// head: the leaf, "Assistant", the repository and when this chat started,
// Chats (the person's own, newest first), New chat and close. Its body: the
// chat's conversation, with the message box fixed under it. A chat is its
// person's alone. It reads the repository and changes something only on a
// branch the person names (start_branch). In a monorepo of more than one
// project, a new chat's box has a Project choice beside Send: the
// repository (the default: the shared files and every project) or one
// project; the head then names the chat's project. On a phone the panel
// fills the screen.
import { Popover } from "@base-ui/react/popover";
import type { AgentSession } from "@pando/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { agentModelsQuery, agentQuery, chatsQuery, newChat, sendAgent } from "../../../../api/agents";
import { askUnderstand, understandQuery } from "../../../../api/understand";
import { understandLink } from "../../../../ui/paths";
import { reposQuery } from "../../../../api/queries";
import { Composer } from "../../../../conversation/Composer";
import { Conversation } from "../../../../conversation/Conversation";
import { fromAgent } from "../../../../conversation/fromAgent";
import { Thread, useShownFromEnd } from "../../../../conversation/Thread";
import { useAgentMessages } from "../../../../live/agent";
import { fallback, useRows } from "../../../../live/rows";
import { button } from "../../../../ui/controls";
import { Caret, Select } from "../../../../ui/dropdown";
import { Leaf, type LeafState } from "../../../../ui/Leaf";
import { dayAndTime, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { useMe } from "../-issues/parts";

const HINT = "Acts as you";

/** The open panel's way in from elsewhere on the page: a new chat starting with `prompt`, about `repo`. */
let opener: ((prompt: string, repo: string | null) => void) | null = null;

/** Opens the assistant with a new chat (an Understand page with nothing found: "Ask the assistant what this code does"). */
export function askAssistant(prompt: string, repo: string | null): void {
  opener?.(prompt, repo);
}

/** The person's latest message in a chat: what Open as a page asks. */
function lastAsked(messages: ReturnType<typeof useAgentMessages>): string | null {
  const last = messages?.findLast((x) => x.role === "user");

  return last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim() || null;
}

/** "Open as a page": the chat's latest question asked again as an Understand page, which opens. */
function OpenAsPage({ question }: { question: string }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className="cursor-pointer text-[12.5px] text-ash hover:text-bark"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void askUnderstand(monorepo, question.slice(0, 2000), null, { kind: "assistant" })
          .then(async (page) => {
            qc.setQueryData(understandQuery(monorepo, page.number).queryKey, page);
            await navigate(understandLink(monorepo.full, page.number));
          })
          .finally(() => setBusy(false));
      }}
    >
      Open as a page
    </button>
  );
}

/** A chat in the Chats list, in words: what it did, from its state and branch. */
function chatWords(s: AgentSession): string {
  if (s.status === "failed") return "Failed";

  if (s.status === "stopped") return "Stopped";

  if (s.status === "working") return s.branch ? `Working on ${s.branch}` : "Working";

  if (s.branch === null) return "Answered";

  return s.branch_facts?.state === "merged" ? `On ${s.branch}, merged into main` : `On ${s.branch}`;
}

const leafOfChat = (s: AgentSession | undefined): LeafState => (s?.status === "working" ? "thinking" : "idle");

function Chats({ chosen, choose }: { chosen: number | null; choose: (n: number | null) => void }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const [open, setOpen] = useState(false);
  const chats = useQuery({ ...chatsQuery(monorepo), enabled: open }).data ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={`${button("quiet", 30)} gap-1`}>
        Chats
        <Caret />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-30">
          <Popover.Popup className="max-h-[70vh] w-[380px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-rootline bg-pop p-1.5 shadow-pop outline-none">
            {chats.length ? (
              <ul aria-label="Chats" className="grid gap-0.5">
                {chats.map((s) => (
                  <li key={s.number}>
                    <button
                      type="button"
                      aria-current={s.number === chosen ? "true" : undefined}
                      onClick={() => {
                        choose(s.number);
                        setOpen(false);
                      }}
                      className="grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-pop-hi aria-[current]:bg-loam"
                    >
                      <Leaf state={leafOfChat(s)} size={16} />
                      <span className="text-[13.5px] font-semibold text-bark">{dayAndTime(s.created_at, clock)}</span>
                      <span className="col-start-2 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-ash">
                        First message: <span className="text-bark-dim">{s.first_message ?? ""}</span>
                      </span>
                      <span className="col-start-2 text-[12.5px] text-ash">{chatWords(s)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2.5 py-2 text-[13px] text-ash">No chats yet.</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One chat's conversation, live, with the box under it. */
function Chat({ chat }: { chat: AgentSession }) {
  const { monorepo } = useMonorepo();
  const models = useQuery(agentModelsQuery(monorepo)).data ?? [];
  const messages = useAgentMessages(monorepo, chat.number) ?? [];
  const model = models.find((x) => x.id === chat.model)?.name ?? chat.model;
  const items = fromAgent(messages, { person: chat.launched_by, program: "Pi", model, working: chat.status === "working" });
  const { shown, older } = useShownFromEnd(items);
  const asked = lastAsked(messages);

  return (
    <Thread
      items={shown}
      older={older}
      dock={
        <div className="grid gap-2 p-3">
          {asked && chat.status === "waiting" ? <OpenAsPage question={asked} /> : null}
          <Composer placeholder="Ask about this repository" hint={HINT} send={async (text) => void (await sendAgent(monorepo, chat.number, text))} />
        </div>
      }
    >
      <div className="px-4 pt-4">
        <Conversation items={shown} full={monorepo.full} compact />
      </div>
    </Thread>
  );
}

/** The repository's projects, when there is more than one to choose from; else none. */
function useProjects() {
  const { monorepo } = useMonorepo();
  const repos = useQuery(reposQuery(monorepo)).data ?? [];

  return repos.length > 1 ? repos : [];
}

/** The panel's head: the leaf, "Assistant", the repository (and the chat's project) and when the chat started, Chats, New chat and close. */
function Head({ chat, chosen, choose, close }: { chat: AgentSession | undefined; chosen: number | null; choose: (n: number | null) => void; close: () => void }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const project = useProjects().find((r) => r.name === chat?.repo);

  return (
    <header className="flex items-start gap-3 border-b border-rule-faint px-4 py-3.5">
      <Leaf state={leafOfChat(chat)} size={28} />
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold text-bark">Assistant</h2>
        <p className="text-[12.5px] text-ash">
          {monorepo.full}
          {project ? ` · ${project.path}` : ""}
          {chat ? ` · ${dayAndTime(chat.created_at, clock, true)}` : ""}
        </p>
      </div>
      <Chats chosen={chosen} choose={choose} />
      <button type="button" className={button("quiet", 30)} onClick={() => choose(null)}>
        New chat
      </button>
      <button type="button" aria-label="Close" className="grid size-[30px] cursor-pointer place-items-center rounded-md text-[18px] text-ash hover:text-bark" onClick={close}>
        ×
      </button>
    </header>
  );
}

/** A chosen chat: its row live on its own topic, its head and its conversation. */
function ChosenChat({ n, choose, close }: { n: number; choose: (n: number | null) => void; close: () => void }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const live = useRows(monorepo, [`agent:${n}`], () => void qc.invalidateQueries({ queryKey: agentQuery(monorepo, n).queryKey }));
  const chat = useQuery({ ...agentQuery(monorepo, n), refetchInterval: fallback(live) }).data;

  return (
    <>
      <Head chat={chat} chosen={n} choose={choose} close={close} />
      <div className="min-h-0 flex-1">{chat ? <Chat key={n} chat={chat} /> : null}</div>
    </>
  );
}

export function Assistant() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  // A new chat's project: "" is the whole repository.
  const [project, setProject] = useState("");
  const projects = useProjects();

  // Another part of the page may open the panel with a new chat (askAssistant).
  useEffect(() => {
    opener = (prompt, repo) => {
      setOpen(true);
      void newChat(monorepo, prompt, repo).then((s) => {
        qc.setQueryData(agentQuery(monorepo, s.number).queryKey, s);
        void qc.invalidateQueries({ queryKey: chatsQuery(monorepo).queryKey });
        setChosen(s.number);
      });
    };

    return () => {
      opener = null;
    };
  }, [monorepo, qc]);

  if (!me) return null;

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Assistant"
        onClick={() => setOpen(true)}
        className="fixed right-6 bottom-6 z-20 grid size-14 cursor-pointer place-items-center rounded-full border border-rootline bg-pop shadow-pop hover:bg-pop-hi phone:right-4 phone:bottom-4"
      >
        <Leaf state="idle" size={40} />
      </button>
    );
  }

  const close = () => setOpen(false);

  return (
    <aside aria-label="Assistant" className="fixed top-[150px] right-4 bottom-4 z-20 flex w-[420px] flex-col rounded-2xl border border-rootline bg-pop shadow-pop phone:inset-0 phone:w-auto phone:rounded-none">
      {chosen !== null ? (
        <ChosenChat key={chosen} n={chosen} choose={setChosen} close={close} />
      ) : (
        <>
          <Head chat={undefined} chosen={null} choose={setChosen} close={close} />
          <div className="flex min-h-0 flex-1 flex-col">
            <p className="flex-1 px-5 pt-6 text-[14px] leading-[22px] text-bark-dim">Ask about this repository: its code, its issues, its branches. It reads; to change something it asks you to name a branch first.</p>
            <div className="p-3">
              <Composer
                placeholder="Ask about this repository"
                hint={HINT}
                beside={
                  projects.length ? (
                    <Select label="Project" size="small" value={project} onChange={setProject}>
                      <option value="">The repository</option>
                      {projects.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.path}
                        </option>
                      ))}
                    </Select>
                  ) : null
                }
                send={async (text) => {
                  const s = await newChat(monorepo, text, projects.some((r) => r.name === project) ? project : null);

                  qc.setQueryData(agentQuery(monorepo, s.number).queryKey, s);
                  void qc.invalidateQueries({ queryKey: chatsQuery(monorepo).queryKey });
                  setChosen(s.number);
                }}
              />
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
