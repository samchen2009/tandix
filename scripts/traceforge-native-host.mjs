#!/usr/bin/env node
/**
 * macOS/Windows Chrome Native Messaging host for on-demand TraceForge bridge startup.
 * Only the fixed "ensure" request is accepted; it never executes browser-supplied
 * commands or paths. Chrome's host manifest restricts callers to one extension ID.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findCodex, nativeHostWrapper } from './traceforge-runtime-discovery.mjs'

const HOST_NAME = 'io.traceforge.bridge'
const HOST_DIR = join(homedir(), '.dsh', 'traceforge-native-host')
const HOST_PATH = join(HOST_DIR, 'host.mjs')
const CONFIG_PATH = join(HOST_DIR, 'config.json')
const LOG_PATH = join(HOST_DIR, 'dsh.log')
const MANIFEST_PATH = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`)
const PORTS = [3080, 3081, 3090, 14389, 43189]
const SOURCE_PATH = fileURLToPath(import.meta.url)
const DISCOVERY_SOURCE_PATH = join(dirname(SOURCE_PATH), 'traceforge-runtime-discovery.mjs')
const MAX_MESSAGE_BYTES = 1024 * 1024

function extensionBuildHash(root) {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue
      const path = join(directory, entry.name)
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) visit(path, `${relative}/`)
      else if (entry.isFile()) {
        const content = readFileSync(path)
        files += 1
        bytes += content.length
        if (files > 5000 || bytes > 64 * 1024 * 1024) throw new Error('Extension directory is too large to identify automatically.')
        hash.update(relative).update('\0').update(content)
      } else throw new Error('Extension directory contains an unsupported file type.')
    }
  }
  visit(root)
  return files > 0 ? hash.digest('hex') : null
}

function registeredExtensionId(configPath, manifestPath) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const id = config.extensionId
    if (config.mode === 'codex-only' && manifest.name === HOST_NAME && /^[a-p]{32}$/u.test(id)
      && manifest.allowed_origins?.includes(`chrome-extension://${id}/`)) return id
  } catch { /* A previous install may not exist yet. */ }
  return null
}

export function currentExtensionId(workspace, { platform = process.platform, home = homedir(),
  chromeHome = platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
    : join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  configPath = join(home, '.dsh', 'traceforge-native-host', 'config.json'),
  manifestPath = platform === 'win32'
    ? join(home, '.dsh', 'traceforge-native-host', `${HOST_NAME}.json`)
    : join(chromeHome, 'NativeMessagingHosts', `${HOST_NAME}.json`),
} = {}) {
  const candidatePaths = [join(workspace, 'extensions', 'dsh-browser', 'dist'), join(home, '.dsh', 'browser-extension')]
  const canonical = path => {
    const value = realpathSync(path)
    return platform === 'win32' ? value.toLowerCase() : value
  }
  const expected = new Set(candidatePaths.filter(existsSync).map(canonical))
  const expectedBuilds = new Map()
  for (const path of expected) {
    try {
      const manifest = readFileSync(join(path, 'manifest.json'))
      expectedBuilds.set(extensionBuildHash(path), manifest)
    } catch { /* Ignore an incomplete old installation. */ }
  }
  const previousId = registeredExtensionId(configPath, manifestPath)
  const profiles = []
  try {
    profiles.push(...readdirSync(chromeHome, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/u.test(entry.name)))
      .map(entry => entry.name))
  } catch { /* Chrome may not have a profile yet. */ }
  const exactIds = new Set()
  const buildIds = new Set()
  const loadedIds = new Set()
  const checkedBuilds = new Map()
  for (const profile of profiles) {
    for (const name of ['Secure Preferences', 'Preferences']) {
      let prefs
      try { prefs = JSON.parse(readFileSync(join(chromeHome, profile, name), 'utf8')) }
      catch { continue }
      for (const [id, entry] of Object.entries(prefs.extensions?.settings ?? {})) {
        if (!/^[a-p]{32}$/u.test(id) || typeof entry?.path !== 'string' || !isAbsolute(entry.path)) continue
        let path
        try { path = canonical(entry.path) } catch { continue }
        loadedIds.add(id)
        if (expected.has(path)) { exactIds.add(id); continue }
        if (!expectedBuilds.size) continue
        if (!checkedBuilds.has(path)) {
          try {
            const manifest = readFileSync(join(path, 'manifest.json'))
            if ([...expectedBuilds.values()].some(expectedManifest => expectedManifest.equals(manifest))) {
              checkedBuilds.set(path, expectedBuilds.has(extensionBuildHash(path)))
            } else checkedBuilds.set(path, false)
          } catch { checkedBuilds.set(path, false) }
        }
        if (checkedBuilds.get(path)) buildIds.add(id)
      }
    }
  }
  const ids = exactIds.size ? exactIds : buildIds
  if (ids.size === 1) return [...ids][0]
  if (previousId && (ids.has(previousId) || (ids.size === 0 && loadedIds.has(previousId)))) return previousId
  const error = new Error(`Expected one loaded Tandix Chrome extension ID, found ${ids.size}. Pass --extension-id <id> from chrome://extensions.`)
  error.code = ids.size === 0 ? 'EXTENSION_NOT_SAVED' : 'EXTENSION_AMBIGUOUS'
  throw error
}

export async function waitForExtensionId(workspace, { timeoutMs = 20_000, intervalMs = 1000,
  onWaiting = () => {}, ...options } = {}) {
  const deadline = Date.now() + timeoutMs
  let notified = false
  while (true) {
    try { return currentExtensionId(workspace, options) }
    catch (error) {
      if (error.code !== 'EXTENSION_NOT_SAVED' || Date.now() >= deadline) throw error
      if (!notified) { onWaiting(); notified = true }
      await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())))
    }
  }
}

async function installCodex() {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Codex-only native host supports macOS and Windows Chrome.')
  const workspace = resolve(dirname(SOURCE_PATH), '..')
  const args = process.argv.slice(3)
  const extensionId = args.length === 2 && args[0] === '--extension-id'
    ? args[1] : args.length === 0 ? await waitForExtensionId(workspace, {
      onWaiting: () => process.stdout.write('Waiting for Chrome to save the loaded extension configuration...\n'),
    }) : null
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('Pass a valid --extension-id from chrome://extensions.')
  }
  const runtimePath = join(workspace, 'package.json')
  const require = createRequire(runtimePath)
  for (const name of ['ws', '@modelcontextprotocol/sdk/server/mcp.js', 'zod']) {
    try { require.resolve(name) } catch { throw new Error(`Codex runtime dependency ${name} is missing; rerun the installer.`) }
  }
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  copyFileSync(SOURCE_PATH, HOST_PATH)
  copyFileSync(DISCOVERY_SOURCE_PATH, join(HOST_DIR, 'traceforge-runtime-discovery.mjs'))
  writeFileSync(CONFIG_PATH, JSON.stringify({ mode: 'codex-only', runtimePath, workspace,
    codexHome: process.env.CODEX_HOME ?? null,
    workbuddyAgentPath: process.env.WORKBUDDY_AGENT_PATH ?? null, extensionId }, null, 2) + '\n', { mode: 0o600 })

  registerChromeNativeHost({ workspace, extensionId })
  process.stdout.write(`Registered ${HOST_NAME} for Chrome extension ${extensionId}. Reload Tandix in chrome://extensions.\n`)
}

export function registerChromeNativeHost({ workspace, extensionId, hostDir = HOST_DIR, hostPath = HOST_PATH,
  platform = process.platform, nodePath = process.execPath, searchPath = process.env.PATH ?? '',
  macManifestPath = MANIFEST_PATH, run = spawnSync }) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Native host supports macOS and Windows Chrome only.')
  if (!/^[a-p]{32}$/u.test(extensionId)) throw new Error('Invalid Chrome extension ID.')
  const wrapperPath = join(hostDir, 'host.sh')
  mkdirSync(hostDir, { recursive: true, mode: 0o700 })
  let manifestPath
  let executablePath
  if (platform === 'darwin') {
    manifestPath = macManifestPath
    executablePath = wrapperPath
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(wrapperPath, nativeHostWrapper({ hostPath,
      searchPath, nodeHint: nodePath }), { mode: 0o700 })
    chmodSync(wrapperPath, 0o700)
  } else {
    manifestPath = join(hostDir, `${HOST_NAME}.json`)
    executablePath = join(hostDir, `native-host-${Date.now()}.exe`)
    const compiler = join(workspace, 'scripts', 'install-codex-windows-host.ps1')
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', compiler, '-Source', join(workspace, 'scripts', 'tandix-native-proxy.cs'),
      '-OutputPath', executablePath, '-HostPath', hostPath, '-NodePath', nodePath],
    { stdio: 'inherit' })
    if (result.status !== 0 || !existsSync(executablePath)) throw new Error('Could not compile the Windows native host.')
  }
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (previous.name !== HOST_NAME) throw new Error(`Refusing to replace unrelated native host: ${manifestPath}`)
  }
  writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME,
    description: 'Tandix local agent companion', path: executablePath,
    type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2) + '\n', { mode: 0o600 })
  if (platform === 'win32') {
    const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
    const result = run('reg.exe', ['ADD', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
      { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('Could not register the Windows native messaging host.')
  }
  return manifestPath
}
function install() {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Native host installation supports macOS and Windows Chrome only.')
  const workspace = resolve(dirname(SOURCE_PATH), '..')
  const args = process.argv.slice(3)
  let extensionId
  if (args.length === 2 && args[0] === '--extension-id') extensionId = args[1]
  else if (args.length === 0) extensionId = currentExtensionId(workspace)
  else throw new Error('Usage: node scripts/traceforge-native-host.mjs install [--extension-id <id>]')
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid Chrome extension ID.')

  const cliPath = join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cliPath)) throw new Error(`dsh CLI not found at ${cliPath}; run pnpm install first.`)

  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  copyFileSync(SOURCE_PATH, HOST_PATH)
  copyFileSync(DISCOVERY_SOURCE_PATH, join(HOST_DIR, 'traceforge-runtime-discovery.mjs'))
  writeFileSync(CONFIG_PATH, JSON.stringify({ cliPath, workspace,
    codexHome: process.env.CODEX_HOME ?? null,
    workbuddyAgentPath: process.env.WORKBUDDY_AGENT_PATH ?? null, extensionId }, null, 2) + '\n', { mode: 0o600 })
  registerChromeNativeHost({ workspace, extensionId })
  process.stdout.write(`Registered ${HOST_NAME} for extension ${extensionId}. Reload Tandix in chrome://extensions.\n`)
}

let ownedChild = null
let ownedChildSandboxDirectory = ''
let codexBridge = null
let workbuddyBridge = null
let stopping = false
let ensureQueue = Promise.resolve()

function stopOwnedChild() {
  if (ownedChild?.pid === undefined) return
  try {
    if (process.platform === 'win32') ownedChild.kill()
    else process.kill(-ownedChild.pid, 'SIGTERM')
  } catch { /* Already exited. */ }
  ownedChild = null
  ownedChildSandboxDirectory = ''
}

function normalizeSandboxDirectory(value) {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('Invalid sandbox directory.')
  const path = value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path)) throw new Error('Sandbox directory must be an absolute path.')
  const normalized = resolve(path)
  if (normalized === parse(normalized).root || normalized === homedir()) throw new Error('Choose a specific folder, not the filesystem or home directory.')
  mkdirSync(normalized, { recursive: true, mode: 0o700 })
  const canonical = realpathSync(normalized)
  if (canonical === parse(canonical).root || canonical === homedir() || !statSync(canonical).isDirectory()) {
    throw new Error('Choose a specific directory, not the filesystem or home directory.')
  }
  return canonical
}

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  stopOwnedChild()
  codexBridge?.close()
  workbuddyBridge?.close()
  process.exit(code)
}

async function probeBridge() {
  const results = await Promise.all(PORTS.map(async port => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, { signal: AbortSignal.timeout(700) })
      if (!response.ok) return null
      const body = await response.json()
      const expected = `ws://127.0.0.1:${port}/ext/bridge`
      return body?.wsUrl === expected ? expected : null
    } catch { return null }
  }))
  return results.find(Boolean) ?? null
}

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  process.stdout.write(Buffer.concat([header, payload]))
}

async function ensureBridge(preference = 'auto', requestedSandboxDirectory = '') {
  const sandboxDirectory = normalizeSandboxDirectory(requestedSandboxDirectory)
  if (preference === 'workbuddy' && workbuddyBridge?.isReady && workbuddyBridge.sandboxDirectory === sandboxDirectory) return workbuddyBridge.wsUrl
  if (preference !== 'workbuddy') { workbuddyBridge?.close(); workbuddyBridge = null }
  if (preference === 'workbuddy') {
    codexBridge?.close(); codexBridge = null
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const { WorkBuddyBridge, findWorkBuddyAgent } = await import(pathToFileURL(join(config.workspace, 'scripts', 'traceforge-workbuddy-bridge.mjs')).href)
    const agentPath = findWorkBuddyAgent({ env: { ...process.env,
      ...(typeof config.workbuddyAgentPath === 'string' ? { WORKBUDDY_AGENT_PATH: config.workbuddyAgentPath } : {}) } })
    if (!agentPath) throw new Error('WorkBuddy ACP runtime was not found. Install and sign in to the compatible CodeBuddy CLI, or set WORKBUDDY_AGENT_PATH and reinstall the companion.')
    workbuddyBridge?.close()
    workbuddyBridge = await WorkBuddyBridge.open({ agentPath, nodePath: process.execPath,
      runtimePath: config.runtimePath ?? config.cliPath, workspace: config.workspace, hostDir: HOST_DIR,
      extensionId: config.extensionId, sandboxDirectory })
    stopOwnedChild()
    return workbuddyBridge.wsUrl
  }
  if (preference !== 'dsh' && codexBridge?.isReady && codexBridge.sandboxDirectory === sandboxDirectory) return codexBridge.wsUrl
  codexBridge?.close()
  codexBridge = null
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const codexPath = findCodex({ savedPath: config.codexPath })
  if (config.mode === 'codex-only') {
    if (preference === 'dsh') throw new Error('This Tandix installation supports Codex only. Select Codex or Auto in the side panel.')
    if (codexPath === null) throw new Error('Codex CLI was not found. Install Codex and sign in, then reconnect.')
    const { CodexBridge } = await import(pathToFileURL(join(config.workspace, 'scripts', 'traceforge-codex-bridge.mjs')).href)
    codexBridge = await CodexBridge.open({
      codexPath, nodePath: process.execPath, runtimePath: config.runtimePath,
      workspace: config.workspace, hostDir: HOST_DIR, extensionId: config.extensionId, sandboxDirectory,
      codexHome: typeof config.codexHome === 'string' && isAbsolute(config.codexHome) ? config.codexHome : null,
    })
    return codexBridge.wsUrl
  }
  if (preference !== 'dsh' && codexPath !== null) {
    try {
      const { CodexBridge } = await import(pathToFileURL(join(config.workspace, 'scripts', 'traceforge-codex-bridge.mjs')).href)
      codexBridge = await CodexBridge.open({
        codexPath, nodePath: process.execPath, runtimePath: config.cliPath,
        workspace: config.workspace, hostDir: HOST_DIR, extensionId: config.extensionId, sandboxDirectory,
        codexHome: typeof config.codexHome === 'string' && config.codexHome.startsWith('/') ? config.codexHome : null,
      })
      stopOwnedChild()
      return codexBridge.wsUrl
    } catch (error) {
      if (preference === 'codex') throw error
      process.stderr.write(`Tandix: Codex unavailable (${error instanceof Error ? error.message : String(error)}); falling back to dsh.\n`)
    }
  }
  if (preference === 'codex') throw new Error('Codex executable not found on PATH or in installed macOS apps.')
  if (ownedChild !== null && ownedChildSandboxDirectory !== sandboxDirectory) {
    stopOwnedChild()
    const deadline = Date.now() + 5_000
    while (await probeBridge() !== null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  }
  const existing = await probeBridge()
  if (existing !== null) {
    if (sandboxDirectory !== '' && ownedChild === null) {
      throw new Error('An independently started dsh is already running. Stop it and reconnect so Tandix can apply the sandbox directory.')
    }
    return existing
  }

  if (ownedChild === null) {
    if (typeof config.cliPath !== 'string' || typeof config.workspace !== 'string') {
      throw new Error('Native host configuration is invalid; reinstall it.')
    }
    if (!existsSync(config.cliPath)) {
      throw new Error('dsh runtime is missing; reinstall the Tandix native host.')
    }
    const log = openSync(LOG_PATH, 'a', 0o600)
    try {
      const childEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` }
      if (sandboxDirectory === '') delete childEnv.DSH_BROWSER_SESSION_WORKSPACE
      else childEnv.DSH_BROWSER_SESSION_WORKSPACE = sandboxDirectory
      ownedChild = spawn(process.execPath, [config.cliPath, 'web', '--no-open'], {
        cwd: config.workspace,
        detached: true,
        stdio: ['ignore', log, log],
        env: childEnv,
      })
      ownedChildSandboxDirectory = sandboxDirectory
    } finally {
      closeSync(log)
    }
    ownedChild.on('error', error => {
      if (!stopping) {
        send({ type: 'error', message: `Could not start dsh web: ${error.message}` })
        shutdown(1)
      }
    })
    ownedChild.on('exit', () => {
      if (!stopping) {
        send({ type: 'error', message: 'dsh web exited unexpectedly; inspect ~/.dsh/traceforge-native-host/dsh.log' })
        shutdown(1)
      }
    })
  }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const url = await probeBridge()
    if (url !== null) return url
    if (ownedChild === null || ownedChild.exitCode !== null) throw new Error('dsh web exited before the bridge became ready.')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  stopOwnedChild()
  throw new Error('dsh web did not expose its bridge within 20 seconds; inspect ~/.dsh/traceforge-native-host/dsh.log')
}

function runHost() {
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (length > MAX_MESSAGE_BYTES) return shutdown(1)
      if (buffer.length < 4 + length) return
      const payload = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      let message
      try { message = JSON.parse(payload.toString('utf8')) } catch { send({ type: 'error', message: 'Invalid native message.' }); continue }
      if (message?.type !== 'ensure' || !['auto', 'codex', 'workbuddy', 'dsh'].includes(message.backend ?? 'auto')) {
        send({ type: 'error', message: 'Unsupported native request.' }); continue
      }
      ensureQueue = ensureQueue.then(() => ensureBridge(message.backend ?? 'auto', message.sandboxDirectory)).then(url => {
        send({ type: 'ready', wsUrl: url, sandboxConfigured: true })
      }).catch(error => {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    }
  })
  process.stdin.on('end', () => shutdown())
  process.stdin.on('error', () => shutdown(1))
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())
  process.on('exit', stopOwnedChild)
  process.stdin.resume()
}

if (process.argv[1] && resolve(process.argv[1]) === SOURCE_PATH) {
  if (process.argv[2] === 'install') install()
  else if (process.argv[2] === 'install-codex') await installCodex()
  else runHost()
}
