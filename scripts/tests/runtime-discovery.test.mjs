import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { findCodex, nativeHostWrapper } from '../runtime/runtime-discovery.mjs'

const root = mkdtempSync(join(tmpdir(), 'tandix-runtime-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

function executable(path, body = '#!/bin/sh\nexit 0\n') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o700)
  return path
}

function plist(path, identifier, executableName = '') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${executableName}</string></dict></plist>`)
}

test('findCodex uses an executable on PATH before a saved installation hint', () => {
  const bin = join(root, 'path-bin')
  const codex = executable(join(bin, 'codex'))
  assert.equal(findCodex({ searchPath: bin, savedPath: join(root, 'removed-codex'),
    applicationRoots: [], platform: 'darwin' }), realpathSync(codex))
})

test('findCodex locates a Windows Codex launcher on PATH', () => {
  const bin = join(root, 'windows-bin')
  const codex = executable(join(bin, 'codex.cmd'))
  assert.equal(findCodex({ searchPath: bin, applicationRoots: [], platform: 'win32' }), realpathSync(codex))
})

test('findCodex discovers the Windows desktop app CLI outside PATH', () => {
  const localAppData = join(root, 'windows-local-app-data')
  const old = executable(join(localAppData, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe'))
  const current = executable(join(localAppData, 'OpenAI', 'Codex', 'bin', 'current', 'codex.exe'))
  executable(join(localAppData, 'OpenAI', 'Codex', 'bin', '.staging-update', 'codex.exe'))
  utimesSync(old, new Date('2024-01-01'), new Date('2024-01-01'))
  utimesSync(current, new Date('2025-01-01'), new Date('2025-01-01'))
  assert.equal(findCodex({ searchPath: '', platform: 'win32', localAppData,
    cliPathHint: null }), realpathSync(current))
})

test('findCodex honors an explicit CLI path and a standalone Windows installation', () => {
  const localAppData = join(root, 'windows-standalone')
  const standalone = executable(join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
  const explicit = executable(join(root, 'explicit-cli', 'codex.exe'))
  assert.equal(findCodex({ searchPath: '', platform: 'win32', localAppData,
    cliPathHint: null }), realpathSync(standalone))
  assert.equal(findCodex({ searchPath: '', platform: 'win32', localAppData,
    cliPathHint: explicit }), realpathSync(explicit))
})

test('findCodex rediscovers a moved and renamed macOS app bundle', () => {
  const applications = join(root, 'Applications')
  const app = join(applications, 'Renamed Agent.app')
  plist(join(app, 'Contents', 'Info.plist'), 'com.openai.codex')
  const cliApp = join(app, 'Contents', 'Resources', 'moved', 'runtime', 'Codex Runner.app')
  plist(join(cliApp, 'Contents', 'Info.plist'), 'com.openai.codex.cli', 'codex')
  const codex = executable(join(cliApp, 'Contents', 'MacOS', 'codex'))
  assert.equal(findCodex({ searchPath: '', savedPath: join(root, 'old-codex'),
    applicationRoots: [applications], platform: 'darwin' }), realpathSync(codex))
})

test('findCodex retains a working legacy hint and rejects a missing runtime', () => {
  const saved = executable(join(root, 'legacy', 'codex'))
  assert.equal(findCodex({ searchPath: '', savedPath: saved,
    applicationRoots: [], platform: 'darwin' }), realpathSync(saved))
  assert.equal(findCodex({ searchPath: '', savedPath: join(root, 'missing'),
    applicationRoots: [], platform: 'darwin' }), null)
})

test('native host wrapper finds Node again when its installation-time path moved', () => {
  const bin = join(root, 'new-node-bin')
  executable(join(bin, 'node'), '#!/bin/sh\nprintf "%s" "$1"\n')
  const wrapper = executable(join(root, 'host.sh'), nativeHostWrapper({
    hostPath: '/a moved/host.mjs', searchPath: bin, nodeHint: join(root, 'old-node'),
  }))
  assert.equal(execFileSync(wrapper, { encoding: 'utf8', env: { PATH: '' } }), '/a moved/host.mjs')
  const missing = executable(join(root, 'missing-host.sh'), nativeHostWrapper({
    hostPath: '/missing/host.mjs', searchPath: join(root, 'no-node'), nodeHint: join(root, 'old-node'),
  }))
  const result = spawnSync(missing, { encoding: 'utf8', env: { PATH: '' } })
  assert.equal(result.status, 127)
  assert.match(result.stderr, /Node runtime not found/)
})
