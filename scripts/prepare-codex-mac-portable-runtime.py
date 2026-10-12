#!/usr/bin/env python3
"""Copy verified official macOS Node executables into the portable bundle."""

import hashlib
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOWNLOADS = ROOT / ".build/mac-node-downloads"
RUNTIME = ROOT / ".build/codex-portable-runtime/runtime"
VERSION = "24.21.0"
ARCHIVES = {
    "arm64": "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe",
    "x64": "0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299",
}

for arch, expected in ARCHIVES.items():
    archive = DOWNLOADS / f"node-v{VERSION}-darwin-{arch}.tar.xz"
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Official Node archive SHA-256 mismatch: {archive}")
    prefix = f"node-v{VERSION}-darwin-{arch}/"
    target = RUNTIME / f"node-mac-{arch}"
    (target / "bin").mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:xz") as source:
        for name, destination, mode in (
            (prefix + "bin/node", target / "bin/node", 0o755),
            (prefix + "LICENSE", target / "LICENSE", 0o644),
        ):
            entry = source.extractfile(name)
            if entry is None:
                raise FileNotFoundError(name)
            destination.write_bytes(entry.read())
            destination.chmod(mode)
    print(f"Prepared official macOS Node {VERSION} {arch}: {target}")
