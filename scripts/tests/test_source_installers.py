"""Exercise standalone source entries without downloads or real installation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipIf(os.name == 'nt', 'Unix shell harness')
class MacSourceInstaller(unittest.TestCase):
    def run_case(self, node=0, download=0, install=0, platform='Darwin'):
        with tempfile.TemporaryDirectory(prefix='tandix source ') as directory:
            work = Path(directory)
            bin_dir = work / 'bin'
            bin_dir.mkdir()
            commands = {
                'uname': '#!/bin/bash\nprintf "%s\\n" "$TEST_PLATFORM"\n',
                'node': '#!/bin/bash\nexit "$TEST_NODE_STATUS"\n',
                'curl': '''#!/bin/bash
touch "$TEST_WORK/downloaded"
[ "$TEST_DOWNLOAD_STATUS" = 0 ] || exit "$TEST_DOWNLOAD_STATUS"
for arg in "$@"; do destination="$arg"; done
printf '%s\\n' '#!/bin/bash' 'touch "$TEST_WORK/installed"' 'exit "$TEST_INSTALL_STATUS"' > "$destination"
''',
                'npm': '''#!/bin/bash
printf '%s\\n' "$@" > "$TEST_WORK/npm-args"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
''',
            }
            for name, body in commands.items():
                command = bin_dir / name
                command.write_text(body)
                command.chmod(0o755)
            env = {**os.environ, 'PATH': str(bin_dir) + ':/usr/bin:/bin',
                   'TMPDIR': str(work), 'TEST_WORK': str(work), 'TEST_PLATFORM': platform,
                   'TEST_NODE_STATUS': str(node), 'TEST_DOWNLOAD_STATUS': str(download),
                   'TEST_INSTALL_STATUS': str(install), 'DSH_HOME': str(work / "user's dsh")}
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/install-macos.sh')],
                                    env=env, text=True, capture_output=True)
            return (result, (work / 'downloaded').exists(), (work / 'installed').exists(),
                    (work / 'npm-args').read_text() if (work / 'npm-args').exists() else '',
                    list(work.glob('tandix-source.*')))

    def test_success_uses_pinned_pnpm_and_cleans_temp(self):
        result, downloaded, installed, args, remaining = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(downloaded and installed)
        pin = json.loads((ROOT / 'package.json').read_text())['packageManager']
        self.assertIn('--package=' + pin, args)
        self.assertIn('pnpm start', result.stdout)
        self.assertIn('pnpm native:install', result.stdout)
        self.assertEqual(remaining, [])

    def test_prerequisite_failures_stop_before_download(self):
        for kwargs in ({'node': 1}, {'platform': 'Linux'}):
            with self.subTest(**kwargs):
                result, downloaded, installed, _, _ = self.run_case(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(downloaded or installed)

    def test_download_failure_never_runs_installer(self):
        result, downloaded, installed, _, remaining = self.run_case(download=22)
        self.assertEqual(result.returncode, 22)
        self.assertTrue(downloaded)
        self.assertFalse(installed)
        self.assertEqual(remaining, [])

    def test_child_failure_is_propagated(self):
        result, _, installed, _, remaining = self.run_case(install=37)
        self.assertEqual(result.returncode, 37)
        self.assertTrue(installed)
        self.assertNotIn('To start dsh', result.stdout)
        self.assertEqual(remaining, [])


@unittest.skipUnless(os.name == 'nt', 'Windows PowerShell harness')
class WindowsSourceInstaller(unittest.TestCase):
    def run_case(self, install=0, download_failure=False):
        with tempfile.TemporaryDirectory(prefix='tandix source ') as directory:
            work = Path(directory)
            (work / 'npm.cmd').write_text('@echo off\r\necho %* > "%TEST_WORK%\\npm-args"\r\nexit /b %TEST_INSTALL_STATUS%\r\n')
            harness = work / 'harness.ps1'
            harness.write_text('''
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  Set-Content -LiteralPath (Join-Path $env:TEST_WORK 'downloaded') -Value $Uri
  if ($env:TEST_DOWNLOAD_FAILURE -eq '1') { throw 'Simulated download failure' }
  Set-Content -LiteralPath $OutFile -Value '# Mock source installer'
}
& $env:TEST_ENTRY
exit $LASTEXITCODE
''')
            env = {**os.environ, 'PATH': str(work) + os.pathsep + os.environ['PATH'],
                   'TEMP': str(work), 'TMP': str(work), 'TEST_WORK': str(work),
                   'TEST_ENTRY': str(ROOT / 'scripts/install-windows.ps1'),
                   'TEST_INSTALL_STATUS': str(install), 'TEST_DOWNLOAD_FAILURE': '1' if download_failure else '0'}
            result = subprocess.run([shutil.which('powershell.exe'), '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                     '-File', str(harness)], env=env, text=True, capture_output=True)
            return (result, (work / 'npm-args').read_text() if (work / 'npm-args').exists() else '',
                    list(work.glob('tandix-source-*')))

    def test_pinned_pnpm_and_startup_instructions(self):
        result, args, remaining = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        pin = json.loads((ROOT / 'package.json').read_text())['packageManager']
        self.assertIn('--package=' + pin, args)
        self.assertIn('-ExecutionPolicy Bypass -File', args)
        self.assertIn('pnpm start', result.stdout)
        self.assertEqual(remaining, [])

    def test_child_failure_is_propagated(self):
        result, _, remaining = self.run_case(install=37)
        self.assertEqual(result.returncode, 37)
        self.assertNotIn('To start dsh', result.stdout)
        self.assertEqual(remaining, [])

    def test_failed_download_never_runs_npm(self):
        result, args, remaining = self.run_case(download_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(args, '')
        self.assertEqual(remaining, [])


if __name__ == '__main__':
    unittest.main()
