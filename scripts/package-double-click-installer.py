#!/usr/bin/env python3
"""Package the reviewed source tree with Mac and Windows double-click launchers."""

from pathlib import Path
from subprocess import check_output
from sys import argv
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = Path(argv[1]).resolve() if len(argv) > 1 else ROOT / "workspace/output/网页助手_Tandix_双击安装包_源码版.zip"
PREFIX = Path("网页助手_Tandix")
TOP_LEVEL = {
    ".npmrc", "LICENSE", "README.zh.md", "package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "安装网页助手.command", "安装网页助手.cmd",
}
SOURCE_DIRS = ("extensions/", "packages/", "scripts/")


def include(relative: str) -> bool:
    if relative in TOP_LEVEL:
        return True
    if not relative.startswith(SOURCE_DIRS):
        return False
    parts = Path(relative).parts
    return not any(part in {"node_modules", "dist", "dist-firefox", "coverage", "tests", "__pycache__"} for part in parts)


tracked = check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
files = {relative for relative in tracked if relative and include(relative)}
files.update({
    "安装网页助手.command", "安装网页助手.cmd",
    "scripts/start-dsh-background.ps1", "scripts/run-dsh-window.ps1",
})
for relative in files:
    if not (ROOT / relative).is_file():
        raise FileNotFoundError(relative)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED) as archive:
    for relative in sorted(files):
        path = ROOT / relative
        archive.write(path, str(PREFIX / relative))

print(f"{OUTPUT} ({len(files)} files)")
