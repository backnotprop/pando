import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Apple's SF Pro Text (Regular and Semibold), served when the build is asked
 * to (owner: "serve sf pro for now"): PANDO_SF_FONTS=1 copies them in from the
 * landing page's folder in the meta layer (or PANDO_FONTS_DIR) and declares
 * them. They are never committed, and a build without the switch ships no file
 * of Apple's: regular text then falls back to the system's. The monospace is
 * Ioskeley Mono, committed under src/fonts and declared in theme.css.
 */
const SF_FONTS = process.env.PANDO_SF_FONTS === "1";

const FONTS_FROM = process.env.PANDO_FONTS_DIR ?? fileURLToPath(new URL("../../../../../research/design/pando-2026-10-02/landing/fonts", import.meta.url));

const FONTS_TO = fileURLToPath(new URL("public/fonts", import.meta.url));

const FILES = ["SF-Pro-Text-Regular.otf", "SF-Pro-Text-Semibold.otf"];

const FACES = `
@font-face{font-family:"SF Pro Text";src:url("/fonts/SF-Pro-Text-Regular.otf") format("opentype");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"SF Pro Text";src:url("/fonts/SF-Pro-Text-Semibold.otf") format("opentype");font-weight:600;font-style:normal;font-display:swap}`;

function sfFonts(): Plugin {
  return {
    name: "pando-sf-fonts",
    buildStart() {
      // Clear first, so a copy left by an earlier local build never reaches dist.
      rmSync(FONTS_TO, { recursive: true, force: true });

      if (!SF_FONTS) return;

      if (!existsSync(FONTS_FROM)) throw new Error(`PANDO_SF_FONTS=1, but no fonts at ${FONTS_FROM}`);

      mkdirSync(FONTS_TO, { recursive: true });

      for (const f of FILES) copyFileSync(`${FONTS_FROM}/${f}`, `${FONTS_TO}/${f}`);
    },
    transformIndexHtml() {
      if (!SF_FONTS) return [];

      return [
        { tag: "link", attrs: { rel: "preload", href: "/fonts/SF-Pro-Text-Regular.otf", as: "font", type: "font/otf", crossorigin: "" }, injectTo: "head" },
        { tag: "style", children: FACES, injectTo: "head" },
      ];
    },
  };
}

// `npm run dev` serves the app here and sends the API to a local `wrangler dev`
// (PANDO_DEV_WORKER). Writes and sockets must carry the Worker's own Origin.
const worker = process.env.PANDO_DEV_WORKER ?? "http://localhost:8871";

export default defineConfig({
  // The colour worker (Colour.tsx, @pierre/diffs) splits into chunks, which needs module workers.
  worker: { format: "es" },
  plugins: [sfFonts(), tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    proxy: {
      "/v1": { target: worker, ws: true, changeOrigin: true, headers: { origin: worker } },
    },
  },
});
