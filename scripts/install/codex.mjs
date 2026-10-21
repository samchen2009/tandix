#!/usr/bin/env node
/** Install the built extension and minimal Codex runtime without dsh. */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCodex } from '../runtime/runtime-discovery.mjs'
import { installPortableNode, installedPortableNodePath } from '../runtime/portable-node.mjs'

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INSTALL_ROOT = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Tandix', 'codex-client')
  : join(homedir(), '.tandix', 'codex-client')
const SCRIPTS = [
  'install/codex.mjs',
  'runtime/native-host.mjs', 'runtime/runtime-discovery.mjs', 'runtime/skills-store.mjs',
  'runtime/codex-bridge.mjs', 'runtime/codex-mcp.mjs',
  'runtime/workbuddy-bridge.mjs',
  'runtime/acp-bridge.mjs',
  'runtime/agent-configuration.mjs',
  'runtime/cursor-bridge.mjs',
  'runtime/web-task-store.mjs',
  'runtime/browser-guidance.mjs', 'runtime/lark-auth.mjs',
  'runtime/session-title.mjs',
  'runtime/portable-node.mjs',
]
if (process.platform === 'win32') SCRIPTS.push('install/codex-windows-host.ps1', 'runtime/native-proxy.cs')

function checkPlatform() {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('This installer supports macOS and Windows only.')
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!(major === 22 && minor >= 19 || major >= 24)) {
    throw new Error('Install Node.js 22.19+ or 24+ before running this installer.')
  }
}

function prepare() {
  checkPlatform()
  if (!existsSync(join(SOURCE_ROOT, 'extensions', 'dsh-browser', 'dist', 'manifest.json'))) {
    throw new Error('The package is missing the built Chrome extension.')
  }
  const codexPath = findCodex()
  if (!codexPath) throw new Error('Codex executable was not found. Open the Codex desktop app once, then rerun this installer; if it still fails, install the Codex CLI or set CODEX_CLI_PATH to its executable.')
  mkdirSync(join(INSTALL_ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(INSTALL_ROOT, 'extensions', 'dsh-browser'), { recursive: true })
  mkdirSync(join(INSTALL_ROOT, 'workspace'), { recursive: true })
  const destDist = join(INSTALL_ROOT, 'extensions', 'dsh-browser', 'dist')
  rmSync(destDist, { recursive: true, force: true })
  cpSync(join(SOURCE_ROOT, 'extensions', 'dsh-browser', 'dist'), destDist, { recursive: true })
  for (const script of SCRIPTS) {
    mkdirSync(dirname(join(INSTALL_ROOT, 'scripts', script)), { recursive: true })
    cpSync(join(SOURCE_ROOT, 'scripts', script), join(INSTALL_ROOT, 'scripts', script))
  }
  cpSync(join(SOURCE_ROOT, 'package.json'), join(INSTALL_ROOT, 'package.json'))
  cpSync(join(SOURCE_ROOT, 'package-lock.json'), join(INSTALL_ROOT, 'package-lock.json'))
  const bundledModules = join(SOURCE_ROOT, 'node_modules')
  if (existsSync(join(bundledModules, '@modelcontextprotocol', 'sdk', 'package.json')) &&
      existsSync(join(bundledModules, 'ws', 'package.json')) &&
      existsSync(join(bundledModules, 'zod', 'package.json'))) {
    process.stdout.write('Copying bundled Codex connection dependencies...\n')
    rmSync(join(INSTALL_ROOT, 'node_modules'), { recursive: true, force: true })
    cpSync(bundledModules, join(INSTALL_ROOT, 'node_modules'), { recursive: true })
  } else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    process.stdout.write('Installing the Codex connection dependencies...\n')
    const install = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
      { cwd: INSTALL_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    if (install.status !== 0) throw new Error('Codex connection dependencies could not be installed.')
  }
  if (process.platform === 'win32') {
    const bundledNode = join(SOURCE_ROOT, 'runtime', `node-win-${process.arch}`, 'node.exe')
    if (existsSync(bundledNode)) {
      const installedRuntime = join(INSTALL_ROOT, 'runtime')
      const existing = installedPortableNodePath(bundledNode, installedRuntime)
      const installedNode = installPortableNode(bundledNode, installedRuntime)
      process.stdout.write(`${existing ? 'Reusing verified' : 'Installed'} Windows Node runtime: ${installedNode}\n`)
      if (!existing || !existsSync(join(installedRuntime, 'LICENSE'))) {
        cpSync(join(dirname(bundledNode), 'LICENSE'), join(installedRuntime, 'LICENSE'))
      }
    }
  }
  process.stdout.write(`Codex CLI: ${codexPath}\nChrome extension folder: ${destDist}\n`)
}

function verifyBridge(host, nodePath = process.execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [host], { stdio: ['pipe', 'pipe', 'pipe'] })
    let pending = Buffer.alloc(0)
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error('Codex connection check timed out. Confirm Codex CLI is signed in.')), 45_000)
    child.on('error', error => finish(error))
    child.on('exit', code => finish(new Error(`Codex companion exited before becoming ready (${code}).`)))
    child.stdin.on('error', error => finish(error))
    child.stderr.on('data', () => {})
    child.stdout.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 4) return
      const length = pending.readUInt32LE(0)
      if (length > 1024 * 1024) return finish(new Error('Codex companion sent an invalid response.'))
      if (pending.length < 4 + length) return
      try {
        const result = JSON.parse(pending.subarray(4, 4 + length).toString('utf8'))
        if (result.type === 'ready' && /^ws:\/\/127\.0\.0\.1:\d+\/ext\/bridge$/u.test(result.wsUrl)) finish()
        else finish(new Error(typeof result.message === 'string' ? result.message : 'Codex companion was not ready.'))
      } catch { finish(new Error('Codex companion sent an invalid response.')) }
    })
    const request = Buffer.from(JSON.stringify({ type: 'ensure', backend: 'codex' }))
    const header = Buffer.alloc(4)
    header.writeUInt32LE(request.length)
    child.stdin.write(Buffer.concat([header, request]))
  })
}

async function register() {
  checkPlatform()
  const host = join(INSTALL_ROOT, 'scripts', 'runtime', 'native-host.mjs')
  if (!existsSync(host)) throw new Error('Run the prepare step first.')
  const id = process.argv[3]
  const args = [host, 'install-codex']
  if (id) args.push('--extension-id', id)
  const bundledNode = join(SOURCE_ROOT, 'runtime', `node-win-${process.arch}`, 'node.exe')
  const installedNode = process.platform === 'win32' && existsSync(bundledNode)
    ? installedPortableNodePath(bundledNode, join(INSTALL_ROOT, 'runtime')) : null
  // The full ZIP supplies a private Node runtime. The lite ZIP may instead run
  // under a supported, system-installed Node; process.execPath is then stable.
  const nodePath = installedNode ?? process.execPath
  const result = spawnSync(nodePath, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Could not register the Chrome native companion.')
  process.stdout.write('Checking Codex login and local connection...\n')
  await verifyBridge(host, nodePath)
  process.stdout.write('Codex local connection is ready.\n')
}

try {
  const mode = process.argv[2]
  if (mode === 'prepare') prepare()
  else if (mode === 'register') await register()
  else throw new Error('Usage: node scripts/install/codex.mjs prepare|register [extension-id]')
} catch (error) {
  process.stderr.write(`Tandix installation error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
