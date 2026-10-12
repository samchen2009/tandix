#!/usr/bin/env python3
"""Embed the verified lite ZIP in one Mac and one Windows installer script."""

import base64
import hashlib
from pathlib import Path
from sys import argv

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = Path(argv[1]).resolve() if len(argv) > 1 else ROOT / 'workspace/output/网页助手_Tandix_Codex精简包_v11.zip'
OUTPUT = Path(argv[2]).resolve() if len(argv) > 2 else ROOT / 'workspace/output'
OUTPUT.mkdir(parents=True, exist_ok=True)
data = PAYLOAD.read_bytes()
digest = hashlib.sha256(data).hexdigest()
encoded = base64.b64encode(data).decode('ascii')
lines = '\n'.join(encoded[i:i + 76] for i in range(0, len(encoded), 76))

mac = '''#!/bin/bash
# Tandix v11 single-file online installer for macOS.
set -euo pipefail
work="$(mktemp -d "${TMPDIR:-/tmp}/tandix-one-file.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
sed '1,/^__TANDIX_ZIP_BELOW__$/d' "$0" | base64 -D > "$work/tandix-lite.zip"
printf '%s  %s\\n' '__SHA__' "$work/tandix-lite.zip" | shasum -a 256 -c -
unzip -q "$work/tandix-lite.zip" -d "$work"
launcher="$(find "$work" -maxdepth 2 -type f -name '*-Mac.command' -print -quit)"
if [ -z "$launcher" ]; then printf 'Mac installer not found.\\n' >&2; exit 1; fi
bash "$launcher"
exit 0
__TANDIX_ZIP_BELOW__
__B64__
'''.replace('__SHA__', digest).replace('__B64__', lines)

windows = '''# Tandix v11 single-file online installer for Windows PowerShell.
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:TEMP ('tandix-one-file-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $payload = @'
__B64__
'@
  $archive = Join-Path $work 'tandix-lite.zip'
  [System.IO.File]::WriteAllBytes($archive, [Convert]::FromBase64String($payload))
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '__SHA__') {
    throw 'Tandix lite ZIP SHA-256 mismatch.'
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $work
  $roots = @(Get-ChildItem -LiteralPath $work -Directory)
  if ($roots.Count -ne 1) { throw 'Expected one Tandix folder in the ZIP.' }
  $launchers = @(Get-ChildItem -LiteralPath $roots[0].FullName -File -Filter '*-win.cmd')
  if ($launchers.Count -ne 1) { throw 'Windows installer not found.' }
  & $launchers[0].FullName
  if ($LASTEXITCODE -ne 0) { throw "Tandix installer exited with code $LASTEXITCODE." }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
'''.replace('__SHA__', digest).replace('__B64__', lines)

mac_path = OUTPUT / '安装网页助手-Mac_v11.command'
win_path = OUTPUT / '安装网页助手-Windows_v11.ps1'
mac_path.write_text(mac, encoding='ascii')
win_path.write_text(windows, encoding='ascii')
mac_path.chmod(0o755)
for path in (mac_path, win_path):
    print(path, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
