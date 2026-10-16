/** Discover local runtimes when the native host starts, not only when it is installed. */

import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'

function executable(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  try {
    accessSync(path, constants.X_OK)
    const resolved = realpathSync(path)
    return statSync(resolved).isFile() ? resolved : null
  } catch { return null }
}

function onPath(name, searchPath, platform) {
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const suffix of platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const found = executable(join(directory, name + suffix))
      if (found !== null) return found
    }
  }
  return null
}

function plistString(path, key) {
  let contents
  try { contents = readFileSync(path, 'utf8') } catch { return null }
  if (contents.startsWith('<?xml')) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return contents.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`))?.[1] ?? null
  }
  // Some app bundles ship binary plists instead of XML.
  try { return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', path], { encoding: 'utf8', timeout: 2_000 }).trim() || null }
  catch { return null }
}

function appEntries(root) {
  try { return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.name.endsWith('.app') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => join(root, entry.name)) }
  catch { return [] }
}

function bundledCodex(app) {
  const resources = join(app, 'Contents', 'Resources')
  const queue = [{ path: resources, depth: 0 }]
  while (queue.length > 0) {
    const { path, depth } = queue.shift()
    let entries
    try { entries = readdirSync(path, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(path, entry.name)
      if (entry.name.endsWith('.app')) {
        const info = join(child, 'Contents', 'Info.plist')
        if (plistString(info, 'CFBundleIdentifier') !== 'com.openai.codex.cli') continue
        const name = plistString(info, 'CFBundleExecutable')
        const found = name === null ? null : executable(join(child, 'Contents', 'MacOS', basename(name)))
        if (found !== null) return found
      } else if (depth < 3) queue.push({ path: child, depth: depth + 1 })
    }
  }
  return null
}

function windowsCodex(localAppData) {
  if (!localAppData) return null
  const standalone = executable(join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
  if (standalone !== null) return standalone

  // The Windows desktop app keeps its runnable CLI in a versioned per-user bin directory.
  const bin = join(localAppData, 'OpenAI', 'Codex', 'bin')
  const direct = executable(join(bin, 'codex.exe'))
  if (direct !== null) return direct
  let entries
  try { entries = readdirSync(bin, { withFileTypes: true }) } catch { return null }
  const candidates = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      const path = executable(join(bin, entry.name, 'codex.exe'))
      if (path === null) return null
      try { return { path, modified: statSync(path).mtimeMs } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
  return candidates[0]?.path ?? null
}

/** A saved path is only a hint; moved or upgraded installations are rediscovered. */
export function findCodex({ searchPath = process.env.PATH ?? '', savedPath = null,
  applicationRoots = ['/Applications', join(homedir(), 'Applications')], platform = process.platform,
  cliPathHint = process.env.CODEX_CLI_PATH ?? null,
  localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local') } = {}) {
  const fromHint = executable(cliPathHint)
  if (fromHint !== null) return fromHint
  const fromPath = onPath('codex', searchPath, platform)
  if (fromPath !== null) return fromPath
  if (platform === 'win32') {
    const found = windowsCodex(localAppData)
    if (found !== null) return found
  }
  if (platform === 'darwin') {
    for (const root of applicationRoots) {
      for (const app of appEntries(root)) {
        if (plistString(join(app, 'Contents', 'Info.plist'), 'CFBundleIdentifier') !== 'com.openai.codex') continue
        const found = bundledCodex(app)
        if (found !== null) return found
      }
    }
  }
  return executable(savedPath)
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }

export function nativeHostWrapper({ hostPath, searchPath, nodeHint }) {
  return `#!/bin/sh
PATH=${shellQuote(searchPath)}:"$PATH"
export PATH
if command -v node >/dev/null 2>&1; then
  exec node ${shellQuote(hostPath)}
fi
if [ -x ${shellQuote(nodeHint)} ]; then
  exec ${shellQuote(nodeHint)} ${shellQuote(hostPath)}
fi
printf '%s\\n' 'Tandix: Node runtime not found; reinstall Node and the Tandix native host.' >&2
exit 127
`
}

/** Stop a child we launched, including the CLI behind a Windows .cmd wrapper. */
export function stopAgentProcess(child, { platform = process.platform, run = spawnSync } = {}) {
  if (!child) return
  try {
    if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode == null) {
      const result = run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
      if (result.status === 0) return
    }
    child.kill('SIGTERM')
  } catch { /* The child may have already exited. */ }
}
