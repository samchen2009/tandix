#!/usr/bin/env node
// Select test files explicitly: ACP fixtures are long-running servers, not tests.
import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const files = ['tests', 'private'].flatMap(directory => {
  const path = join(root, 'scripts', directory)
  return existsSync(path) ? readdirSync(path).filter(name => name.endsWith('.test.mjs'))
    .sort().map(name => join(path, name)) : []
})
for (const [command, args] of [
  [process.execPath, ['--test', ...files]],
  [process.platform === 'win32' ? 'python' : 'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', join(root, 'scripts/tests'), '-p', 'test_*.py']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
