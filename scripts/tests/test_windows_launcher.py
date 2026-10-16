"""Exercise the actual double-click launcher, including its standalone download."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[2]
WIZARD_URL = 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install-windows.ps1'
FIXTURE = r'''param([switch]$Help, [string]$Agent, [string]$InstallHome)
$PSBoundParameters | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:TEST_WORK 'arguments.json') -Encoding UTF8
exit ([int]$env:TEST_EXIT_CODE)
'''


@unittest.skipUnless(os.name == 'nt', 'Requires the Windows command interpreter')
class WindowsDoubleClickLauncher(unittest.TestCase):
    def run_case(self, local=False, download_status=200, child_status=0):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(download_status)
                self.end_headers()
                self.wfile.write(FIXTURE.encode('ascii'))

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="Tandix launcher's files ") as directory:
                work = Path(directory)
                launcher = work / '安装网页助手.cmd'
                source = (ROOT / launcher.name).read_text()
                # Only redirect the vendor URL; execute the production batch logic unchanged.
                source = source.replace(WIZARD_URL, f'http://127.0.0.1:{server.server_port}/wizard.ps1')
                launcher.write_bytes(source.replace('\n', '\r\n').encode('ascii'))
                if local:
                    scripts = work / 'scripts'
                    scripts.mkdir()
                    (scripts / 'install-windows.ps1').write_text(FIXTURE)
                env = {**os.environ, 'TEMP': str(work), 'TEST_WORK': str(work),
                       'TEST_LAUNCHER': str(launcher), 'TEST_EXIT_CODE': str(child_status),
                       'TANDIX_INSTALL_NO_PAUSE': '1'}
                command = 'call "%TEST_LAUNCHER%" -Agent workbuddy -InstallHome "%TEST_WORK%\\custom install"'
                result = subprocess.run(['cmd.exe', '/d', '/c', command], env=env,
                                        capture_output=True, encoding='utf-8', errors='replace', timeout=30)
                args_file = work / 'arguments.json'
                args = json.loads(args_file.read_text(encoding='utf-8-sig')) if args_file.exists() else None
                remaining = list(work.glob('Tandix-setup-*'))
                return result, args, requests, remaining, str(work / 'custom install')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_standalone_file_downloads_and_forwards_arguments(self):
        result, args, requests, remaining, install_home = self.run_case()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(requests, ['/wizard.ps1'])
        self.assertEqual(args, {'Agent': 'workbuddy', 'InstallHome': install_home})
        self.assertEqual(remaining, [])

    def test_source_checkout_uses_local_installer(self):
        result, args, requests, remaining, _ = self.run_case(local=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(args['Agent'], 'workbuddy')
        self.assertEqual(requests, [])
        self.assertEqual(remaining, [])

    def test_failed_download_does_not_execute_partial_script(self):
        result, args, requests, remaining, _ = self.run_case(download_status=503)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(args)
        self.assertEqual(requests, ['/wizard.ps1'])
        self.assertEqual(remaining, [])

    def test_child_failure_is_propagated_and_cleaned(self):
        result, args, _, remaining, _ = self.run_case(child_status=37)
        self.assertEqual(result.returncode, 37, result.stdout + result.stderr)
        self.assertIsNotNone(args)
        self.assertIn('Setup failed', result.stdout)
        self.assertEqual(remaining, [])


if __name__ == '__main__':
    unittest.main()
