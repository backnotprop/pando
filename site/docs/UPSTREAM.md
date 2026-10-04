# Upstream: nimbus

This site started as nimbus scaffold output (github.com/cloudflare/nimbus, MIT,
`LICENSE-nimbus.txt`). The scaffold's files are vendored: root `npm run lint`
skips them (`.oxlintrc.json`, ignorePatterns). The files Pando wrote are linted.

## How it was made (2026-10-03)

```sh
npm create @cloudflare/nimbus-docs@0.7.9 -- docs --yes --content empty --deploy cloudflare --package-manager npm --no-git --skip-install
npx @cloudflare/nimbus-docs add api-layout --yes     # the API reference's components (recipe api-reference)
```

- Scaffold: `@cloudflare/create-nimbus-docs` 0.7.9 (templates tag `templates-v0.7.9`).
- Framework: `@cloudflare/nimbus-docs` 0.15.2. `nimbus.json` records both.
- `src/pages/api/[...slug].astro` is the `api-reference` recipe's route, as printed by
  `npx @cloudflare/nimbus-docs add api-reference --print`.

## Vendored, changed by Pando

- `src/layouts/BaseLayout.astro`: always dark (`data-mode="dark"`); the theme script
  and the Inter and JetBrains Mono imports removed.
- `src/components/Header.astro`: Pando's mark beside the title; the theme toggle removed
  (`src/components/ui/theme-toggle/` deleted).
- `src/styles/globals.css`: Pando's colours and fonts (CSS, not linted).
- `public/favicon.svg` (Pando's mark) replaces `public/favicon.ico`.

## Written by Pando (linted)

`astro.config.ts`, `scripts/`, `src/pando.ts`, `src/components.ts`,
`src/content.config.ts`, `src/components/ServiceStatus.astro`,
`src/pages/whats-new.json.ts`, `src/pages/og/_og-card-config.ts`,
`src/styles/sf-fonts.css`, `public/_headers`, `wrangler.jsonc`, and everything
under `src/content/`.

## Upgrading

Follow `AGENT.md`, "Upgrading Nimbus": `npx @cloudflare/nimbus-docs outdated`, then
`diff <file>` for each vendored file. Re-apply the changes listed above.
