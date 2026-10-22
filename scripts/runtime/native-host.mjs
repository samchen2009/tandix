#!/usr/bin/env node
/**
 * macOS/Windows Chrome Native Messaging host for on-demand TraceForge bridge startup.
 * Accepts fixed bridge-start and skill-storage operations; it never executes
 * browser-supplied commands or paths. The manifest restricts callers to one extension ID.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findCodex, nativeHostWrapper, stopAgentProcess } from './runtime-discovery.mjs'
import { handleSkillsRequest } from './skills-store.mjs'

const HOST_NAME = 'io.traceforge.bridge'
const HOST_DIR = join(homedir(), '.dsh', 'traceforge-native-host')
const HOST_PATH = join(HOST_DIR, 'host.mjs')
const CONFIG_PATH = join(HOST_DIR, 'config.json')
const LOG_PATH = join(HOST_DIR, 'dsh.log')
const MANIFEST_PATH = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`)
const PORTS = [3080, 3081, 3090, 14389, 43189]
const SOURCE_PATH = fileURLToPath(import.meta.url)
const DISCOVERY_SOURCE_PATH = join(dirname(SOURCE_PATH), 'runtime-discovery.mjs')
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
  const workspace = resolve(dirname(SOURCE_PATH), '../..')
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
  copyFileSync(DISCOVERY_SOURCE_PATH, join(HOST_DIR, 'runtime-discovery.mjs'))
  copyFileSync(join(dirname(SOURCE_PATH), 'skills-store.mjs'), join(HOST_DIR, 'skills-store.mjs'))
  writeFileSync(CONFIG_PATH, JSON.stringify({ mode: 'codex-only', runtimePath, workspace,
    codexHome: process.env.CODEX_HOME ?? null,
    searchPath: process.env.PATH ?? '', dshHome: process.env.DSH_HOME ?? null,
    codexPath: findCodex(),
    workbuddyAgentPath: process.env.WORKBUDDY_AGENT_PATH ?? null,
    cursorAgentPath: process.env.CURSOR_AGENT_PATH ?? null, extensionId }, null, 2) + '\n', { mode: 0o600 })

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
    const compiler = join(workspace, 'scripts', 'install', 'codex-windows-host.ps1')
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', compiler, '-Source', join(workspace, 'scripts', 'runtime', 'native-proxy.cs'),
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
  const workspace = resolve(dirname(SOURCE_PATH), '../..')
  const args = process.argv.slice(3)
  let extensionId
  if (args.length === 2 && args[0] === '--extension-id') extensionId = args[1]
  else if (args.length === 0) extensionId = currentExtensionId(workspace)
  else throw new Error('Usage: node scripts/runtime/native-host.mjs install [--extension-id <id>]')
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid Chrome extension ID.')

  const cliPath = join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cliPath)) throw new Error(`dsh CLI not found at ${cliPath}; run pnpm install first.`)

  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 })
  copyFileSync(SOURCE_PATH, HOST_PATH)
  copyFileSync(DISCOVERY_SOURCE_PATH, join(HOST_DIR, 'runtime-discovery.mjs'))
  copyFileSync(join(dirname(SOURCE_PATH), 'skills-store.mjs'), join(HOST_DIR, 'skills-store.mjs'))
  writeFileSync(CONFIG_PATH, JSON.stringify({ cliPath, workspace,
    reuseExternalDsh: false,
    codexHome: process.env.CODEX_HOME ?? null,
    searchPath: process.env.PATH ?? '', dshHome: process.env.DSH_HOME ?? null,
    codexPath: findCodex(),
    workbuddyAgentPath: process.env.WORKBUDDY_AGENT_PATH ?? null,
    cursorAgentPath: process.env.CURSOR_AGENT_PATH ?? null, extensionId }, null, 2) + '\n', { mode: 0o600 })
  registerChromeNativeHost({ workspace, extensionId })
  process.stdout.write(`Registered ${HOST_NAME} for extension ${extensionId}. Reload Tandix in chrome://extensions.\n`)
}

let ownedChild = null
let ownedBridgeUrl = null
let ownedChildSandboxDirectory = ''
let codexBridge = null
let workbuddyBridge = null
let cursorBridge = null
let automaticBridge = null
let stopping = false
let ensureQueue = Promise.resolve()

function stopOwnedChild() {
  if (ownedChild?.pid === undefined) return
  try {
    if (process.platform === 'win32') stopAgentProcess(ownedChild)
    else process.kill(-ownedChild.pid, 'SIGTERM')
  } catch { /* Already exited. */ }
  ownedChild = null
  ownedBridgeUrl = null
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
  cursorBridge?.close()
  process.exit(code)
}

async function probeBridge(ownedOnly = false) {
  const candidates = [...new Set([ownedBridgeUrl, ...(ownedOnly ? [] : PORTS.map(port => `ws://127.0.0.1:${port}/ext/bridge`))].filter(Boolean))]
  const results = await Promise.all(candidates.map(async expected => {
    try {
      const target = new URL(expected)
      target.protocol = 'http:'
      target.pathname = '/ext/bridge-config'
      const response = await fetch(target, { signal: AbortSignal.timeout(700) })
      if (!response.ok) return null
      const body = await response.json()
      return body?.wsUrl === expected && (body.backend === undefined || body.backend === 'dsh') ? expected : null
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

export const AUTO_AGENT_PRIORITY = ['codex', 'cursor', 'workbuddy', 'dsh']

export async function selectAutomaticAgent(connect, reportFailure = () => {}) {
  const failures = []
  for (const backend of AUTO_AGENT_PRIORITY) {
    try { return { backend, url: await connect(backend) } }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${backend}: ${detail}`)
      reportFailure(backend, detail)
    }
  }
  throw new Error(`No local agent is ready. ${failures.join('; ')}`)
}

async function ensureBridge(preference = 'auto', requestedSandboxDirectory = '') {
  const sandboxDirectory = normalizeSandboxDirectory(requestedSandboxDirectory)
  if (preference === 'auto') {
    const selected = automaticBridge
    const ready = selected?.backend === 'codex' ? codexBridge?.isReady
      : selected?.backend === 'cursor' ? cursorBridge?.isReady
        : selected?.backend === 'workbuddy' ? workbuddyBridge?.isReady
          : selected?.backend === 'dsh' && ownedChild?.exitCode === null
    if (selected?.sandboxDirectory === sandboxDirectory && ready) return selected.url
    automaticBridge = null
    const result = await selectAutomaticAgent(backend => ensureBridge(backend, sandboxDirectory),
      (backend, detail) => process.stderr.write(`Tandix: ${backend} unavailable (${detail}); trying the next local agent.\n`))
    automaticBridge = { ...result, sandboxDirectory }
    return result.url
  }
  automaticBridge = null
  if (preference === 'cursor' && cursorBridge?.isReady && cursorBridge.sandboxDirectory === sandboxDirectory) return cursorBridge.wsUrl
  if (preference !== 'cursor') { cursorBridge?.close(); cursorBridge = null }
  if (preference === 'cursor') {
    codexBridge?.close(); codexBridge = null
    workbuddyBridge?.close(); workbuddyBridge = null
    cursorBridge?.close(); cursorBridge = null
    stopOwnedChild()
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const { CursorBridge, findCursorAgent } = await import(pathToFileURL(join(config.workspace, 'scripts', 'runtime', 'cursor-bridge.mjs')).href)
    const agentPath = findCursorAgent({ env: { ...process.env,
      ...(typeof config.cursorAgentPath === 'string' ? { CURSOR_AGENT_PATH: config.cursorAgentPath } : {}) } })
    if (!agentPath) throw new Error('Cursor CLI was not found. Install Cursor CLI and run "agent login", or set CURSOR_AGENT_PATH and reinstall the companion.')
    cursorBridge = await CursorBridge.open({ agentPath, nodePath: process.execPath,
      runtimePath: config.runtimePath ?? config.cliPath, workspace: config.workspace, hostDir: HOST_DIR,
      extensionId: config.extensionId, sandboxDirectory })
    return cursorBridge.wsUrl
  }
  if (preference === 'workbuddy' && workbuddyBridge?.isReady && workbuddyBridge.sandboxDirectory === sandboxDirectory) return workbuddyBridge.wsUrl
  if (preference !== 'workbuddy') { workbuddyBridge?.close(); workbuddyBridge = null }
  if (preference === 'workbuddy') {
    codexBridge?.close(); codexBridge = null
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const { WorkBuddyBridge, findWorkBuddyAgent } = await import(pathToFileURL(join(config.workspace, 'scripts', 'runtime', 'workbuddy-bridge.mjs')).href)
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
  const codexPath = preference === 'dsh' ? null : findCodex({ savedPath: config.codexPath })
  if (config.mode === 'codex-only') {
    if (preference === 'dsh') throw new Error('This Tandix installation supports Codex only. Select Codex or Auto in the side panel.')
    if (codexPath === null) throw new Error('Codex CLI was not found. Install Codex and sign in, then reconnect.')
    const { CodexBridge } = await import(pathToFileURL(join(config.workspace, 'scripts', 'runtime', 'codex-bridge.mjs')).href)
    codexBridge = await CodexBridge.open({
      codexPath, nodePath: process.execPath, runtimePath: config.runtimePath,
      workspace: config.workspace, hostDir: HOST_DIR, extensionId: config.extensionId, sandboxDirectory,
      codexHome: typeof config.codexHome === 'string' && isAbsolute(config.codexHome) ? config.codexHome : null,
    })
    return codexBridge.wsUrl
  }
  if (preference !== 'dsh' && codexPath !== null) {
    try {
      const { CodexBridge } = await import(pathToFileURL(join(config.workspace, 'scripts', 'runtime', 'codex-bridge.mjs')).href)
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
    while (await probeBridge(config.reuseExternalDsh === false) !== null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  }
  const existing = await probeBridge(config.reuseExternalDsh === false)
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
    {
      const childEnv = nativeEnvironment(config)
      if (sandboxDirectory === '') delete childEnv.DSH_BROWSER_SESSION_WORKSPACE
      else childEnv.DSH_BROWSER_SESSION_WORKSPACE = sandboxDirectory
      ownedChild = spawn(process.execPath, [config.cliPath, 'web', '--no-open', '--port', '0'], {
        cwd: config.workspace,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      })
      ownedChildSandboxDirectory = sandboxDirectory
    }
    const started = ownedChild
    let output = ''
    const logOutput = chunk => {
      appendFileSync(LOG_PATH, chunk, { mode: 0o600 })
      output = (output + chunk).slice(-8192)
      const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (url && ownedChild === started) ownedBridgeUrl = url.replace('http:', 'ws:') + '/ext/bridge'
    }
    started.stdout.on('data', logOutput)
    started.stderr.on('data', logOutput)
    started.on('error', error => {
      if (ownedChild !== started) return
      if (!stopping) {
        send({ type: 'error', message: `Could not start dsh web: ${error.message}` })
        shutdown(1)
      }
    })
    started.on('exit', () => {
      if (ownedChild !== started) return
      if (!stopping) {
        send({ type: 'error', message: 'dsh web exited unexpectedly; inspect ~/.dsh/traceforge-native-host/dsh.log' })
        shutdown(1)
      }
    })
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const url = await probeBridge(config.reuseExternalDsh === false)
    if (url !== null) return url
    if (ownedChild === null || ownedChild.exitCode !== null) throw new Error('dsh web exited before the bridge became ready.')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  stopOwnedChild()
  throw new Error('dsh web did not expose its bridge within 60 seconds; inspect ~/.dsh/traceforge-native-host/dsh.log')
}

function runHost() {
  // Chrome may have been opened before Node or the agent CLIs were installed.
  // Restore the installer environment instead of depending on that stale PATH.
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const env = nativeEnvironment(config)
    process.env.PATH = env.PATH
    if (env.DSH_HOME) process.env.DSH_HOME = env.DSH_HOME
    if (typeof config.codexPath === 'string') process.env.CODEX_CLI_PATH = config.codexPath
  } catch { /* ensureBridge will report a missing or invalid configuration. */ }
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
      if (message?.type === 'skills') {
        void handleSkillsRequest(message).then(send).catch(error => {
          send({ type: 'skills.result', ok: false, message: error instanceof Error ? error.message : String(error) })
        })
        continue
      }
      if (message?.type !== 'ensure' || !['auto', 'codex', 'cursor', 'workbuddy', 'dsh'].includes(message.backend ?? 'auto')) {
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

export function nativeEnvironment(config, { env = process.env, nodePath = process.execPath, separator = delimiter } = {}) {
  const result = { ...env }
  const previous = config.searchPath || Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key]
  result.PATH = [dirname(nodePath), previous].filter(Boolean).join(separator)
  if (typeof config.dshHome === 'string' && config.dshHome) result.DSH_HOME = config.dshHome
  return result
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === SOURCE_PATH) {
  if (process.argv[2] === 'install') install()
  else if (process.argv[2] === 'extension-id') process.stdout.write(await waitForExtensionId(resolve(dirname(SOURCE_PATH), '../..')))
  else if (process.argv[2] === 'install-codex') await installCodex()
  else runHost()
}
