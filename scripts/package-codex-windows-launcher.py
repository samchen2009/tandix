#!/usr/bin/env python3
"""Create a double-click Windows launcher for a published, pinned PS1 installer."""
import hashlib
from pathlib import Path
from sys import argv
from urllib.parse import urlparse

if len(argv) != 4:
    raise SystemExit('Usage: package-codex-windows-launcher.py SCRIPT_URL LOCAL_PS1 OUTPUT_CMD')
url, source, output = argv[1:]
if urlparse(url).scheme != 'https' or not urlparse(url).netloc or any(c in url for c in "'\"%\r\n"):
    raise ValueError('Expected an HTTPS script URL safe for CMD and PowerShell quoting')
sha = hashlib.sha256(Path(source).read_bytes()).hexdigest()
ps = (
    "& { $ErrorActionPreference='Stop'; $ProgressPreference='Continue'; "
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; "
    "$TandixScript=Join-Path $env:TEMP ('tandix-codex-'+[guid]::NewGuid().ToString('N')+'.ps1'); "
    "try { Invoke-WebRequest -UseBasicParsing -Uri '" + url + "' -OutFile $TandixScript; "
    "if ((Get-FileHash -LiteralPath $TandixScript -Algorithm SHA256).Hash.ToLowerInvariant() -ne '" + sha + "') { throw 'Installer SHA-256 mismatch' }; "
    "Unblock-File -LiteralPath $TandixScript; & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $TandixScript; "
    "if ($LASTEXITCODE -ne 0) { throw ('Tandix installer exited with code '+$LASTEXITCODE) } "
    "} finally { Remove-Item -LiteralPath $TandixScript -Force -ErrorAction SilentlyContinue } }")
text = '\r\n'.join([
    '@echo off', 'setlocal', 'title Tandix Codex installer for Windows',
    'echo Downloading and verifying the Tandix Windows installer...',
    'powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -Command "' + ps + '"',
    'if errorlevel 1 (', '  echo.', '  echo Installation did not finish. Check the error above.',
    '  pause', '  exit /b 1', ')', 'echo.',
    'echo Installation finished. Reload Tandix in Chrome and select Codex.',
    'pause', 'exit /b 0', ''])
path = Path(output).resolve()
path.parent.mkdir(parents=True, exist_ok=True)
path.write_bytes(text.encode('ascii'))
print(f'{path}: {path.stat().st_size} bytes, SHA-256 {hashlib.sha256(path.read_bytes()).hexdigest()}')
