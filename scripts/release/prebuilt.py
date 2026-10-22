#!/usr/bin/env python3
"""Package built Tandix runtime files without TypeScript/React source trees."""

from pathlib import Path
from sys import argv
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(argv[1]).resolve() if len(argv) > 1 else ROOT / "workspace/output/网页助手_Tandix_预构建安装包.zip"
PREFIX = Path("网页助手_Tandix")

FILES = {
    ".npmrc", "LICENSE", "README.zh.md", "package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "安装网页助手.command", "安装网页助手.cmd",
    "scripts/dev/version.mjs",
    "extensions/dsh-browser/package.json",
    "packages/browser/bridge-browser/package.json",
    "packages/browser/bridge-browser/cordis.patch.yml",
    "packages/browser/bridge-browser/lib/index.js",
    "packages/browser/bridge-browser/lib/invariant.js",
    "packages/browser/bridge-browser/lib/protocol.js",
    "packages/browser/bridge-browser/lib/client.js",
    "scripts/install/source-unix.sh", "scripts/install/source-windows.ps1", "scripts/install/windows.ps1",
    "scripts/runtime/connection-check.mjs", "scripts/install/codex-windows-host.ps1", "scripts/runtime/native-proxy.cs",
    "scripts/install/start-dsh-windows.ps1", "scripts/install/run-dsh-windows.ps1",
    "scripts/runtime/native-host.mjs", "scripts/runtime/runtime-discovery.mjs", "scripts/runtime/skills-store.mjs",
    "scripts/runtime/codex-bridge.mjs", "scripts/runtime/codex-mcp.mjs",
    "scripts/runtime/workbuddy-bridge.mjs",
    "scripts/runtime/acp-bridge.mjs",
    "scripts/runtime/agent-configuration.mjs",
    "scripts/runtime/cursor-bridge.mjs",
    "scripts/runtime/web-task-store.mjs",
    "scripts/runtime/browser-guidance.mjs", "scripts/runtime/lark-auth.mjs",
    "scripts/runtime/session-title.mjs",
}
FILES.update(
    path.relative_to(ROOT).as_posix()
    for path in (ROOT / "extensions/dsh-browser/dist").rglob("*") if path.is_file()
)

for relative in sorted(FILES):
    if not (ROOT / relative).is_file():
        raise FileNotFoundError(relative)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED) as archive:
    archive.writestr(str(PREFIX / ".tandix-prebuilt"), "Tandix prebuilt runtime\n")
    for relative in sorted(FILES):
        archive.write(ROOT / relative, str(PREFIX / relative))

print(f"{OUTPUT} ({len(FILES)} files)")
