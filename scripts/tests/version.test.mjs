import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'

const directories = []
const jsonFiles = ['package.json', 'extensions/dsh-browser/package.json', 'extensions/dsh-browser/manifest.json',
  'extensions/dsh-browser/manifest.firefox.json', 'scripts/release/resources/codex-package.json',
  'scripts/release/resources/codex-package-lock.json']
const runtimeFiles = ['scripts/runtime/codex-bridge.mjs', 'scripts/runtime/acp-bridge.mjs']

afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function write(root, path, value, options) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), value, options)
}

function run(root, command, args, success = true) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (success) assert.equal(result.status, 0, result.stdout + result.stderr)
  else assert.notEqual(result.status, 0)
  return result
}

function git(root, args, success = true) { return run(root, 'git', args, success).stdout }
function install(root) { return run(root, process.execPath, ['scripts/dev/version.mjs', '--install-hooks']) }

function fixture(withGit = true) {
  const root = mkdtempSync(join(tmpdir(), "Tandix version's "))
  directories.push(root)
  for (const path of jsonFiles) {
    write(root, path, JSON.stringify({ name: 'tandix', version: '0.2.0', description: 'original',
      ...(path.endsWith('lock.json') ? { packages: { '': { version: '0.2.0' }, dependency: { version: '2.1.4' } } } : {}),
    }, null, 2) + '\n')
  }
  for (const path of runtimeFiles) write(root, path, "const settings = { clientInfo: { name: 'tandix', version: '0.2.0' } }\n")
  write(root, 'notes.txt', 'original\n')
  mkdirSync(join(root, 'scripts/dev'), { recursive: true })
  copyFileSync(new URL('../dev/version.mjs', import.meta.url), join(root, 'scripts/dev/version.mjs'))
  if (withGit) {
    git(root, ['init', '-q'])
    git(root, ['config', 'user.name', 'Version Test'])
    git(root, ['config', 'user.email', 'version@example.com'])
    git(root, ['config', 'commit.gpgsign', 'false'])
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'baseline'])
  }
  return root
}

function versions(root, expected) {
  for (const path of jsonFiles) {
    const value = JSON.parse(readFileSync(join(root, path), 'utf8'))
    const committed = JSON.parse(git(root, ['show', `HEAD:${path}`]))
    assert.equal(value.version, expected, path)
    assert.equal(committed.version, expected, path)
    if (path.endsWith('lock.json')) {
      assert.equal(value.packages[''].version, expected)
      assert.equal(value.packages.dependency.version, '2.1.4')
    }
  }
  for (const path of runtimeFiles) {
    assert.ok(readFileSync(join(root, path), 'utf8').includes(`version: '${expected}'`))
    assert.ok(git(root, ['show', `HEAD:${path}`]).includes(`version: '${expected}'`))
  }
}

test('normal commits and amend increment y and synchronize every release identity', () => {
  const root = fixture()
  install(root)
  write(root, 'notes.txt', 'first\n')
  git(root, ['add', 'notes.txt'])
  git(root, ['commit', '-qm', 'first'])
  versions(root, '0.2.1')
  write(root, 'notes.txt', 'second\n')
  git(root, ['add', 'notes.txt'])
  git(root, ['commit', '-qm', 'second'])
  versions(root, '0.2.2')
  git(root, ['commit', '--amend', '--no-edit'])
  versions(root, '0.2.3')
  assert.equal(git(root, ['status', '--porcelain']), '')
})

test('failed commits retry the same version rather than incrementing twice', () => {
  const root = fixture()
  install(root)
  write(root, '.git/hooks/commit-msg', '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  write(root, 'notes.txt', 'reject this change\n')
  git(root, ['add', 'notes.txt'])
  git(root, ['commit', '-qm', 'rejected'], false)
  assert.equal(JSON.parse(git(root, ['show', 'HEAD:package.json'])).version, '0.2.0')
  assert.equal(JSON.parse(git(root, ['show', ':package.json'])).version, '0.2.1')
  rmSync(join(root, '.git/hooks/commit-msg'))
  git(root, ['commit', '-qm', 'retry'])
  versions(root, '0.2.1')
})

test('a manually staged x release keeps its starting point and resumes automatic patches', () => {
  const root = fixture()
  install(root)
  write(root, 'package.json', readFileSync(join(root, 'package.json'), 'utf8').replace('0.2.0', '0.3.0'))
  git(root, ['add', 'package.json'])
  git(root, ['commit', '-qm', 'minor release'])
  versions(root, '0.3.0')
  write(root, 'notes.txt', 'next patch\n')
  git(root, ['add', 'notes.txt'])
  git(root, ['commit', '-qm', 'next patch'])
  versions(root, '0.3.1')
})

test('partially staged metadata/runtime edits remain separate from unstaged work', () => {
  const root = fixture()
  install(root)
  write(root, 'package.json', readFileSync(join(root, 'package.json'), 'utf8').replace('original', 'staged'))
  const runtime = runtimeFiles[0]
  write(root, runtime, readFileSync(join(root, runtime), 'utf8') + '// staged\n')
  git(root, ['add', 'package.json', runtime])
  write(root, 'package.json', readFileSync(join(root, 'package.json'), 'utf8').replace('staged', 'unstaged'))
  write(root, runtime, readFileSync(join(root, runtime), 'utf8') + '// unstaged\n')
  git(root, ['commit', '-qm', 'partial'])
  versions(root, '0.2.1')
  assert.equal(JSON.parse(git(root, ['show', 'HEAD:package.json'])).description, 'staged')
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).description, 'unstaged')
  assert.ok(!git(root, ['show', `HEAD:${runtime}`]).includes('// unstaged'))
  assert.ok(readFileSync(join(root, runtime), 'utf8').includes('// unstaged'))
  assert.equal(git(root, ['diff', '--cached']), '')
})

test('commit --only includes synchronized versions without consuming other staged files', () => {
  const root = fixture()
  install(root)
  write(root, 'notes.txt', 'selected\n')
  write(root, 'later.txt', 'keep staged\n')
  git(root, ['add', 'later.txt'])
  git(root, ['commit', '-qm', 'selected only', '--only', 'notes.txt'])
  versions(root, '0.2.1')
  assert.ok(!git(root, ['ls-tree', '--name-only', 'HEAD']).includes('later.txt'))
  assert.equal(git(root, ['diff', '--cached', '--name-only']).trim(), 'later.txt')
})

test('installation preserves existing pre-commit and pre-push hooks and is repeatable', () => {
  const root = fixture()
  const hooks = ".git/custom hooks's"
  write(root, `${hooks}/pre-push`, '#!/bin/sh\nexit 37\n', { mode: 0o755 })
  write(root, `${hooks}/pre-commit`, '#!/bin/sh\nprintf ran > original-hook-ran\n', { mode: 0o755 })
  write(root, `${hooks}/post-commit`, '#!/bin/sh\nprintf ran > original-post-hook-ran\n', { mode: 0o755 })
  git(root, ['config', 'core.hooksPath', hooks])
  install(root)
  install(root)
  assert.equal(readFileSync(join(root, hooks, 'pre-push'), 'utf8'), '#!/bin/sh\nexit 37\n')
  assert.equal(git(root, ['config', '--get', 'core.hooksPath']).trim(), hooks)
  write(root, 'notes.txt', 'hook integration\n')
  git(root, ['add', 'notes.txt'])
  git(root, ['commit', '-qm', 'hook integration'])
  versions(root, '0.2.1')
  assert.equal(readFileSync(join(root, 'original-hook-ran'), 'utf8'), 'ran')
  assert.equal(readFileSync(join(root, 'original-post-hook-ran'), 'utf8'), 'ran')
})

test('malformed release metadata fails before changing the index or version files', () => {
  const root = fixture()
  install(root)
  write(root, runtimeFiles[1], '// client version removed\n')
  const before = git(root, ['write-tree'])
  git(root, ['commit', '-qm', 'must fail'], false)
  assert.equal(git(root, ['write-tree']), before)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.2.0')
})

test('source archives outside Git skip hook installation', () => {
  const root = fixture(false)
  install(root)
  assert.equal(existsSync(join(root, '.git')), false)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.2.0')
})
