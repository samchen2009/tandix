#!/usr/bin/env python3
"""Make the small Codex payload used by the optional network installer."""

from hashlib import sha256
from pathlib import Path
from sys import argv
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(argv[1]).resolve() if len(argv) > 1 else ROOT / "workspace/output/网页助手_Tandix_Codex完整包_v10.zip"
OUTPUT = Path(argv[2]).resolve() if len(argv) > 2 else ROOT / "workspace/output/网页助手_Tandix_Codex精简包_v10.zip"
PREFIX = "网页助手_Tandix_Codex/"

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(SOURCE) as source, ZipFile(OUTPUT, "w") as output:
    for entry in source.infolist():
        if entry.filename.startswith(PREFIX + "runtime/"):
            continue
        contents = (ROOT / "scripts/README-codex-online.md").read_bytes() if entry.filename == PREFIX + "README.md" else source.read(entry)
        output.writestr(entry, contents)

with ZipFile(OUTPUT) as archive:
    assert archive.testzip() is None
    names = set(archive.namelist())
    assert PREFIX + "安装网页助手-Mac.command" in names
    assert PREFIX + "安装网页助手-win.cmd" in names
    assert PREFIX + "scripts/install-codex-only.mjs" in names
    assert not any(name.startswith(PREFIX + "runtime/") for name in names)

print(f"{OUTPUT}: {OUTPUT.stat().st_size} bytes, SHA-256 {sha256(OUTPUT.read_bytes()).hexdigest()}")
