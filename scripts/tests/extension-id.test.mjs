import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentExtensionId, waitForExtensionId } from '../runtime/native-host.mjs'

const ONE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TWO = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tandix-extension-id-'))
  const workspace = join(root, 'installed')
  const dist = join(workspace, 'extensions', 'dsh-browser', 'dist')
  const chromeHome = join(root, 'Chrome')
  mkdirSync(dist, { recursive: true })
  mkdirSync(join(chromeHome, 'Default'), { recursive: true })
  writeFileSync(join(dist, 'manifest.json'), '{"name":"Tandix","version":"1"}')
  writeFileSync(join(dist, 'background.js'), 'console.log("Tandix")')
  const options = { home: root, chromeHome, configPath: join(root, 'config.json'),
    manifestPath: join(root, 'native-host.json'), platform: 'darwin' }
  const prefs = settings => writeFileSync(join(chromeHome, 'Default', 'Secure Preferences'),
    JSON.stringify({ extensions: { settings } }))
  return { root, workspace, dist, options, prefs }
}

test('discovers an identical unpacked extension from another folder', () => {
  const f = fixture()
  const copied = join(f.root, 'repo-dist')
  cpSync(f.dist, copied, { recursive: true })
  f.prefs({ [ONE]: { path: copied } })
  assert.equal(currentExtensionId(f.workspace, f.options), ONE)
})

test('prefers the installed path when multiple builds match', () => {
  const f = fixture()
  const copied = join(f.root, 'repo-dist')
  cpSync(f.dist, copied, { recursive: true })
  f.prefs({ [ONE]: { path: copied }, [TWO]: { path: f.dist } })
  assert.equal(currentExtensionId(f.workspace, f.options), TWO)
})

test('reuses a previously registered ID for an older loaded build', () => {
  const f = fixture()
  const older = join(f.root, 'older-dist')
  cpSync(f.dist, older, { recursive: true })
  writeFileSync(join(older, 'background.js'), 'console.log("older build")')
  f.prefs({ [ONE]: { path: older } })
  writeFileSync(f.options.configPath, JSON.stringify({ mode: 'codex-only', extensionId: ONE }))
  writeFileSync(f.options.manifestPath, JSON.stringify({ name: 'io.traceforge.bridge',
    allowed_origins: [`chrome-extension://${ONE}/`] }))
  assert.equal(currentExtensionId(f.workspace, f.options), ONE)
})

test('does not guess between two matching IDs without a previous registration', () => {
  const f = fixture()
  const copied = join(f.root, 'repo-dist')
  cpSync(f.dist, copied, { recursive: true })
  const second = join(f.root, 'other-dist')
  cpSync(f.dist, second, { recursive: true })
  f.prefs({ [ONE]: { path: copied }, [TWO]: { path: second } })
  assert.throws(() => currentExtensionId(f.workspace, f.options), /found 2/u)
})

test('ignores a different extension build', () => {
  const f = fixture()
  const unrelated = join(f.root, 'unrelated')
  mkdirSync(unrelated)
  writeFileSync(join(unrelated, 'manifest.json'), '{"name":"Unrelated"}')
  f.prefs({ [ONE]: { path: unrelated } })
  assert.throws(() => currentExtensionId(f.workspace, f.options), /found 0/u)
})

test('waits for Chrome to persist a newly loaded extension', async () => {
  const f = fixture()
  f.prefs({})
  let notices = 0
  const pending = waitForExtensionId(f.workspace, { ...f.options, timeoutMs: 1000,
    intervalMs: 10, onWaiting: () => { notices++ } })
  setTimeout(() => f.prefs({ [ONE]: { path: f.dist } }), 30)
  assert.equal(await pending, ONE)
  assert.equal(notices, 1)
})

test('stops waiting if no extension is loaded', async () => {
  const f = fixture()
  f.prefs({})
  await assert.rejects(waitForExtensionId(f.workspace, { ...f.options, timeoutMs: 20,
    intervalMs: 5 }), { code: 'EXTENSION_NOT_SAVED' })
})

test('does not retry an ambiguous extension selection', async () => {
  const f = fixture()
  const copied = join(f.root, 'repo-dist')
  cpSync(f.dist, copied, { recursive: true })
  const second = join(f.root, 'other-dist')
  cpSync(f.dist, second, { recursive: true })
  f.prefs({ [ONE]: { path: copied }, [TWO]: { path: second } })
  await assert.rejects(waitForExtensionId(f.workspace, { ...f.options,
    onWaiting: () => assert.fail('Ambiguity must not be retried') }), { code: 'EXTENSION_AMBIGUOUS' })
})
