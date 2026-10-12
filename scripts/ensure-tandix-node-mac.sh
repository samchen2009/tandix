#!/bin/bash
# Print a supported Node executable. Download a pinned official runtime only if needed.
set -euo pipefail

valid_node() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit((major===22&&minor>=19)||major>=24?0:1)' >/dev/null 2>&1
}

if command -v node >/dev/null 2>&1 && valid_node "$(command -v node)"; then
  command -v node
  exit 0
fi

machine="$(uname -m)"
if [ "$machine" = x86_64 ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then machine=arm64; fi
case "$machine" in
  arm64) arch=arm64; expected=6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe ;;
  x86_64) arch=x64; expected=0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299 ;;
  *) printf 'Unsupported macOS architecture.\n' >&2; exit 1 ;;
esac
version=24.21.0
target="${HOME}/.tandix/codex-client/runtime/node-v${version}-darwin-${arch}"
if [ -x "$target/bin/node" ] && valid_node "$target/bin/node"; then
  printf '%s\n' "$target/bin/node"
  exit 0
fi

package_root="$(cd "$(dirname "$0")/.." && pwd)"
bundled="$package_root/runtime/node-mac-${arch}"
if [ -x "$bundled/bin/node" ] && valid_node "$bundled/bin/node"; then
  if [ -e "$target" ]; then
    printf 'Existing Node runtime is invalid: %s\n' "$target" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$target")"
  stage="${target}.install.$$"
  mkdir -p "$stage/bin"
  cp "$bundled/bin/node" "$stage/bin/node"
  cp "$bundled/LICENSE" "$stage/LICENSE"
  mv -n "$stage" "$target"
  if [ -e "$stage" ]; then rm -rf -- "$stage"; fi
  valid_node "$target/bin/node" || { printf 'Bundled Node runtime did not start.\n' >&2; exit 1; }
  printf '%s\n' "$target/bin/node"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/tandix-node.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
archive="node-v${version}-darwin-${arch}.tar.xz"
printf 'Downloading official Node.js %s for macOS %s...\n' "$version" "$arch" >&2
curl -fL --retry 2 "https://nodejs.org/dist/v${version}/${archive}" -o "$work/$archive"
printf '%s  %s\n' "$expected" "$work/$archive" | shasum -a 256 -c - >&2
tar -xJf "$work/$archive" -C "$work"
mkdir -p "$(dirname "$target")"
if [ -e "$target" ]; then
  printf 'Existing Node runtime is invalid: %s\n' "$target" >&2
  exit 1
fi
mv "$work/node-v${version}-darwin-${arch}" "$target"
valid_node "$target/bin/node" || { printf 'Downloaded Node runtime did not start.\n' >&2; exit 1; }
printf '%s\n' "$target/bin/node"
