#!/bin/bash
# Compatibility URL only. The maintained installer is scripts/install/macos.sh.
set -euo pipefail
entry=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  entry="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install/macos.sh"
fi
if [ -f "$entry" ]; then
  exec /bin/bash "$entry" "$@"
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/tandix-entry.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
curl -fL --retry 2 --connect-timeout 15 \
  'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/macos.sh' -o "$work/macos.sh"
/bin/bash "$work/macos.sh" "$@"
