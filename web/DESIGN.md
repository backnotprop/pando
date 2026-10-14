---
name: Pando web
description: Pando's web app. Quiet, text-led pages for a git platform; one ground, rules instead of boxes, link colour for what a line is about.
colors:
  soil: "#0c0f0c"
  air: "#121614"
  loam: "#1a1f18"
  rootline: "#262a24"
  bark: "#e6e0d1"
  bark-dim: "#ada899"
  ash: "#7e8476"
  clay: "#9a7b5e"
  fox: "#c4e86f"
  rust: "#e07a5f"
  link: "oklch(0.78 0.08 243)"
typography:
  body:
    fontFamily: "SF Pro Text, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  title:
    fontFamily: "SF Pro Text, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: "32px"
  section:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  reading:
    fontSize: "15px"
    lineHeight: "24px"
  code:
    fontFamily: "Ioskeley Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
rounded:
  field: "7px"
  box: "10px"
  prompt: "12px"
spacing:
  margin: "48px"
  margin-phone: "16px"
  column: "1296px"
---

# Design System

Written 2026-10-14 by the understand lane from the code (web/src/theme.css,
ui/controls.tsx, ui/Ref.tsx, ui/pages.tsx, conversation/Conversation.tsx,
-project/Commit.tsx, -project/FilesChanged.tsx) and the approved mocks
(research/design/pando-ui-2026-10-03/mocks/SCREENS.md, "Visual rules"). It
records what is built; it decides nothing new.

## Overview

Text first, on one ground. A page is a title, a line or two of plain
sentences about the thing ("files-changed into main. 2 commits by ramos."),
then its content. Hierarchy comes from type weight and the three text
colours, not from boxes. Few containers: a code view, a command box, a
person's prompt. Motion is one thing only: an arrival (Foxfire for a moment).

## Colors

Tokens in web/src/theme.css, named after soil (Pando's own names). Themes
reassign the same tokens (Pando dark is `:root`; `pando-light` is Daylight;
also Cloudflare, Plannotator, Iris, Black Rainbow).

- Ground: Soil (page), Air (raised fields), Loam (a prompt, a selected row, a
  command's copy button). Rootline is every rule and border.
- Text: Bark (what matters), Bark-dim (sentences about it), Ash (times,
  counts, provenance). Doc is the colour of an agent's or a document's prose.
- Link: the thing a line is about (a branch, an issue, a file). In running
  text it keeps a faint underline in its own colour.
- Foxfire: a change arriving, and nothing else; it fades. By day it is a
  highlighter fill behind ink.
- Rust: failures and conflicts only. Clay: annotations (forced merges).
- Passing checks are not green: a check mark in the text colour.

## Typography

SF Pro Text for everything people read, with tabular figures; mono
(Ioskeley Mono, SF Mono in development) only for code, commit ids, versions,
branch names and commands (the mono ruling). Page title 26/32, regular
weight, tracking -0.018em, balanced, at most 28em wide. Section heads 14/20
semibold, sentence case, with an optional count in Ash. Body 14/20; reading
prose (an agent's answer, a prompt) 15/24. Small facts 12.5 to 13 px in Ash.
No uppercase labels, no letter-spaced eyebrows.

## Layout

`Page`: the top bar (a breadcrumb path), then one column up to 1296 px with
48 px margins (16 on a phone). Pages that read (a commit) put the content
in a column with an optional 340 px side column for status (checks).
Breakpoints: narrow at 1100 px (side columns fold under), phone at 640 px.

## Elevation & Depth

Flat. Depth is tone: Loam on Soil for a person's prompt or a selected row;
menus and popovers take Pop with a soft shadow (`--shadow-pop`). Code views
draw a 1 px Rootline ring with a 10 px radius.

## Shapes

Radii 7 px for fields and buttons, 10 px for code views and boxes, 12 px for
a prompt in a conversation. People are round avatars; a monorepo is a
rounded square.

## Components

- `Title`, `SectionHead`, `Lnk` (the quiet underlined action), `button`
  (solid for the one thing to do, quiet outlined, danger in Rust), `field`.
- `Ref`: name, object, person links (ui/Ref.tsx); `IssueRef` with its state
  glyph.
- The conversation (conversation/Conversation.tsx), one component for
  agents, the assistant and recorded sessions: a person's prompt on Loam
  with avatar, name, "Prompt N" and its time; the agent's prose in Doc; tool
  steps folded into quiet lines with a chevron ("Edit src/limit.ts"), each
  with its time; a by-line "pi, glm-5.3-flash" once per turn.
- Code: Pierre's diffs view (FileView, DiffList) with Pando's syntax tokens.
- AgentMark: the agent program's mark in the text colour, 13 to 14 px.

## Do's and Don'ts

- Do write the facts as sentences (who, where, when), not as label:value
  chips.
- Do keep one ground; reach for Loam only for a person's words or a choice.
- Don't colour status except Rust for failure and Foxfire for arrival.
- Don't use uppercase labels, pills, coloured side bars or numbered badges.
- Don't show a first prompt as "what was asked" (sessions ruling).
- Don't use mono for prose or for labels.
