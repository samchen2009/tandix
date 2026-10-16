"""Catch broken file references when installers and runtime modules are moved."""
import ast
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ScriptLayout(unittest.TestCase):
    def test_release_manifests_reference_existing_scripts(self):
        for packager in (ROOT / 'scripts/release').glob('*.py'):
            tree = ast.parse(packager.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    path = node.value
                    if path == 'scripts/install-codex-only.mjs':
                        continue  # Historical ZIPs retain their original installer paths.
                    if path.startswith('scripts/') and Path(path).suffix in {'.mjs', '.ps1', '.sh', '.cs', '.json', '.md'}:
                        with self.subTest(packager=packager.name, path=path):
                            self.assertTrue((ROOT / path).is_file(), path)

    def test_relative_runtime_imports_exist(self):
        for directory in ['runtime', 'install', 'cli', 'dev', 'tests']:
            for module in (ROOT / 'scripts' / directory).glob('*.mjs'):
                for path in re.findall(r"\bfrom\s+['\"]([^'\"]+)['\"]", module.read_text()):
                    if path.startswith('.'):
                        with self.subTest(module=module.name, path=path):
                            self.assertTrue((module.parent / path).is_file(), path)


@unittest.skipIf(os.name == 'nt', 'Unix shell compatibility entries')
class UnixCompatibilityEntries(unittest.TestCase):
    def run_case(self, entry, local=False, via_stdin=False):
        with tempfile.TemporaryDirectory(prefix='Tandix compatibility ') as directory:
            work = Path(directory)
            source = (ROOT / 'scripts' / entry).read_text()
            wrapper = work / entry
            wrapper.write_text(source)
            fixture = '#!/bin/bash\nprintf "forwarded:%s\\n" "$1"\nexit 37\n'
            if local:
                target = work / 'install' / ('macos.sh' if entry == 'install-macos.sh' else 'source-unix.sh')
                target.parent.mkdir()
                target.write_text(fixture)
            tools = work / 'bin'
            tools.mkdir()
            curl = tools / 'curl'
            curl.write_text('#!/bin/bash\nfor arg in "$@"; do destination="$arg"; done\ncp "$TEST_FIXTURE" "$destination"\n')
            curl.chmod(0o755)
            (work / 'fixture.sh').write_text(fixture)
            env = {**os.environ, 'PATH': str(tools) + ':/usr/bin:/bin', 'TMPDIR': str(work),
                   'TEST_FIXTURE': str(work / 'fixture.sh')}
            command = ['/bin/bash', '-s', '--', 'argument with spaces'] if via_stdin else ['/bin/bash', str(wrapper), 'argument with spaces']
            result = subprocess.run(command, input=source if via_stdin else None, text=True,
                                    capture_output=True, env=env)
            self.assertEqual(result.returncode, 37, result.stderr + result.stdout)
            self.assertEqual(result.stdout.strip(), 'forwarded:argument with spaces')
            self.assertEqual(list(work.glob('tandix-entry.*')), [])

    def test_local_entries_forward_arguments_and_exit_status(self):
        for entry in ['install.sh', 'install-macos.sh']:
            with self.subTest(entry=entry):
                self.run_case(entry, local=True)

    def test_downloaded_entries_forward_and_clean_up(self):
        for entry in ['install.sh', 'install-macos.sh']:
            with self.subTest(entry=entry):
                self.run_case(entry)

    def test_piped_legacy_entry_still_works(self):
        self.run_case('install.sh', via_stdin=True)


@unittest.skipUnless(os.name == 'nt' or os.environ.get('TANDIX_TEST_POWERSHELL'), 'Requires PowerShell')
class PowerShellCompatibilityEntries(unittest.TestCase):
    def test_local_entries_forward_named_parameters_and_exit_status(self):
        executable = os.environ.get('TANDIX_TEST_POWERSHELL') or shutil.which('powershell.exe')
        for entry in ['install.ps1', 'install-windows.ps1']:
            with self.subTest(entry=entry), tempfile.TemporaryDirectory(prefix='Tandix PowerShell ') as directory:
                work = Path(directory)
                shutil.copyfile(ROOT / 'scripts' / entry, work / entry)
                target = work / 'install/windows.ps1'
                target.parent.mkdir()
                target.write_text("param([string]$Agent, [switch]$Help)\nif ($Agent -ne 'workbuddy' -or -not $Help) { exit 2 }; exit 37\n")
                result = subprocess.run([executable, '-NoProfile', '-File', str(work / entry),
                                         '-Agent', 'workbuddy', '-Help'], capture_output=True, text=True)
                self.assertEqual(result.returncode, 37, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
