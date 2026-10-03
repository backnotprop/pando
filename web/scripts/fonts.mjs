// Copies SF Pro Text and SF Mono into public/fonts for the build. Apple's font
// files never go in the repo (owner ruling): they come from the landing page's
// folder in the meta layer, or from PANDO_FONTS_DIR. Without them the app
// falls back to the system font stack.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));

const source = process.env.PANDO_FONTS_DIR ?? join(here, "../../../../../research/design/pando-2026-10-02/landing/fonts");

const files = ["SF-Pro-Text-Regular.otf", "SF-Pro-Text-Semibold.otf", "SFNSMono.ttf"];

const target = join(here, "public/fonts");

if (!files.every((f) => existsSync(join(source, f)))) {
  console.warn(`fonts: SF fonts not found in ${source}; the app uses the system font stack`);
} else {
  mkdirSync(target, { recursive: true });

  for (const f of files) copyFileSync(join(source, f), join(target, f));
  console.log(`fonts: copied ${files.length} files to public/fonts`);
}
