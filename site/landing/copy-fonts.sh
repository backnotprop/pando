#!/bin/sh
# Apple's SF Pro Text and SF Mono, as the landing page's owner ruling has it: served with the site, never
# committed (public/fonts/ is ignored by git). Copied from the meta layer's landing folder, or PANDO_FONTS_DIR.
# Without them the page falls back to the system's fonts, named in its CSS.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
from="${PANDO_FONTS_DIR:-$here/../../../../../../research/design/pando-2026-10-02/landing/fonts}"
to="$here/public/fonts"
rm -rf "$to"
if [ ! -d "$from" ]; then
  echo "copy-fonts: no fonts at $from; the page uses the system's fonts"
  exit 0
fi
mkdir -p "$to"
for f in SF-Pro-Text-Regular.otf SF-Pro-Text-RegularItalic.otf SF-Pro-Text-Semibold.otf SFNSMono.ttf; do
  cp "$from/$f" "$to/$f"
done
echo "copy-fonts: SF Pro Text and SF Mono copied into public/fonts"
