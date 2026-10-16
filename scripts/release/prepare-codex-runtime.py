#!/usr/bin/env python3
"""Stage official Windows Node binaries and locked, portable Tandix JS dependencies."""

import argparse
import hashlib
import shutil
import subprocess
from pathlib import Path
from urllib.request import urlretrieve
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
STAGE = ROOT / ".build/codex-portable-runtime"
VERSION = "24.21.0"
ARCHIVES = {
    "x64": "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    "arm64": "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
}

parser = argparse.ArgumentParser()
parser.add_argument("--cache-dir", type=Path, default=ROOT / ".build/downloads")
parser.add_argument("--npm-cache", type=Path)
parser.add_argument("--offline", action="store_true")
args = parser.parse_args()
args.cache_dir.mkdir(parents=True, exist_ok=True)

for arch, expected_sha in ARCHIVES.items():
    name = f"node-v{VERSION}-win-{arch}.zip"
    archive = args.cache_dir / name
    if not archive.is_file():
        urlretrieve(f"https://nodejs.org/dist/v{VERSION}/{name}", archive)
    actual_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual_sha != expected_sha:
        raise SystemExit(f"Official Node archive checksum mismatch: {name}")
    target = STAGE / "runtime" / f"node-win-{arch}"
    target.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive) as source:
        for filename in ("node.exe", "LICENSE"):
            member = f"node-v{VERSION}-win-{arch}/{filename}"
            (target / filename).write_bytes(source.read(member))
    print(f"Verified and staged {name}")

STAGE.mkdir(parents=True, exist_ok=True)
shutil.copyfile(ROOT / "scripts/release/resources/codex-package.json", STAGE / "package.json")
shutil.copyfile(ROOT / "scripts/release/resources/codex-package-lock.json", STAGE / "package-lock.json")
command = ["npm", "ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"]
if args.npm_cache:
    command.extend(["--cache", str(args.npm_cache)])
if args.offline:
    command.append("--offline")
subprocess.run(command, cwd=STAGE, check=True)
shutil.rmtree(STAGE / "node_modules/.bin", ignore_errors=True)
if any((STAGE / "node_modules").rglob("*.node")):
    raise SystemExit("Unexpected platform-native dependency in the portable runtime")
print(f"Portable runtime ready: {STAGE}")
