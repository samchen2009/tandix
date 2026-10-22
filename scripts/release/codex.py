#!/usr/bin/env python3
"""Create one OS/CPU complete package or one OS lite Tandix package."""

from pathlib import Path
import argparse
import json
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--platform', required=True, choices=['mac-x64', 'mac-arm64', 'win-x64', 'win-arm64', 'mac-lite', 'win-lite'])
args = parser.parse_args()
OUTPUT = args.output.resolve()
os_name, variant = args.platform.split('-')
PREFIX = Path("网页助手_Tandix_Codex")
PORTABLE = ROOT / ".build/codex-portable-runtime"
FILES = {
    "LICENSE",
    "安装网页助手-Codex.command", "安装网页助手-Codex.cmd",
    "scripts/install/codex.mjs", "scripts/install/codex-windows-host.ps1",
    "scripts/runtime/native-proxy.cs", "scripts/runtime/native-host.mjs",
    "scripts/runtime/runtime-discovery.mjs", "scripts/runtime/skills-store.mjs", "scripts/runtime/codex-bridge.mjs",
    "scripts/runtime/workbuddy-bridge.mjs",
    "scripts/runtime/acp-bridge.mjs",
    "scripts/runtime/artifacts.mjs",
    "scripts/runtime/agent-configuration.mjs",
    "scripts/runtime/cursor-bridge.mjs",
    "scripts/runtime/web-task-store.mjs",
    "scripts/runtime/codex-mcp.mjs", "scripts/runtime/browser-guidance.mjs",
    "scripts/runtime/lark-auth.mjs", "scripts/runtime/session-title.mjs",
    "scripts/runtime/portable-node.mjs",
    "scripts/install/node-macos.sh", "scripts/install/node-windows.ps1",
    "scripts/install/open-chrome-windows.ps1",
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
    FILES.difference_update({'安装网页助手-Codex.cmd', 'scripts/install/codex-windows-host.ps1',
                            'scripts/runtime/native-proxy.cs', 'scripts/install/node-windows.ps1',
                            'scripts/install/open-chrome-windows.ps1'})
else:
    FILES.difference_update({'安装网页助手-Codex.command', 'scripts/install/node-macos.sh'})
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
    archive.write(ROOT / "scripts/release/resources/codex-package.json", str(PREFIX / "package.json"))
    archive.write(ROOT / "scripts/release/resources/codex-package-lock.json", str(PREFIX / "package-lock.json"))
    archive.writestr(str(PREFIX / "README.md"),
        f"# Tandix Codex installer ({args.platform})\n\n"
        "Fully extract this ZIP before running the installer.\n"
        + ("Run 安装网页助手-Mac.command on macOS.\n" if os_name == 'mac' else "Run 安装网页助手-win.cmd on Windows.\n")
        + ("Includes one official Node.js runtime for this platform and CPU.\n" if variant != 'lite' else "Uses existing Node.js 22.19+ or 24+; otherwise downloads official Node.js.\n")
        + "Requires Chrome and a locally runnable Codex signed in to ChatGPT.\n"
        "No Git, pnpm, source build, or npm dependency download is needed for a complete package.\n"
        "Enable Chrome Developer mode, then Load unpacked using the folder printed by the installer.\n")
    archive.writestr(str(PREFIX / '先看这里.txt'),
        "Tandix 网页助手安装\n\n"
        "安装前：需要 Google Chrome，以及已安装并登录的本机 Codex。\n"
        "完整包自带 Node 和连接依赖，不需要 Git、pnpm，也不需要编译源码。\n"
        "精简包需要已有兼容 Node，缺少时会联网下载。\n\n"
        "1. 完整解压 ZIP，不要在压缩包预览窗口中运行安装入口。\n"
        + ("2. Mac 双击 安装网页助手-Mac.command。若首次被系统拦截，在隐私与安全性中确认仍要打开。\n" if os_name == 'mac'
           else "2. Windows 双击 安装网页助手-win.cmd。\n")
        + "3. 在 Chrome 的 chrome://extensions 开启开发者模式，加载安装窗口打印的扩展目录。\n"
        "4. 返回安装窗口继续，完成本机伴随程序注册；重新加载扩展。\n"
        "5. 打开普通网页，点击 Tandix 图标，在顶部 Agent 菜单选择 Codex。\n\n"
        "这些包采用 Codex 安装流程。WorkBuddy 连接需另行安装并登录兼容 ACP 运行时，不能自动继承桌面账号。\n")
    archive.writestr(str(PREFIX / 'tandix-package.json'), json.dumps({'platform': os_name, 'architecture': None if variant == 'lite' else variant, 'includes_node': variant != 'lite'}))
    for relative in sorted(FILES):
        archive.write(ROOT / relative, str(PREFIX / INSTALLER_NAMES.get(relative, relative)))
    portable_files = sorted(path for directory in portable_roots for path in directory.rglob('*') if path.is_file())
    for path in portable_files:
        archive.write(path, str(PREFIX / path.relative_to(PORTABLE)))
print(f"{OUTPUT} ({len(FILES) + 5 + len(portable_files)} files)")
