// Apple's SF Pro Text for regular text, served only when the build is asked
// to, the same switch as the web app's (web/vite.config.ts): PANDO_SF_FONTS=1
// copies it in from the landing page's folder in the meta layer (or
// PANDO_FONTS_DIR) and declares it on every page. It is never committed, and a
// build without the switch ships no file of Apple's: regular text then falls
// back to the system's.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

const SF_FONTS = process.env.PANDO_SF_FONTS === "1";

const FONTS_FROM =
  process.env.PANDO_FONTS_DIR ?? fileURLToPath(new URL("../../../../../../../research/design/pando-2026-10-02/landing/fonts", import.meta.url));

/** Gitignored; served at /fonts/sf/ and declared by src/styles/sf-fonts.css. */
const FONTS_TO = fileURLToPath(new URL("../public/fonts/sf", import.meta.url));

const FILES = ["SF-Pro-Text-Regular.otf", "SF-Pro-Text-Semibold.otf"];

export function sfFonts(): AstroIntegration {
  return {
    name: "pando-sf-fonts",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        // Clear first, so a copy left by an earlier local build never reaches dist.
        rmSync(FONTS_TO, { recursive: true, force: true });

        if (!SF_FONTS) return;

        if (!existsSync(FONTS_FROM)) throw new Error(`PANDO_SF_FONTS=1, but no fonts at ${FONTS_FROM}`);

        mkdirSync(FONTS_TO, { recursive: true });

        for (const f of FILES) copyFileSync(`${FONTS_FROM}/${f}`, `${FONTS_TO}/${f}`);

        injectScript("page-ssr", 'import "@/styles/sf-fonts.css";');
      },
    },
  };
}
