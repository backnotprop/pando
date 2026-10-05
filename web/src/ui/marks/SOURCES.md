# Agent marks

The coding agents' own marks, shown beside a recorded session and on a person's graph (owner, 2026-10-04: "we're using
the logos. They all come from open source tooling and it's fine"). The files are unchanged; `AgentMark.tsx` draws each
as a mask in one colour, and redraws Pi's in its own three colours.

| File | Agent | Source | SHA-256 |
| --- | --- | --- | --- |
| `claude.svg` | Claude Code | Anthropic's mark, https://brandfolder.com/anthropic/ ; drawn in Claude's terracotta, about `#D97757` | `c695bcc66f3bfb5ea99593d792a3803aedededf38e402abb188e16194813da27` |
| `codex.svg` | Codex | OpenAI's mark, https://openai.com/brand/ ; drawn in the text colour | `f83daef841a79bd529460cd03360d8002a9d3ce9d35ca64c63d4b7a59ab21cee` |
| `pi.svg` | Pi | Pi's logo, https://pi.dev/ ; redrawn as its ten cells in its own colours, coral `rgb(228,138,122)`, blue `rgb(79,142,179)` and yellow `rgb(234,182,93)`, from Pi's source (`packages/coding-agent/src/modes/interactive/components/pi-logo.ts`, github.com/earendil-works/pi) | `46833e52253f7c6e1e99791a7c248b08c7e8521d884e42360b6c112639c152ef` |
| `opencode.svg` | OpenCode | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/asset/brand/opencode-logo-light.svg ; drawn in the text colour | `508b5f775938a3de69b1872a808ca527ad3722511c7daea5e4e6f80a32ccab3f` |
| `customagent.svg` | any other agent | a generic agent glyph | `6cd72bda4d73d485df22b24d6403349eb46ba9b03fecc504a134583ea8b8f9bd` |

The marks are their owners' trademarks. Showing them does not mean that their owners endorse Pando.
