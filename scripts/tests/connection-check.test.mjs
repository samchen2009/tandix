import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { checkConnection } from '../runtime/connection-check.mjs'
import { nativeEnvironment } from '../runtime/native-host.mjs'
import { stopAgentProcess } from '../runtime/runtime-discovery.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

test('Windows cleanup targets only the owned CLI process tree', () => {
  let killed = false
  const child = { pid: 123, exitCode: null, signalCode: null, kill() { killed = true } }
  const calls = []
  stopAgentProcess(child, { platform: 'win32', run(command, args) { calls.push([command, args]); return { status: 0 } } })
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '123', '/T', '/F']]])
  assert.equal(killed, false)
  stopAgentProcess(child, { platform: 'win32', run() { return { status: 1 } } })
  assert.equal(killed, true)
})

test('Windows native environment preserves private tools, handles Path casing and saves DSH_HOME', () => {
  const result = nativeEnvironment({ searchPath: 'C:\\tools;C:\\Windows', dshHome: 'D:\\DSH data' },
    { env: { Path: 'old', TOKEN: 'kept' }, nodePath: '/node/node.exe', separator: ';' })
  assert.equal(result.PATH, '/node;C:\\tools;C:\\Windows')
  assert.equal(result.Path, undefined)
  assert.equal(result.TOKEN, 'kept')
  assert.equal(result.DSH_HOME, 'D:\\DSH data')
})

test('connection checker rejects an invalid native response without reporting readiness', { timeout: 5000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'tandix broken native '))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const fake = join(temp, 'broken.mjs')
  writeFileSync(fake, "process.stdin.once('data',()=>{process.stdout.write(Buffer.from([255,255,255,255]));})")
  await assert.rejects(checkConnection({ executable: process.execPath, args: [fake], backend: 'dsh',
    runtimePath: cli, extensionId: 'a'.repeat(32), timeoutMs: 1000 }), /Invalid native messaging/)
})

test('real dsh starts on demand through the native protocol and accepts hello plus session-list', { timeout: 150_000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'tandix complete install '))
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const home = join(temp, 'home')
  const dshHome = join(home, '.dsh')
  const hostDir = join(dshHome, 'traceforge-native-host')
  mkdirSync(hostDir, { recursive: true })
  const extensionId = 'a'.repeat(32)
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }
  delete env.DSH_EXT_TOKEN
  delete env.CODEX_CLI_PATH
  delete env.DSH_BROWSER_SESSION_WORKSPACE
  // A real profile, real Cordis plugin and real dsh runtime; no model or account.
  const profileDir = join(dshHome, 'profiles', 'web')
  const child = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'install'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', value => { log += value })
  child.stderr.on('data', value => { log += value })
  child.once('error', error => { log += String(error) })
  const killed = setTimeout(() => child.kill(), 90_000)
  const [code] = await once(child, 'exit')
  clearTimeout(killed)
  assert.equal(code, 0, log)
  const manifestPath = join(profileDir, 'package.json')
  const profile = JSON.parse(readFileSync(manifestPath))
  const plugin = '@yuxianglin/dsh-bridge-browser'
  profile.dependencies[plugin] = `link:${join(root, 'packages', 'browser', 'bridge-browser').replaceAll('\\', '/')}`
  profile.dsh.profile.bundles = [...new Set([...(profile.dsh.profile.bundles ?? []), plugin])]
  writeFileSync(manifestPath, JSON.stringify(profile, null, 2))
  // Junction/symlink matches the Windows installer without passing an absolute
  // package spec through cmd.exe; profile dependencies already come from dsh.
  const { symlinkSync } = await import('node:fs')
  const target = join(profileDir, 'node_modules', '@yuxianglin', 'dsh-bridge-browser')
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(join(root, 'packages', 'browser', 'bridge-browser'), target, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(hostDir, 'config.json'), JSON.stringify({ cliPath: cli, workspace: root, extensionId,
    searchPath: process.env.PATH, dshHome, reuseExternalDsh: false }))
  const host = join(hostDir, 'host.mjs')
  copyFileSync(join(root, 'scripts', 'runtime', 'native-host.mjs'), host)
  copyFileSync(join(root, 'scripts', 'runtime', 'runtime-discovery.mjs'), join(hostDir, 'runtime-discovery.mjs'))
  copyFileSync(join(root, 'scripts', 'runtime', 'skills-store.mjs'), join(hostDir, 'skills-store.mjs'))
  const result = await checkConnection({ executable: process.execPath, args: [host], backend: 'dsh',
    runtimePath: realpathSync(cli), extensionId, env, timeoutMs: 90_000 }).catch(error => {
      let detail = ''
      try { detail = readFileSync(join(hostDir, 'dsh.log'), 'utf8').slice(-6000) } catch { }
      throw new Error(`${error.message}\n${detail}`, { cause: error })
    })
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.checks, ['native-messaging', 'backend-identity', 'websocket-hello', 'session-list'])
})

test('WorkBuddy native connection checks reach a real ACP process and verify a session without creating Tandix history', { timeout: 20_000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'tandix ACP native '))
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const home = join(temp, 'home')
  const hostDir = join(home, '.dsh', 'traceforge-native-host')
  mkdirSync(hostDir, { recursive: true })
  const extensionId = 'a'.repeat(32)
  const fixture = join(root, 'scripts', 'tests', 'fixtures', 'workbuddy-acp.mjs')
  let agent = fixture
  if (process.platform === 'win32') {
    agent = join(temp, 'codebuddy with spaces.cmd')
    writeFileSync(agent, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
  }
  writeFileSync(join(hostDir, 'config.json'), JSON.stringify({ cliPath: cli, workspace: root, extensionId,
    searchPath: process.env.PATH, workbuddyAgentPath: agent }))
  const host = join(hostDir, 'host.mjs')
  copyFileSync(join(root, 'scripts', 'runtime', 'native-host.mjs'), host)
  copyFileSync(join(root, 'scripts', 'runtime', 'runtime-discovery.mjs'), join(hostDir, 'runtime-discovery.mjs'))
  copyFileSync(join(root, 'scripts', 'runtime', 'skills-store.mjs'), join(hostDir, 'skills-store.mjs'))
  const result = await checkConnection({ executable: process.execPath, args: [host], backend: 'workbuddy',
    runtimePath: realpathSync(cli), extensionId, env: { ...process.env, HOME: home, USERPROFILE: home }, timeoutMs: 15_000 })
  assert.equal(result.status, 'ready')
  assert.ok(result.checks.includes('acp-session-authentication'))
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(hostDir, 'workbuddy-sessions.json')), false)
})
