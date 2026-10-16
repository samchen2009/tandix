import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerChromeNativeHost } from '../traceforge-native-host.mjs'

const extensionId = 'a'.repeat(32)

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tandix native registration '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { workspace: root, hostDir: join(root, 'host'), hostPath: join(root, 'host', 'host.mjs'),
    macManifestPath: join(root, 'manifest.json'), extensionId, nodePath: process.execPath }
}

test('Windows source companion compiles an executable and registers only the current user', t => {
  const options = fixture(t)
  const calls = []
  const manifestPath = registerChromeNativeHost({ ...options, platform: 'win32', run(command, args) {
    calls.push({ command, args })
    if (command === 'powershell.exe') writeFileSync(args[args.indexOf('-OutputPath') + 1], 'test proxy')
    return { status: 0 }
  } })
  assert.equal(calls[0].command, 'powershell.exe')
  assert.ok(calls[0].args.includes(join(options.workspace, 'scripts', 'tandix-native-proxy.cs')))
  assert.ok(calls[0].args.includes(options.hostPath))
  assert.deepEqual(calls[1], { command: 'reg.exe', args: ['ADD',
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\io.traceforge.bridge',
    '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'] })
  const manifest = JSON.parse(readFileSync(manifestPath))
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`])
  assert.equal(manifest.type, 'stdio')
  assert.ok(existsSync(manifest.path))
})

test('failed Windows compilation never registers a host', t => {
  const options = fixture(t)
  const calls = []
  assert.throws(() => registerChromeNativeHost({ ...options, platform: 'win32', run(command) {
    calls.push(command)
    return { status: 1 }
  } }), /Could not compile/)
  assert.deepEqual(calls, ['powershell.exe'])
})

test('failed Windows registry writes are reported', t => {
  const options = fixture(t)
  assert.throws(() => registerChromeNativeHost({ ...options, platform: 'win32', run(command, args) {
    if (command === 'powershell.exe') {
      writeFileSync(args[args.indexOf('-OutputPath') + 1], 'test proxy')
      return { status: 0 }
    }
    return { status: 1 }
  } }), /Could not register/)
})

test('macOS registration keeps the shell wrapper and allowlisted manifest', t => {
  const options = fixture(t)
  const manifestPath = registerChromeNativeHost({ ...options, platform: 'darwin', searchPath: '/test/bin',
    run() { assert.fail('macOS does not compile or write a registry key') } })
  const manifest = JSON.parse(readFileSync(manifestPath))
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`])
  assert.match(readFileSync(manifest.path, 'utf8'), /\/test\/bin/)
  assert.ok(readFileSync(manifest.path, 'utf8').includes(options.hostPath))
})

test('real Windows proxy preserves native messaging bytes in paths containing spaces', { skip: process.platform !== 'win32' }, t => {
  const options = fixture(t)
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const manifestPath = registerChromeNativeHost({ ...options, workspace, run(command, args, settings) {
    // Compile the real proxy, but keep the disposable test out of the registry.
    return command === 'reg.exe' ? { status: 0 } : spawnSync(command, args, settings)
  } })
  writeFileSync(options.hostPath, 'process.stdin.pipe(process.stdout)\n')
  const manifest = JSON.parse(readFileSync(manifestPath))
  const payload = Buffer.from(JSON.stringify({ type: 'ensure', backend: 'workbuddy' }))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  const input = Buffer.concat([header, payload])
  const result = spawnSync(manifest.path, [], { input, timeout: 15_000 })
  assert.equal(result.status, 0, String(result.stderr || result.error))
  assert.deepEqual(result.stdout, input)
})
