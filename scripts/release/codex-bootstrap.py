#!/usr/bin/env python3
"""Generate small Mac/Windows installers from a verified platform package catalog."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('catalog', type=Path, help='JSON with mac-x64, mac-arm64, win-x64, win-arm64, mac-lite and win-lite entries')
parser.add_argument('output_dir', type=Path)
parser.add_argument('--version', required=True, type=int)
args = parser.parse_args()
catalog = json.loads(args.catalog.read_text())
replacements = {}
for platform in ('mac-x64', 'mac-arm64', 'win-x64', 'win-arm64', 'mac-lite', 'win-lite'):
    entry = catalog[platform]
    url = entry['url']
    if urlparse(url).scheme not in {'http', 'https'} or not urlparse(url).netloc or any(c in url for c in "'\n\r"):
        raise ValueError(f'Unsafe direct download URL for {platform}')
    sha = hashlib.sha256(Path(entry['local']).read_bytes()).hexdigest()
    if sha != entry['sha256']:
        raise ValueError(f'Local ZIP SHA-256 does not match catalog for {platform}')
    key = platform.replace('-', '_').upper()
    replacements[f'__{key}_URL__'] = url
    replacements[f'__{key}_SHA__'] = sha
args.output_dir.mkdir(parents=True, exist_ok=True)
for template, filename in (
    ('bootstrap-macos.sh.in', f'安装网页助手-Mac_v{args.version}.sh'),
    ('bootstrap-windows.ps1.in', f'安装网页助手-Windows_v{args.version}.ps1'),
):
    source = (ROOT / 'scripts/release/templates' / template).read_text()
    for old, new in replacements.items():
        source = source.replace(old, new)
    if re.search(r'__[A-Z0-9_]+__', source):
        raise ValueError(f'Unfilled placeholder in {template}')
    path = args.output_dir / filename
    path.write_text(source, encoding='utf-8')
    if filename.endswith('.sh'):
        path.chmod(0o755)
    print(f'{path}: {path.stat().st_size} bytes')
