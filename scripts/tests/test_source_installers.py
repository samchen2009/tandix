"""Exercise standalone source entries without downloads or real installation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipIf(os.name == 'nt', 'Unix shell harness')
class MacSourceInstaller(unittest.TestCase):
    def run_case(self, node=0, download=0, install=0, platform='Darwin', native=0, detect_failures=0, input_text=''):
        with tempfile.TemporaryDirectory(prefix='tandix source ') as directory:
            work = Path(directory)
            bin_dir = work / 'bin'
            bin_dir.mkdir()
            commands = {
                'uname': '#!/bin/bash\nprintf "%s\\n" "$TEST_PLATFORM"\n',
                'node': '''#!/bin/bash
if [ "${2:-}" = extension-id ]; then
  count=0
  [ ! -f "$TEST_WORK/detections" ] || count="$(cat "$TEST_WORK/detections")"
  count=$((count + 1))
  printf '%s' "$count" > "$TEST_WORK/detections"
  [ "$count" -gt "$TEST_DETECT_FAILURES" ] || exit 1
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
exit "$TEST_NODE_STATUS"
''',
                'curl': '''#!/bin/bash
touch "$TEST_WORK/downloaded"
[ "$TEST_DOWNLOAD_STATUS" = 0 ] || exit "$TEST_DOWNLOAD_STATUS"
for arg in "$@"; do destination="$arg"; done
printf '%s\\n' '#!/bin/bash' 'touch "$TEST_WORK/installed"' 'mkdir -p "$DSH_HOME/dsh-browser/scripts/runtime"' 'touch "$DSH_HOME/dsh-browser/scripts/runtime/native-host.mjs"' 'exit "$TEST_INSTALL_STATUS"' > "$destination"
''',
                'npm': '''#!/bin/bash
printf '%s\\n' "$@" >> "$TEST_WORK/npm-args"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
''',
                'pnpm': '''#!/bin/bash
pwd > "$TEST_WORK/native-cwd"
printf '%s\\n' "$@" > "$TEST_WORK/native-args"
exit "$TEST_NATIVE_STATUS"
''',
            }
            for name, body in commands.items():
                command = bin_dir / name
                command.write_text(body)
                command.chmod(0o755)
            env = {**os.environ, 'PATH': str(bin_dir) + ':/usr/bin:/bin',
                   'TMPDIR': str(work), 'TEST_WORK': str(work), 'TEST_PLATFORM': platform,
                   'TEST_NODE_STATUS': str(node), 'TEST_DOWNLOAD_STATUS': str(download),
                   'TEST_INSTALL_STATUS': str(install), 'DSH_HOME': str(work / "user's dsh"),
                   'TEST_NATIVE_STATUS': str(native), 'TEST_DETECT_FAILURES': str(detect_failures)}
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/install/macos.sh')],
                                    env=env, input=input_text, text=True, capture_output=True)
            return (result, (work / 'downloaded').exists(), (work / 'installed').exists(),
                    (work / 'npm-args').read_text() if (work / 'npm-args').exists() else '',
                    list(work.glob('tandix-source.*')),
                    (work / 'native-args').read_text().splitlines() if (work / 'native-args').exists() else [],
                    (work / 'native-cwd').read_text().strip() if (work / 'native-cwd').exists() else '',
                    str(work / "user's dsh/dsh-browser"))

    def test_success_uses_pinned_pnpm_and_cleans_temp(self):
        result, downloaded, installed, args, remaining, native_args, cwd, expected_cwd = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(downloaded and installed)
        pin = json.loads((ROOT / 'package.json').read_text())['packageManager']
        self.assertIn('--package=' + pin, args)
        self.assertIn('pnpm start', result.stdout)
        self.assertEqual(args.count('--package=' + pin), 2)
        self.assertEqual(native_args, ['native:install', '--extension-id', 'a' * 32])
        self.assertEqual(cwd, expected_cwd)
        self.assertIn('Extension files and native companion are updated.', result.stdout)
        self.assertEqual(remaining, [])

    def test_prerequisite_failures_stop_before_download(self):
        for kwargs in ({'node': 1}, {'platform': 'Linux'}):
            with self.subTest(**kwargs):
                result, downloaded, installed, _, _, native_args, _, _ = self.run_case(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(downloaded or installed)
                self.assertEqual(native_args, [])

    def test_download_failure_never_runs_installer(self):
        result, downloaded, installed, _, remaining, native_args, _, _ = self.run_case(download=22)
        self.assertEqual(result.returncode, 22)
        self.assertTrue(downloaded)
        self.assertFalse(installed)
        self.assertEqual(native_args, [])
        self.assertEqual(remaining, [])

    def test_child_failure_is_propagated(self):
        result, _, installed, _, remaining, native_args, _, _ = self.run_case(install=37)
        self.assertEqual(result.returncode, 37)
        self.assertTrue(installed)
        self.assertNotIn('To start dsh', result.stdout)
        self.assertEqual(native_args, [])
        self.assertEqual(remaining, [])

    def test_first_install_waits_for_loading_before_registering(self):
        result, _, _, _, _, native_args, _, _ = self.run_case(detect_failures=1, input_text='\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('enable Developer mode and load:', result.stdout)
        self.assertEqual(native_args, ['native:install', '--extension-id', 'a' * 32])

    def test_manual_id_resolves_multiple_loaded_copies(self):
        result, _, _, _, _, native_args, _, _ = self.run_case(detect_failures=99, input_text='b' * 32 + '\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(native_args, ['native:install', '--extension-id', 'b' * 32])

    def test_invalid_id_is_not_registered(self):
        result, _, _, _, _, native_args, _, _ = self.run_case(detect_failures=99, input_text='bad-id\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(native_args, [])
        self.assertIn('Invalid extension ID', result.stderr)

    def test_unloaded_extension_without_input_is_not_success(self):
        result, _, _, _, remaining, native_args, _, _ = self.run_case(detect_failures=99)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(native_args, [])
        self.assertNotIn('Extension files and native companion are updated.', result.stdout)
        self.assertEqual(remaining, [])

    def test_native_registration_failure_is_propagated(self):
        result, _, _, _, remaining, native_args, _, _ = self.run_case(native=41)
        self.assertEqual(result.returncode, 41)
        self.assertTrue(native_args)
        self.assertNotIn('Extension files and native companion are updated.', result.stdout)
        self.assertEqual(remaining, [])


@unittest.skipUnless(os.name != 'nt' and shutil.which('rsync'), 'Requires Unix rsync')
class UnixManagedUpdate(unittest.TestCase):
    def test_source_sync_preserves_task_workspaces_and_local_agent_files(self):
        with tempfile.TemporaryDirectory(prefix='tandix managed update ') as directory:
            work = Path(directory)
            source = work / 'source'
            for name in ['package.json', 'pnpm-lock.yaml', 'extensions/dsh-browser/package.json',
                         'packages/browser/bridge-browser/package.json']:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}')
            entry = ROOT / 'scripts/install/source-unix.sh'
            script = source / 'scripts/install/source-unix.sh'
            script.parent.mkdir(parents=True)
            shutil.copyfile(entry, script)
            (source / 'new-source.txt').write_text('new source')
            archive = work / 'source.tar.gz'
            with tarfile.open(str(archive), 'w:gz') as tar:
                tar.add(str(source), arcname='tandix-main')
            managed = work / 'dsh/dsh-browser'
            managed.mkdir(parents=True)
            (managed / '.managed-by-install-sh').touch()
            preserved = ['workspace/output/report.txt', 'output/report.txt', '.agents/skills/local.txt',
                         '.codex/local.txt', 'node_modules/cache.txt']
            for name in preserved:
                path = managed / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('keep local file')
            (managed / 'obsolete-source.txt').write_text('old source')
            tools = work / 'bin'
            tools.mkdir()
            for name, body in {
                'curl': '#!/bin/bash\nfor destination in "$@"; do :; done\ncp "$TEST_ARCHIVE" "$destination"\n',
                'node': '#!/bin/bash\nexit 0\n',
                'pnpm': '#!/bin/bash\nexit 37\n',
            }.items():
                path = tools / name
                path.write_text(body)
                path.chmod(0o755)
            standalone = work / 'install.sh'
            shutil.copyfile(entry, standalone)
            result = subprocess.run(['/bin/bash', str(standalone)], env={**os.environ,
                'PATH': str(tools) + ':/usr/bin:/bin', 'DSH_HOME': str(work / 'dsh'),
                'TEST_ARCHIVE': str(archive), 'TMPDIR': str(work)}, text=True, capture_output=True)
            # Stop before installing dependencies: exercise the real archive sync without network or installs.
            self.assertEqual(result.returncode, 37, result.stdout + result.stderr)
            self.assertEqual((managed / 'new-source.txt').read_text(), 'new source')
            self.assertFalse((managed / 'obsolete-source.txt').exists())
            for name in preserved:
                self.assertEqual((managed / name).read_text(), 'keep local file', name)


@unittest.skipUnless(os.name == 'nt', 'Windows PowerShell harness')
class WindowsSourceInstaller(unittest.TestCase):
    def run_case(self, stage='', healthy=True, agent='dsh', agents=('dsh',), ready_agents=None):
        with tempfile.TemporaryDirectory(prefix='tandix setup ') as directory:
            work = Path(directory)
            cursor = work / 'scripts/runtime/cursor-bridge.mjs'
            cursor.parent.mkdir(parents=True)
            cursor.write_text('export function findCursorAgent() { return process.execPath }')
            harness = work / 'harness.ps1'
            harness.write_text(r'''$ErrorActionPreference = 'Stop'
. $env:TEST_ENTRY -FunctionsOnly -NonInteractive -Agents ($env:TEST_AGENTS -split ',') -Agent $env:TEST_AGENT -InstallHome (Join-Path $env:TEST_WORK 'install')
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
function Install-AgentCli { return (Get-Command node.exe).Source }
function Register-Companion { Record 'register' }
function Test-AgentConnection {
  param([string]$Backend)
  Record 'check'
  $status = if (($env:TEST_READY_AGENTS -split ',') -contains $Backend) { 'ready' } else { 'failed' }
  return [pscustomobject]@{backend=$Backend;status=$status;message='simulated result'}
}
try { Invoke-TandixSetup; exit 0 } catch { exit 1 }
''')
            available = ready_agents if ready_agents is not None else (('dsh',) if healthy else ())
            env = {**os.environ, 'TEST_WORK': str(work), 'TEST_ENTRY': str(ROOT / 'scripts/install/windows.ps1'),
                   'TEST_FAIL_STAGE': stage, 'TEST_AGENT': agent, 'TEST_AGENTS': ','.join(agents),
                   'TEST_READY_AGENTS': ','.join(available)}
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

    def test_auto_selects_first_ready_agent_in_priority_order(self):
        priority = ('codex', 'cursor', 'workbuddy', 'dsh')
        for index, selected in enumerate(priority):
            with self.subTest(selected=selected):
                result, _, report = self.run_case(agent='auto', agents=tuple(reversed(priority)),
                                                  ready_agents=priority[index:])
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                self.assertEqual([entry['backend'] for entry in report['agents']], list(priority))
                self.assertEqual(report['selectedAgent'], selected)
                self.assertTrue(report['selectedAgentReady'])

    def test_auto_fails_when_no_agent_is_ready(self):
        result, _, report = self.run_case(agent='auto', agents=('codex', 'cursor', 'workbuddy', 'dsh'),
                                          ready_agents=())
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(report['selectedAgentReady'])

    def test_explicit_agent_does_not_fall_back_to_another_ready_agent(self):
        result, _, report = self.run_case(agent='codex', agents=('codex', 'dsh'), ready_agents=('dsh',))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['selectedAgent'], 'codex')
        self.assertFalse(report['selectedAgentReady'])

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
