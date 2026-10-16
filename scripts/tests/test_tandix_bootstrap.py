"""Execute the Mac bootstrap with simulated hardware and download responses."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]

class BootstrapSelection(unittest.TestCase):
    def run_case(self, machine, compatible=False, translated=False, corrupt=False):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            payload = work / 'payload.zip'
            with ZipFile(payload, 'w') as z:
                z.writestr('网页助手_Tandix_Codex/安装网页助手-Mac.command', '#!/bin/bash\nexit 99\n')
            sha = hashlib.sha256(payload.read_bytes()).hexdigest()
            template = (ROOT / 'scripts/release/templates/bootstrap-macos.sh.in').read_text()
            for key in ('MAC_X64', 'MAC_ARM64', 'MAC_LITE'):
                template = template.replace(f'__{key}_URL__', 'https://example.invalid/' + key)
                template = template.replace(f'__{key}_SHA__', sha if not corrupt else '0' * 64)
            installer = work / 'source-unix.sh'
            installer.write_text(template)
            bin_dir = work / 'bin'
            bin_dir.mkdir()
            commands = {
                'uname': '#!/bin/bash\nif [ "$1" = -s ]; then echo Darwin; else echo "$TEST_MACHINE"; fi\n',
                'sysctl': '#!/bin/bash\necho "$TEST_TRANSLATED"\n',
                'node': '#!/bin/bash\nexit "$TEST_NODE_STATUS"\n',
                'curl': '#!/bin/bash\nfor arg in "$@"; do case "$arg" in https://*) echo "$arg" > "$TEST_URL_LOG";; esac; last="$arg"; done\n/bin/cp "$TEST_PAYLOAD" "$last"\n',
            }
            for name, content in commands.items():
                p = bin_dir / name
                p.write_text(content)
                p.chmod(0o755)
            env = {**os.environ, 'PATH': str(bin_dir) + ':/usr/bin:/bin',
                   'TANDIX_BOOTSTRAP_VERIFY_ONLY': '1', 'TEST_MACHINE': machine,
                   'TEST_TRANSLATED': '1' if translated else '0', 'TEST_NODE_STATUS': '0' if compatible else '1',
                   'TEST_PAYLOAD': str(payload), 'TEST_URL_LOG': str(work / 'url')}
            for key in ('TANDIX_LITE_ZIP_URL', 'TANDIX_FULL_ZIP_URL'):
                env.pop(key, None)
            result = subprocess.run(['/bin/bash', str(installer)], env=env, capture_output=True, text=True)
            url = (work / 'url').read_text().strip() if (work / 'url').exists() else None
            return result, url

    def test_hardware_and_node_routing(self):
        for machine, node, translated, selected in (
            ('x86_64', False, False, 'MAC_X64'),
            ('arm64', False, False, 'MAC_ARM64'),
            ('x86_64', False, True, 'MAC_ARM64'),
            ('x86_64', True, False, 'MAC_LITE'),
            ('arm64', True, False, 'MAC_LITE'),
        ):
            with self.subTest(machine=machine, node=node, translated=translated):
                result, url = self.run_case(machine, node, translated)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(url, 'https://example.invalid/' + selected)
                self.assertIn('verified and extracted', result.stdout)

    def test_unknown_hardware_stops_before_download(self):
        result, url = self.run_case('unsupported')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(url)

    def test_modified_download_is_rejected(self):
        result, _ = self.run_case('arm64', corrupt=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('verified and extracted', result.stdout)

if __name__ == '__main__':
    unittest.main()
