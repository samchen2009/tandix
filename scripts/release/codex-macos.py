#!/usr/bin/env python3
"""Derive a Mac-only installer ZIP from the verified Codex-only release ZIP.

This keeps the released JS/extension bytes unchanged while removing the Windows
entry point and Windows Node runtimes, so Finder presents one installer.
"""

from pathlib import Path
from sys import argv
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(argv[1]).resolve() if len(argv) > 1 else ROOT / 'workspace/output/网页助手_Tandix_Codex安装包_v9.zip'
OUTPUT = Path(argv[2]).resolve() if len(argv) > 2 else ROOT / 'workspace/output/网页助手_Tandix_Codex_Mac专用安装包_v9.zip'
OLD_PREFIX = '网页助手_Tandix_Codex/'
NEW_PREFIX = '网页助手_Tandix_Codex_Mac/'
MAC_ENTRY = '安装网页助手-Mac.command'

README = '''网页助手（Tandix）Codex 版｜Mac 安装说明

1. 在 Finder 中完整解压 ZIP，打开“网页助手_Tandix_Codex_Mac”文件夹。
2. 双击“安装网页助手-Mac.command”。这个包没有 Windows 的 .cmd 入口。
3. 如 macOS 首次阻止打开，到“系统设置 → 隐私与安全性”找到这次拦截记录，点“仍要打开”，再确认“打开”。
4. 按安装窗口提示，在 Chrome 的 chrome://extensions 开启开发者模式，加载窗口打印的扩展目录；返回安装窗口继续。安装器会识别本机已加载的 Tandix 扩展，识别到多个无法区分的 ID 时才需要手动输入。
5. 重新加载扩展，在侧栏选择 Codex，确认显示“已连接”。

安装前需要 Google Chrome、Node.js 22.19+ 或 24+，以及已登录 ChatGPT 的本机 Codex。安装不需要 pnpm、源码编译或 npm 下载。
如果双击后窗口一闪而过，请在“终端”中把 .command 文件拖入窗口并按回车，记录最后一条错误信息（先隐去个人路径或账号）。
'''

def info_for(name: str, executable: bool = False) -> ZipInfo:
    info = ZipInfo(name)
    info.compress_type = ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = ((0o100755 if executable else 0o100644) << 16)
    return info

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(SOURCE) as source, ZipFile(OUTPUT, 'w') as out:
    out.writestr(info_for(NEW_PREFIX + '先看这里-Mac安装说明.txt'), README.encode('utf-8'))
    for item in source.infolist():
        if not item.filename.startswith(OLD_PREFIX) or item.is_dir():
            continue
        relative = item.filename[len(OLD_PREFIX):]
        if relative in {'安装网页助手-Codex.cmd', '安装网页助手-win.cmd', 'README.md'}:
            continue
        if relative.startswith('runtime/node-win-'):
            continue
        if relative == '安装网页助手-Codex.command':
            relative = MAC_ENTRY
        executable = relative == MAC_ENTRY or bool((item.external_attr >> 16) & 0o111)
        out.writestr(info_for(NEW_PREFIX + relative, executable), source.read(item))

with ZipFile(OUTPUT) as archive:
    names = set(archive.namelist())
    assert NEW_PREFIX + MAC_ENTRY in names
    assert not any(name.endswith('.cmd') or 'node-win-' in name for name in names)
    assert any(NEW_PREFIX + path in names for path in (
        'scripts/install/codex.mjs', 'scripts/install-codex-only.mjs'))
    assert NEW_PREFIX + 'extensions/dsh-browser/dist/manifest.json' in names
print(OUTPUT)
