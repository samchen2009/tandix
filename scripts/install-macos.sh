#!/bin/bash
# Standalone, clone-free source installer for macOS. No global pnpm install.
set -euo pipefail

if [ "${1:-}" = --help ]; then
  printf 'Usage: bash install-macos.sh\nRequires Chrome and Node.js 22.19+ or 24+ (with npm).\nDownloads Tandix source from GitHub and builds it using pnpm 11.7.0.\n'
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf 'Usage: bash install-macos.sh [--help]\n' >&2
  exit 1
fi
if [ "$(uname -s)" != Darwin ]; then
  printf 'This installer is for macOS. On Windows use install-windows.ps1.\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 ||
    ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit((major===22&&minor>=19)||major>=24?0:1)' >/dev/null 2>&1; then
  printf 'Install Node.js 22.19+ or 24+ with npm, reopen Terminal, then retry: https://nodejs.org/en/download\n' >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/tandix-source.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
installer="$work/install.sh"
printf 'Downloading the Tandix source installer from GitHub...\n'
curl -fL --retry 2 --connect-timeout 15 \
  'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install.sh' -o "$installer"
# npm provides the pinned pnpm only to the child process, without changing global tools.
npm exec --yes --package=pnpm@11.7.0 -- /bin/bash "$installer"

printf '\nTo start dsh, keep this command running:\n  cd %q\n  npm exec --yes --package=pnpm@11.7.0 -- pnpm start\n' \
  "${DSH_HOME:-$HOME/.dsh}/dsh-browser"
printf '\nFor Codex on macOS, load the extension in Chrome first, then run in that directory:\n  npm exec --yes --package=pnpm@11.7.0 -- pnpm native:install\n'
