// The records an Understand page shows, each with the face it has elsewhere in
// Pando (docs/understand/BRIEF.md, "Selected direction"), every fact from the
// server's card, none from the model:
//   - a commit: its line (avatar, title, short sha) and one sentence of who made
//     it, from which machine, with which agent and model, and when;
//   - a recorded session's turn: the conversation's own prompt (Loam, avatar,
//     "Prompt 7", time), then the folded step that wrote the file;
//   - a shared file: its path, version and who saved it on one line, then its
//     words, in the code view's ring;
//   - a Cloudflare-run agent session: one line, as an Agents row says it;
//   - an issue: a link in the prose only (the decision usually quotes it).
// In the prose a cite [r3] is drawn as its record's name: a commit's short
// sha, a file's path, an issue's number and title, a session's prompt.
import type { UnderstandPage, UnderstandRef } from "@pando/contract";
import type { ReactNode } from "react";
import { AgentMark, PROGRAM_NAME, type Program } from "../../../../ui/AgentMark";
import { Avatar } from "../../../../ui/Avatar";
import { Chevron } from "../../../../ui/Icons";
import { IssueRef, Ref } from "../../../../ui/Ref";
import { agentLink, blobLink, commitLink, sessionLink } from "../../../../ui/paths";
import { clock } from "../../../../ui/time";

/** What a record needs to link: the monorepo, and a project's path by its name. */
export interface Names {
  full: string;
  repoPath: (repo: string) => string;
}

type Card = NonNullable<UnderstandRef["card"]>;

const short = (sha: string) => sha.slice(0, 7);

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "Oct 9". */
export const onDay = (iso: string) => monthDay.format(new Date(iso));

const PROGRAMS = new Set(Object.keys(PROGRAM_NAME));

const isProgram = (s: string | null | undefined): s is Program => !!s && PROGRAMS.has(s);

/** A person as a card names them: their login, else the name before the email. */
const personOf = (saved: string, login: string | null) => login ?? saved.replace(/\s*<[^>]*>\s*$/, "");

/** The session a commit names, when the page has it: its program, for the commit's agent mark. */
function programOf(page: UnderstandPage, card: Extract<Card, { kind: "commit" }>): Program | null {
  const s = page.refs.find((r) => r.card?.kind === "session" && card.sessions.includes(r.card.id))?.card;

  if (s?.kind === "session") return s.program;

  return isProgram(card.agent) ? card.agent : null;
}

/** A cite in the prose: the record's name, linking to its page. */
function Cite({ ref_, names }: { ref_: UnderstandRef | undefined; names: Names }) {
  const card = ref_?.card;

  if (!card) return <span className="text-ash">(a source that is gone)</span>;

  switch (card.kind) {
    case "commit":
      return (
        <Ref kind="object" mono text link={commitLink(names.full, names.repoPath(card.repo), card.sha)}>
          {short(card.sha)}
        </Ref>
      );
    case "session":
      return (
        <Ref kind="object" text link={sessionLink(names.full, card.id)}>
          {card.prompt ? `prompt ${card.prompt.number} of ${card.person}'s ${PROGRAM_NAME[card.program]} session` : `${card.person}'s ${PROGRAM_NAME[card.program]} session`}
        </Ref>
      );
    case "meta":
      return (
        <Ref kind="object" mono text link={blobLink(names.full, card.path, card.version)}>
          {card.path}
        </Ref>
      );
    case "issue":
      return (
        <>
          <IssueRef full={names.full} number={card.number} state={card.state === "closed" ? "closed" : "open"} text /> <span>{card.title}</span>
        </>
      );
    case "agent":
      return (
        <Ref kind="object" text link={agentLink(names.full, card.number)}>
          agent session #{card.number}
        </Ref>
      );
  }
}

/** A paragraph's text with each [rN] drawn as its record's name. */
export function Prose({ text, page, names }: { text: string; page: UnderstandPage; names: Names }) {
  const byId = new Map(page.refs.map((r) => [r.id, r]));
  const parts = text.split(/(\[r[1-9][0-9]{0,2}\])/g);

  return parts.map((p, i) => {
    const m = /^\[(r[0-9]+)\]$/.exec(p);

    return m?.[1] ? <Cite key={i} ref_={byId.get(m[1])} names={names} /> : <span key={i}>{p}</span>;
  });
}

function CommitLine({ card, page, names }: { card: Extract<Card, { kind: "commit" }>; page: UnderstandPage; names: Names }) {
  const who = card.person ?? card.author.name;
  const program = programOf(page, card);
  const made: ReactNode[] = [];

  if (card.machine) made.push(` from ${card.machine}`);

  if (program || card.model) {
    made.push(
      <span key="with">
        {" "}
        with{" "}
        {program ? (
          <>
            <AgentMark program={program} size={13} className="mr-1 inline-block align-[-2px]" />
            {PROGRAM_NAME[program]}
          </>
        ) : null}
        {program && card.model ? " and " : ""}
        {card.model ?? ""}
      </span>,
    );
  }

  const bare = !card.sessions.length && !card.agent && !card.machine;

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0.5">
      <Avatar name={who} size={20} />
      <span className="min-w-0 text-[14px] text-bark">
        {card.title || "(no message)"}{" "}
        <Ref kind="object" mono link={commitLink(names.full, names.repoPath(card.repo), card.sha)} className="!text-ash hover:!text-link">
          {short(card.sha)}
        </Ref>
      </span>
      <span className="col-start-2 text-[13px] text-ash">
        {who} committed{made} on {onDay(card.committed_at)}.{bare ? " No session or agent is recorded on it." : ""}
      </span>
    </div>
  );
}

function SessionTurn({ card, names }: { card: Extract<Card, { kind: "session" }>; names: Names }) {
  const p = card.prompt;

  return (
    <>
      {p ? (
        <div className="grid gap-1.5 rounded-xl bg-loam px-3.5 py-3">
          <p className="flex items-center gap-2 text-[12.5px] text-ash">
            <Avatar name={card.person} size={18} />
            <span className="text-[13px] text-bark">{card.person}</span>
            <Ref kind="object" text link={sessionLink(names.full, card.id)}>
              Prompt {p.number}
            </Ref>
            {p.at ? (
              <span className="ml-auto">
                {onDay(p.at)}, {clock(p.at)}
              </span>
            ) : null}
          </p>
          <div className="line-clamp-6 text-[15px] leading-[23px] whitespace-pre-wrap text-bark">{p.text}</div>
        </div>
      ) : (
        <p className="text-[13px] text-ash">
          <Ref kind="object" text link={sessionLink(names.full, card.id)}>
            {card.person}'s {PROGRAM_NAME[card.program]} session
          </Ref>{" "}
          on {card.machine}. No prompt of it is recorded before the commit.
        </p>
      )}
      {card.step ? (
        <p className="flex min-w-0 items-center gap-[7px] pl-0.5 text-[13px] leading-5 text-ash">
          <Chevron className="size-3 flex-none -rotate-90 opacity-70" />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {card.step.tool.charAt(0).toUpperCase() + card.step.tool.slice(1)} <code className="text-[12.5px] text-bark-dim">{card.step.input}</code>
          </span>
          {card.step.at ? <span className="ml-auto pl-3 text-[12px] whitespace-nowrap">{clock(card.step.at)}</span> : null}
        </p>
      ) : p?.why === "before" ? (
        <p className="pl-0.5 text-[13px] text-ash">No step of this session names the file: this is its last prompt before the commit.</p>
      ) : null}
    </>
  );
}

/** A shared file's excerpt: a heading line (#) set as a heading, the rest as paragraphs, as the file's words read. */
function Excerpt({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  return blocks.map((b, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(b);

    return h && !b.includes("\n") ? (
      <h4 key={i} className="text-[14px] font-semibold text-bark">
        {h[1]}
      </h4>
    ) : (
      <p key={i} className="max-w-[65ch] text-[14px] leading-[22px] whitespace-pre-line text-doc">
        {b}
      </p>
    );
  });
}

function SharedFile({ card, names }: { card: Extract<Card, { kind: "meta" }>; names: Names }) {
  return (
    <div className="grid gap-2 rounded-[10px] px-4 pt-3 pb-3.5 shadow-[0_0_0_1px_var(--rootline)]">
      <p className="text-[13px] text-ash">
        <Ref kind="object" mono text link={blobLink(names.full, card.path, card.version)}>
          {card.path}
        </Ref>
        , version {card.version}, saved by {personOf(card.saved_by, card.login)} from {card.machine} on {onDay(card.saved_at)}
      </p>
      {card.excerpt ? <Excerpt text={card.excerpt.text} /> : null}
    </div>
  );
}

/** One record, under the paragraph that first cites it; a gone one says so. */
export function Record({ ref_, page, names }: { ref_: UnderstandRef; page: UnderstandPage; names: Names }) {
  const card = ref_.card;
  const label = !card ? "A source that is gone" : card.kind === "commit" ? `Commit ${short(card.sha)}` : card.kind === "session" ? `${card.person}'s session` : card.kind === "meta" ? card.path : card.kind === "agent" ? `Agent session ${card.number}` : `Issue ${card.number}`;

  return (
    <section id={`source-${ref_.id}`} aria-label={label} className="grid scroll-mt-20 gap-2.5">
      {!card ? <p className="text-[13px] text-ash">{ref_.gone ?? "This source is gone."}</p> : null}
      {card?.kind === "commit" ? <CommitLine card={card} page={page} names={names} /> : null}
      {card?.kind === "session" ? <SessionTurn card={card} names={names} /> : null}
      {card?.kind === "meta" ? <SharedFile card={card} names={names} /> : null}
      {card?.kind === "agent" ? (
        <p className="text-[13px] text-ash">
          <Ref kind="object" text link={agentLink(names.full, card.number)}>
            Agent session #{card.number}
          </Ref>{" "}
          ({card.agent_kind}), launched by {card.launched_by}, {card.model}
          {card.branch ? (
            <>
              , on <code className="text-[12.5px]">{card.branch}</code>
            </>
          ) : null}
          .
        </p>
      ) : null}
    </section>
  );
}
