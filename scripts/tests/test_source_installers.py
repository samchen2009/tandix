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
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/install/macos.sh')],
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
    def run_case(self, stage='', healthy=True):
        with tempfile.TemporaryDirectory(prefix='tandix setup ') as directory:
            work = Path(directory)
            harness = work / 'harness.ps1'
            harness.write_text(r'''$ErrorActionPreference = 'Stop'
. $env:TEST_ENTRY -FunctionsOnly -NonInteractive -Agents dsh -Agent dsh -InstallHome (Join-Path $env:TEST_WORK 'install')
$SourceRoot = $env:TEST_WORK
function Record([string]$Stage) {
  Add-Content -LiteralPath (Join-Path $env:TEST_WORK 'stages') -Value $Stage
  if ($env:TEST_FAIL_STAGE -eq $Stage) { throw "Simulated $Stage failure" }
}
function Ensure-BuildNode { Record 'node'; return (Get-Command node.exe).Source }
function Install-Toolkit { Record 'pnpm' }
function Ensure-Chrome { Record 'chrome' }
function Test-SourceRoot { return $true }
function Install-Source { Record 'build'; $script:ReadySourceRoot = $env:TEST_WORK }
function Register-Companion { Record 'register' }
function Test-AgentConnection {
  Record 'check'
  return [pscustomobject]@{backend='dsh';status=$env:TEST_CONNECTION_STATUS;message='simulated result'}
}
try { Invoke-TandixSetup; exit 0 } catch { exit 1 }
''')
            env = {**os.environ, 'TEST_WORK': str(work), 'TEST_ENTRY': str(ROOT / 'scripts/install/windows.ps1'),
                   'TEST_FAIL_STAGE': stage, 'TEST_CONNECTION_STATUS': 'ready' if healthy else 'failed'}
            result = subprocess.run([shutil.which('powershell.exe'), '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                     '-File', str(harness)], env=env, text=True, capture_output=True)
            report = work / 'install/install-report.json'
            return (result, (work / 'stages').read_text().splitlines(),
                    json.loads(report.read_text(encoding='utf-8-sig')) if report.exists() else None)

    def test_setup_registers_and_checks_before_reporting_ready(self):
        result, stages, report = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(stages, ['node', 'pnpm', 'chrome', 'build', 'register', 'check'])
        self.assertTrue(report['selectedAgentReady'])
        self.assertEqual(report['status'], 'ready')
        self.assertIn('No pnpm start terminal is needed', result.stdout)

    def test_failed_build_stops_before_registration(self):
        result, stages, report = self.run_case(stage='build')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('register', stages)
        self.assertFalse(report['selectedAgentReady'])
        self.assertNotIn('[7/7]', result.stdout)

    def test_unhealthy_connection_is_not_success(self):
        result, stages, report = self.run_case(healthy=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('check', stages)
        self.assertFalse(report['selectedAgentReady'])
        self.assertEqual(report['status'], 'failed')

    def test_profile_bundle_list_keeps_array_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = Path(directory) / 'profile.ps1'
            harness.write_text(r'''$ErrorActionPreference = 'Stop'
$text = Get-Content -LiteralPath $env:TEST_BUILDER -Raw -Encoding UTF8
$snippet = [regex]::Match($text, '(?ms)^\$Bundles = .*?^\$ProfileManifest\.dsh\.profile\.bundles = [^\r\n]+').Value
if (-not $snippet) { throw 'Profile update code was not found' }
$LegacyPlugin = '@deepseek-ai/dsh-bridge-browser'
$BridgePlugin = '@yuxianglin/dsh-bridge-browser'
foreach ($json in @('{"dsh":{"profile":{"bundles":[]}}}', '{"dsh":{"profile":{"bundles":["keep"]}}}', '{"dsh":{"profile":{"bundles":["keep","@deepseek-ai/dsh-bridge-browser"]}}}')) {
  $ProfileManifest = $json | ConvertFrom-Json
  . ([scriptblock]::Create($snippet))
  $updated = $ProfileManifest | ConvertTo-Json -Depth 10 -Compress
  if ($updated -notmatch '"bundles":\[') { throw "Bundles became a scalar: $updated" }
  if ($ProfileManifest.dsh.profile.bundles -notcontains $BridgePlugin) { throw 'Bridge is missing' }
  if ($ProfileManifest.dsh.profile.bundles -contains $LegacyPlugin) { throw 'Legacy bridge remains' }
}
''')
            result = subprocess.run([shutil.which('powershell.exe'), '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                     '-File', str(harness)], env={**os.environ, 'TEST_BUILDER': str(ROOT / 'scripts/install/source-windows.ps1')},
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)


if __name__ == '__main__':
    unittest.main()
