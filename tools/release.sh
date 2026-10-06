#!/bin/bash
# Pando releasing Pando: build the `pando` CLI for macOS and Linux (Apple
# chips and Intel, ARM and AMD) from a commit on main, and publish them as a
# release of Pando's own code on Pando, with notes written from the branches
# merged since the last release.
#
#   tools/release.sh <tag> [--draft] [--force]
#
# Run it on a Mac (the macOS files use Apple's FSEvents through cgo, so they
# are built here; the Linux files are cross-compiled with cgo off), from a
# clean checkout of a commit already on main, signed in with `pando login`.
# PANDO_RELEASE_MONOREPO (default ramos/pando) and PANDO_RELEASE_REPO
# (default projects/pando) say where Pando's code lives on the server.
#
# It runs no git with credentials (pando talks to the API itself), and git
# here reads no system config (no keychain helper).
set -euo pipefail
export GIT_CONFIG_NOSYSTEM=1

usage() { echo "usage: tools/release.sh <tag> [--draft] [--force]" >&2; exit 2; }
[ $# -ge 1 ] || usage
TAG=$1; shift
EXTRA=()
for a in "$@"; do
  case $a in --draft|--force) EXTRA+=("$a") ;; *) usage ;; esac
done

MONO=${PANDO_RELEASE_MONOREPO:-ramos/pando}
REPO=${PANDO_RELEASE_REPO:-projects/pando}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

command -v pando >/dev/null || { echo "pando is not on PATH" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || { echo "run this on a Mac: the macOS files need cgo (FSEvents)" >&2; exit 1; }
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "the checkout has changes; release a clean commit" >&2; exit 1; }
SHA=$(git -C "$ROOT" rev-parse HEAD)

DIST=$(mktemp -d "${TMPDIR:-/tmp}/pando-release-XXXXXX")
trap 'rm -rf "$DIST"' EXIT

echo "Building pando at ${SHA:0:12} into $DIST"
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
  os=${target%/*}; arch=${target#*/}
  cgo=0; [ "$os" = darwin ] && cgo=1
  (cd "$ROOT/cli" && CGO_ENABLED=$cgo GOOS=$os GOARCH=$arch go build -buildvcs=false -trimpath -ldflags "-s -w" -o "$DIST/pando-$os-$arch" ./cmd/pando)
  echo "  pando-$os-$arch  $(stat -f %z "$DIST/pando-$os-$arch") bytes"
done
(cd "$DIST" && shasum -a 256 pando-* > SHA256SUMS)

# The server refuses a commit that is not on main, and (without --force) one whose required checks are not green.
# The release is made as a draft, its five files uploaded, then published (pando release create does all three).
pando release create "$TAG" "$DIST"/pando-darwin-arm64 "$DIST"/pando-darwin-amd64 "$DIST"/pando-linux-arm64 "$DIST"/pando-linux-amd64 "$DIST"/SHA256SUMS \
  --target "$SHA" --generate --monorepo "$MONO" --repo "$REPO" ${EXTRA[@]+"${EXTRA[@]}"}
pando release view "$TAG" --monorepo "$MONO" --repo "$REPO"
