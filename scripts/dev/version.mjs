#!/usr/bin/env node
/** Keep the staged release version in step with each normal Git commit. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const JSON_FILES = [
  'package.json',
  'extensions/dsh-browser/package.json',
  'extensions/dsh-browser/manifest.json',
  'extensions/dsh-browser/manifest.firefox.json',
  'scripts/release/resources/codex-package.json',
  'scripts/release/resources/codex-package-lock.json',
]
const RUNTIME_FILES = ['scripts/runtime/codex-bridge.mjs', 'scripts/runtime/acp-bridge.mjs']
const HOOK_MARKER = '# Tandix automatic commit version'

function git(args, input, optional = false) {
  const result = spawnSync('git', args, { cwd: ROOT, input, encoding: 'utf8' })
  if (result.status !== 0) {
    if (optional) return undefined
    throw new Error((result.stderr || result.error?.message || 'Git command failed').trim())
  }
  return result.stdout
}

function parseVersion(value) {
  const match = typeof value === 'string' && /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value)
  if (!match || Number(match[1]) > 65535 || Number(match[2]) > 65535) {
    throw new Error(`Expected a browser-compatible 0.x.y version, received ${JSON.stringify(value)}`)
  }
  return { minor: Number(match[1]), patch: Number(match[2]) }
}

function versionOf(text) {
  const version = JSON.parse(text).version
  parseVersion(version)
  return version
}

function nextVersion(staged, head) {
  const current = parseVersion(staged)
  // An explicitly staged minor release is its own starting point. Deriving
  // ordinary patches from HEAD makes a failed commit safe to retry.
  if (head !== undefined && current.minor !== parseVersion(head).minor) return staged
  const patch = (head === undefined ? current.patch : parseVersion(head).patch) + 1
  if (patch > 65535) throw new Error('Patch version reached 65535. Increase x manually and reset y to 0.')
  return `0.${current.minor}.${patch}`
}

function withVersion(path, text, version) {
  if (JSON_FILES.includes(path)) {
    versionOf(text)
    let updated = text.replace(/("version"\s*:\s*")[^"]+(")/u, (_match, before, after) => before + version + after)
    if (path.endsWith('codex-package-lock.json')) {
      const lock = JSON.parse(text)
      parseVersion(lock.packages?.['']?.version)
      updated = updated.replace(/("packages"\s*:\s*\{\s*""\s*:\s*\{[\s\S]*?"version"\s*:\s*")[^"]+(")/u,
        (_match, before, after) => before + version + after)
      if (JSON.parse(updated).packages[''].version !== version) throw new Error(`Cannot update root lock version: ${path}`)
    }
    if (versionOf(updated) !== version) throw new Error(`Cannot update version: ${path}`)
    return updated
  }
  const pattern = /(\bclientInfo:\s*\{[^}\n]*\bversion:\s*')[^']+(')/gu
  if ([...text.matchAll(pattern)].length !== 1) throw new Error(`Expected one Tandix client version in ${path}`)
  return text.replace(pattern, (_match, before, after) => before + version + after)
}

function bumpCommitVersion() {
  const stagedRoot = git(['show', ':package.json'])
  const headRoot = git(['show', 'HEAD:package.json'], undefined, true)
  const stagedVersion = versionOf(stagedRoot)
  const headVersion = headRoot === undefined ? undefined : versionOf(headRoot)
  const version = nextVersion(stagedVersion, headVersion)
  // Read and validate every index/worktree copy before changing anything.
  // update-index (rather than git add) preserves partially staged edits and
  // respects Git's temporary index for commit --only and linked worktrees.
  const changes = [...JSON_FILES, ...RUNTIME_FILES].map(path => {
    const entry = git(['ls-files', '--stage', '--', path])
    const mode = /^(100644|100755) [0-9a-f]+ 0\t/u.exec(entry)?.[1]
    if (mode === undefined || !lstatSync(join(ROOT, path)).isFile()) throw new Error(`Expected a tracked regular file: ${path}`)
    const staged = git(['show', `:${path}`])
    const working = readFileSync(join(ROOT, path), 'utf8')
    // Preserve an unstaged manual minor selection in the root package. The
    // user must stage it explicitly before it can select the next release.
    const keepWorkingVersion = path === 'package.json'
      && parseVersion(versionOf(working)).minor !== parseVersion(stagedVersion).minor
    return { path, mode, staged, working, nextStaged: withVersion(path, staged, version),
      nextWorking: keepWorkingVersion ? working : withVersion(path, working, version) }
  })
  const entries = changes.filter(change => change.staged !== change.nextStaged).map(change => {
    const blob = git(['hash-object', '-w', '--stdin'], change.nextStaged).trim()
    return `${change.mode} ${blob}\t${change.path}\0`
  }).join('')
  for (const change of changes) {
    if (change.working !== change.nextWorking) writeFileSync(join(ROOT, change.path), change.nextWorking)
  }
  if (entries !== '') git(['update-index', '-z', '--index-info'], entries)
  process.stdout.write(`Tandix version: ${version}\n`)
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function syncCommittedIndex() {
  const version = versionOf(git(['show', 'HEAD:package.json']))
  const entries = [...JSON_FILES, ...RUNTIME_FILES].map(path => {
    const entry = git(['ls-files', '--stage', '--', path])
    const mode = /^(100644|100755) [0-9a-f]+ 0\t/u.exec(entry)?.[1]
    if (mode === undefined) throw new Error(`Expected a tracked regular file: ${path}`)
    const staged = git(['show', `:${path}`])
    // commit --only leaves the real index behind its temporary commit index.
    // Update just the version fields; keep separately staged content intact.
    if (path === 'package.json' && parseVersion(versionOf(staged)).minor !== parseVersion(version).minor) return ''
    const updated = withVersion(path, staged, version)
    if (staged === updated) return ''
    const blob = git(['hash-object', '-w', '--stdin'], updated).trim()
    return `${mode} ${blob}\t${path}\0`
  }).join('')
  if (entries !== '') git(['update-index', '-z', '--index-info'], entries)
}

function installHooks() {
  const top = git(['rev-parse', '--show-toplevel'], undefined, true)?.trim()
  // Source archives and managed runtime installs may have no Git (or live
  // inside someone else's repository). They do not need development hooks.
  if (top === undefined || resolve(top) !== ROOT) return
  const configured = git(['config', '--local', '--get', 'core.hooksPath'], undefined, true)?.trim()
  const hooks = configured ? (isAbsolute(configured) ? configured : resolve(ROOT, configured))
    : resolve(ROOT, git(['rev-parse', '--git-common-dir']).trim(), 'hooks')
  mkdirSync(hooks, { recursive: true })
  for (const [name, option] of [['pre-commit', '--commit'], ['post-commit', '--after-commit']]) {
    const hook = join(hooks, name)
    const backup = join(hooks, `${name}.before-tandix-version`)
    if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(HOOK_MARKER)) {
      if (existsSync(backup)) throw new Error(`Cannot preserve an existing ${name} hook: ${backup} already exists`)
      renameSync(hook, backup)
    }
    const original = `if [ -x ${shellQuote(backup)} ]; then ${shellQuote(backup)} "$@"; fi`
    const source = ['#!/bin/sh', HOOK_MARKER, 'set -eu',
      ...(name === 'pre-commit' ? [original] : []),
      'tandix_root="$(git rev-parse --show-toplevel)"',
      'if [ -f "$tandix_root/scripts/dev/version.mjs" ]; then',
      `  ${shellQuote(process.execPath)} "$tandix_root/scripts/dev/version.mjs" ${option}`,
      'fi', ...(name === 'post-commit' ? [original] : []), ''].join('\n')
    writeFileSync(hook, source)
    chmodSync(hook, 0o755)
  }
  if (!configured) git(['config', '--local', 'core.hooksPath', hooks])
  process.stdout.write(`Tandix automatic patch version hooks installed: ${hooks}\n`)
}

try {
  if (process.argv[2] === '--install-hooks') installHooks()
  else if (process.argv[2] === '--commit') bumpCommitVersion()
  else if (process.argv[2] === '--after-commit') syncCommittedIndex()
  else throw new Error('Usage: node scripts/dev/version.mjs --install-hooks|--commit|--after-commit')
} catch (error) {
  process.stderr.write(`Tandix version: ${error.message}\n`)
  process.exitCode = 1
}
