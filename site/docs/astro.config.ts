// Pando's docs: nimbus (github.com/cloudflare/nimbus), built static and
// deployed as the assets-only Worker pando-docs (wrangler.jsonc).
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { sfFonts } from "./scripts/sf-fonts.ts";

const nimbusConfig = defineNimbusConfig({
  // The docs site's own address: canonical URLs, the sitemap, llms.txt and
  // the What's new link. docs.<domain> once the domain is bought.
  site: "https://pando-docs.plannotator.workers.dev",
  title: "Pando",
  description: "A git platform for monorepos, built on Cloudflare Workers and Artifacts, for many agents working at once.",
  locale: "en",
  github: null,
  socialImageAlt: "Pando documentation",
  // The API reference, generated from the contract the Worker serves.
  api: [{ collection: "api", label: "Pando API", spec: "../../docs/contracts/api-v1.yaml" }],
  sidebar: {
    items: [{ autogenerate: { collection: "docs" } }, { label: "API reference", link: "/api" }],
  },
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    sfFonts(),
    nimbus(nimbusConfig, {
      // A page whose frontmatter does not validate, or a link to a page the
      // build did not make, fails `npm run check`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
