# Understand: brief (pe-design, brief mode)

2026-10-14, understand lane. Replaces the look in understand.html (owner:
"too messy, AI slop design"). The server design in DESIGN.md stands.
Assumptions the owner has not confirmed are marked (assumed).

## 1. Job and audience

A member of a repository reading code they did not write, or wrote weeks ago
through an agent. They are mid-review (Files changed, a commit) or mid-chat
(the assistant), and they hit something they do not understand: "why is this
100?". Mode: **read**. They want the reason, with proof, and to go back to
what they were doing.

## 2. Outcome and proof

One action ("Why?" on lines, on a commit, or "Open as a page" in the
assistant) gives a page that answers in a few sentences, and the sentences
are built out of the records themselves: the commit that wrote the lines
(person, machine, agent, model), the turn of the recorded session that
wrote them (the prompt, the step), the decision file in the shared files
(its words), the issue. What is uniquely true in Pando: the sessions and the
meta layer live with the code, so the "why" is a chain of real records, not
a model's guess. If no record explains the lines, the page says so and does
not guess.

## 3. Selected direction

**Established world: inherit Pando's web (web/DESIGN.md).** No new palette,
type, radius or component family. A section inside an established product.

Structural thesis: **an essay with exhibits.** One column. The question is
the title. The answer is prose. Each record the prose cites is shown right
after the sentence that cites it, as the record itself, drawn with Pando's
existing faces:

- a commit is its commit line (avatar, title, short sha, a sentence: who,
  from which machine, with which agent and model);
- a session turn is the conversation's own prompt (Loam, avatar, "Prompt
  7", time) followed by the folded step that wrote the file, exactly as the
  Sessions tab draws them;
- a shared file is its words, set as a quoted document fragment with its
  path and version on one quiet line;
- an issue is its `IssueRef` and title.

The citation is the record: no numbered chips, no source list. Cited text in
the prose is a Link (the file, the commit id, the issue), so the reader can
see what each sentence rests on.

Focal moment: the paragraph where the person's prompt appears under the
sentence "Ana asked for exactly this in a Claude Code session". The reason
for the code, in the words of the person who caused it.

Sequence: title, one quiet line (who asked, about what, who answered), the
lines asked about, the answer with its exhibits, a follow-up input. "How
this was found" is folded at the end.

## 4. Scope and boundaries

- Fidelity: a static mockup, dark and light, three states (building,
  complete, nothing found), desktop and phone width.
- Untouched: the top bar, the branch and commit pages, the conversation
  component's look.
- Anti-goals: a dashboard; section labels on everything; badges, pills,
  numbered citation chips; a sources rail; coloured callout boxes; a timing
  table; a lineage drawn as boxes and arrows; the model's words dressed as
  records.

## 5. States and ranges

- Complete: 1 to 4 paragraphs, 2 to 6 records; a record is cited once and
  shown once (a second cite is a link to it).
- Building: real progress only, as one line under the title ("Reading the
  blame of these lines", "Searching the shared files"); records found so far
  appear in the order found, under one sentence saying the answer is being
  written. Nothing the reader has read moves.
- Nothing found: the server's sentence ("No record explains these lines"),
  the facts it checked in one more sentence, the one commit it did find, and
  one action: ask the assistant to explain what the code does.
- Failed: the session's reason in one sentence, what was found kept.
- Ranges: a prompt can be long (clamp to 6 lines with "Show all"); a file
  excerpt is at most 16 lines; a question is at most 2,000 characters
  (titles clamp at 3 lines, assumed).

## 6. Interaction and layout

- Reading column about 680 px for prose; code and exhibits use the same
  column (assumed: one width keeps it calm).
- Disagreement between code and a record is one sentence in the answer
  ("One thing does not match: ..."), not a box.
- Follow-up: one input under the answer, the asker's only; the page updates
  in place and the changed paragraph is marked by Foxfire arriving.
- "How this was found": a disclosure with one line per lookup, in words.
- Copy link: one quiet button at the top right.
- Phone: the same column; code scrolls inside its box.

## 7. Constraints and open decisions

- Every record face is filled by the server (the honesty rule); the model's
  prose is labelled by its model in the line under the title.
- Accessibility: the cited records are articles named by what they are;
  progress is a polite live region announcing only "Answer ready".
- Open (assumed for now): the title for a line question is "Why are lines
  12 to 18 of src/limit.ts the way they are?"; a free question keeps the
  person's words.
