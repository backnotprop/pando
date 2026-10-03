// Render the Pando app icon PNGs (AppIcon.appiconset) and the window's
// lockup image (Lockup.imageset) into ../HostApp/Assets.xcassets.
//
//   node mac/Icon/render.mjs
//
// The same approach as the brand's _tools/shoot.mjs (Playwright driving
// headless Google Chrome), with a transparent background so the icon's
// corners and shadow keep their alpha. 16 and 32 px use the solid cut
// (icon-small.html); 64 px and up use the contour cut (icon.html), as the
// brand notes say. PANDO_PLAYWRIGHT_DIR points at a folder whose
// node_modules holds playwright-core; it defaults to the brand's _tools.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = process.env.PANDO_PLAYWRIGHT_DIR
  ?? '/Users/ramos/pando/research/design/pando-2026-10-02/art-ops-brand/pando-brand/_tools';
const { chromium } = createRequire(path.join(toolsDir, 'noop.js'))('playwright-core');
const assets = path.join(here, '..', 'HostApp', 'Assets.xcassets');
const icon = (size) => path.join(assets, 'AppIcon.appiconset', `icon_${size}.png`);
const lockup = (scale) => path.join(assets, 'Lockup.imageset', `lockup@${scale}x.png`);

// [page, CSS width, CSS height, device scale, output]
const jobs = [
  ['icon-small.html', 16, 16, 1, icon(16)], ['icon-small.html', 32, 32, 1, icon(32)],
  ...[64, 128, 256, 512, 1024].map((s) => ['icon.html', s, s, 1, icon(s)]),
  // the window header shows the lockup at 170 x 42 points
  ['lockup.html', 170, 42, 1, lockup(1)], ['lockup.html', 170, 42, 2, lockup(2)],
];

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const errors = [];
for (const [file, width, height, scale, dest] of jobs) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(here, file)).href);
  await page.waitForTimeout(100);
  await page.screenshot({ path: dest, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log(dest);
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
