# Pando's landing page

gitpando.com. An assets-only Worker, `pando-landing`: `public/index.html` is the
whole page (its CSS, the drawing's scripts and every mark inlined), with
`public/_redirects` sending `/install` and `/install.sh` to the app's install
script at app.gitpando.com. This folder is the page's source. It started as a
copy of the meta layer's `research/design/pando-2026-10-02/landing/index.html`
(2026-10-12), whose `NOTES.md` keeps the design record; edit the page here.

```sh
cd site/landing
../../worker/node_modules/.bin/wrangler dev --port <yours>   # look at it
../../worker/node_modules/.bin/wrangler deploy               # pando-ops only
```

## Fonts

The page names SF Pro Text and SF Mono, with the system's fonts behind them.
Apple's font files are never committed: `copy-fonts.sh` (the Worker's build
step, run by `wrangler dev` and `wrangler deploy`) copies them into
`public/fonts/`, which git ignores, from the meta layer's landing folder or
`PANDO_FONTS_DIR`. Without them the page uses the system's fonts.

## Third-party marks in the page

Nominative use only: unaltered, not recoloured, nothing implying endorsement.

| Mark | Where | Source | Permission |
| --- | --- | --- | --- |
| Cloudflare's cloud | "Built on Cloudflare", at the hub knot | https://www.cloudflare.com/logo.svg, inlined byte for byte (sha256 `3012fc6fa597299f3f799a4ed4b5516b128b0eea31e0782aad08be3c6fd62bf2`) | Written permission from Cloudflare (the Artifacts team), per the owner, 2026-10-03. A copy is to be filed before this repository is public. |
| Claude Code | part 1's tree and part 2's sandbox pane | `claude.svg` from Workspaces' agent artwork (sha256 `c695bcc66f3bfb5ea99593d792a3803aedededf38e402abb188e16194813da27`); vendor page https://brandfolder.com/anthropic/ | Nominative use, owner's choice 2026-10-03 |
| Codex | part 1's tree | `codex.svg`, the same source (sha256 `f83daef841a79bd529460cd03360d8002a9d3ce9d35ca64c63d4b7a59ab21cee`); vendor page https://openai.com/brand/ | Nominative use, owner's choice 2026-10-03 |

Word marks: "Workers®" and "Durable Objects™" carry the symbol at first use,
per Cloudflare's trademark guidelines. The page credits ArtifactFS (Cloudflare,
Apache 2.0) and Oak's open-source FSKit extension (Oakspace Inc., Apache 2.0).
