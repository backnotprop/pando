// The one-line install: GET /install (and /install.sh) answers a shell script that downloads `pando` for this
// machine from the latest release of Pando's own code on this server, checks it against the release's
// SHA256SUMS, and puts it at ~/.local/bin/pando. gitpando.com/install redirects here (site/landing/public/_redirects).
//   curl -fsSL https://gitpando.com/install | sh

/** Where Pando's own releases live on this server (tools/release.sh: ramos/pando, projects/pando). */
const RELEASES = "/v1/monorepos/ramos/pando/repos/projects-pando/releases/latest/files";

export const isInstallPath = (pathname: string): boolean => pathname === "/install" || pathname === "/install.sh";

/** The script, for the server at `origin` (its own address: app.gitpando.com, or a dev server). */
export function installScript(origin: string): string {
  return `#!/bin/sh
# Installs pando, Pando's command line, from the latest release of Pando's code on ${origin}.
#   curl -fsSL ${origin}/install | sh
# It picks the file for this machine (macOS or Linux, arm64 or amd64), checks its SHA-256 against the
# release's SHA256SUMS, and puts it at ~/.local/bin/pando (PANDO_INSTALL_DIR changes the folder).
# PANDO_INSTALL_FROM names another release's files address (tests and self-hosted servers).
set -eu

server='${origin}'
files="\${PANDO_INSTALL_FROM:-$server${RELEASES}}"
dir="\${PANDO_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "pando install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "there is no pando build for $(uname -s); build it from source: $server/docs/get-started/" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) fail "there is no pando build for $(uname -m); build it from source: $server/docs/get-started/" ;;
esac
name="pando-$os-$arch"

command -v curl >/dev/null 2>&1 || fail "curl is needed"
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is needed to check the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $name from the latest release"
curl -fsSL -o "$tmp/$name" "$files/$name" || fail "could not download $files/$name"
curl -fsSL -o "$tmp/SHA256SUMS" "$files/SHA256SUMS" || fail "could not download $files/SHA256SUMS"
want="$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || fail "SHA256SUMS lists no $name; nothing installed"
got="$(sum "$tmp/$name")"
[ "$got" = "$want" ] || fail "$name does not match its SHA-256 in SHA256SUMS ($got, not $want); nothing installed"

mkdir -p "$dir"
chmod 755 "$tmp/$name"
mv -f "$tmp/$name" "$dir/pando"
echo "Installed pando at $dir/pando (SHA-256 $got)"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir is not on your PATH. Add it, for example: export PATH=\\"$dir:\\$PATH\\"" ;;
esac
echo
echo "Next, sign in:"
echo "  pando login --server $server"
`;
}

/** GET or HEAD /install: the script, readable in a browser as plain text. */
export function install(request: Request): Response {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" };

  return new Response(request.method === "HEAD" ? null : installScript(new URL(request.url).origin), { headers });
}
