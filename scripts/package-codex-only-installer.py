#!/usr/bin/env python3
"""Create one OS/CPU complete package or one OS lite Tandix package."""

from pathlib import Path
import argparse
import json
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--platform', required=True, choices=['mac-x64', 'mac-arm64', 'win-x64', 'win-arm64', 'mac-lite', 'win-lite'])
args = parser.parse_args()
OUTPUT = args.output.resolve()
os_name, variant = args.platform.split('-')
PREFIX = Path("网页助手_Tandix_Codex")
PORTABLE = ROOT / ".build/codex-portable-runtime"
FILES = {
    "安装网页助手-Codex.command", "安装网页助手-Codex.cmd",
    "scripts/install-codex-only.mjs", "scripts/install-codex-windows-host.ps1",
    "scripts/tandix-native-proxy.cs", "scripts/traceforge-native-host.mjs",
    "scripts/traceforge-runtime-discovery.mjs", "scripts/traceforge-codex-bridge.mjs",
    "scripts/traceforge-workbuddy-bridge.mjs",
    "scripts/traceforge-codex-mcp.mjs", "scripts/traceforge-browser-guidance.mjs",
    "scripts/traceforge-lark-auth.mjs", "scripts/traceforge-session-title.mjs",
    "scripts/tandix-portable-node.mjs",
    "scripts/ensure-tandix-node-mac.sh", "scripts/ensure-tandix-node-win.ps1",
    "scripts/open-tandix-chrome-win.ps1",
}
INSTALLER_NAMES = {
    "安装网页助手-Codex.command": "安装网页助手-Mac.command",
    "安装网页助手-Codex.cmd": "安装网页助手-win.cmd",
}
FILES.update(path.relative_to(ROOT).as_posix()
             for path in (ROOT / "extensions/dsh-browser/dist").rglob("*") if path.is_file())
for relative in FILES:
    if not (ROOT / relative).is_file():
        raise FileNotFoundError(relative)
if os_name == 'mac':
    FILES.difference_update({'安装网页助手-Codex.cmd', 'scripts/install-codex-windows-host.ps1',
                            'scripts/tandix-native-proxy.cs', 'scripts/ensure-tandix-node-win.ps1',
                            'scripts/open-tandix-chrome-win.ps1'})
else:
    FILES.difference_update({'安装网页助手-Codex.command', 'scripts/ensure-tandix-node-mac.sh'})
portable_roots = [PORTABLE / 'node_modules']
if variant != 'lite':
    portable_roots.append(PORTABLE / f'runtime/node-{args.platform}')
for directory in portable_roots:
    if not directory.is_dir():
        raise FileNotFoundError(f'Missing staged dependencies/runtime: {directory}')
if variant != 'lite':
    runtime = portable_roots[-1]
    executable = runtime / ('bin/node' if os_name == 'mac' else 'node.exe')
    for path in (executable, runtime / 'LICENSE'):
        if not path.is_file():
            raise FileNotFoundError(f'Missing official runtime file: {path}')
if not (ROOT / 'extensions/dsh-browser/dist/manifest.json').is_file():
    raise FileNotFoundError('Build the Chrome extension before packaging.')
for relative in ('node_modules/@modelcontextprotocol/sdk/package.json', 'node_modules/ws/package.json', 'node_modules/zod/package.json'):
    if not (PORTABLE / relative).is_file():
        raise FileNotFoundError(relative)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED) as archive:
    archive.write(ROOT / "scripts/tandix-codex-package.json", str(PREFIX / "package.json"))
    archive.write(ROOT / "scripts/tandix-codex-package-lock.json", str(PREFIX / "package-lock.json"))
    archive.writestr(str(PREFIX / "README.md"),
        f"# Tandix Codex installer ({args.platform})\n\n"
        "Fully extract this ZIP before running the installer.\n"
        + ("Run 安装网页助手-Mac.command on macOS.\n" if os_name == 'mac' else "Run 安装网页助手-win.cmd on Windows.\n")
        + ("Includes one official Node.js runtime for this platform and CPU.\n" if variant != 'lite' else "Uses existing Node.js 22.19+ or 24+; otherwise downloads official Node.js.\n")
        + "Requires Chrome and a locally runnable Codex signed in to ChatGPT.\n"
        "Enable Chrome Developer mode, then Load unpacked using the folder printed by the installer.\n")
    archive.writestr(str(PREFIX / 'tandix-package.json'), json.dumps({'platform': os_name, 'architecture': None if variant == 'lite' else variant, 'includes_node': variant != 'lite'}))
    for relative in sorted(FILES):
        archive.write(ROOT / relative, str(PREFIX / INSTALLER_NAMES.get(relative, relative)))
    portable_files = sorted(path for directory in portable_roots for path in directory.rglob('*') if path.is_file())
    for path in portable_files:
        archive.write(path, str(PREFIX / path.relative_to(PORTABLE)))
print(f"{OUTPUT} ({len(FILES) + 4 + len(portable_files)} files)")
