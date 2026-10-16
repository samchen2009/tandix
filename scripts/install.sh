#!/bin/bash
# Compatibility URL only. The maintained installer is scripts/install/source-unix.sh.
set -euo pipefail
entry=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  entry="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install/source-unix.sh"
fi
if [ -f "$entry" ]; then
  exec /bin/bash "$entry" "$@"
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/tandix-entry.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
curl -fL --retry 2 --connect-timeout 15 \
  'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/source-unix.sh' -o "$work/source-unix.sh"
/bin/bash "$work/source-unix.sh" "$@"
