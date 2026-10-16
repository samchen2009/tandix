import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPortableNode, installedPortableNodePath, portableNodePath } from '../runtime/portable-node.mjs'

test('reuses a matching legacy node.exe without copying over it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tandix-legacy-node-'))
  try {
    const source = join(root, 'bundled.exe')
    const runtime = join(root, 'installed')
    const legacy = join(runtime, 'node.exe')
    mkdirSync(runtime)
    writeFileSync(source, 'same Node runtime')
    writeFileSync(legacy, 'same Node runtime')
    chmodSync(legacy, 0o444)
    const before = statSync(legacy)

    assert.equal(installedPortableNodePath(source, runtime), legacy)
    assert.equal(installPortableNode(source, runtime), legacy)
    assert.equal(statSync(legacy).ino, before.ino)
    assert.equal(statSync(legacy).mtimeMs, before.mtimeMs)
    assert.equal(existsSync(portableNodePath(source, runtime).path), false)

    writeFileSync(source, 'different Node runtime')
    const replacement = installPortableNode(source, runtime)
    assert.notEqual(replacement, legacy)
    assert.equal(readFileSync(legacy, 'utf8'), 'same Node runtime')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('updating a bundled Node runtime leaves the previous executable untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'tandix-portable-node-'))
  try {
    const source = join(root, 'node.exe')
    const runtime = join(root, 'installed')
    writeFileSync(source, 'v4 node binary')
    const oldPath = installPortableNode(source, runtime)
    const oldStat = statSync(oldPath)
    chmodSync(oldPath, 0o444)

    assert.equal(installPortableNode(source, runtime), oldPath)
    assert.equal(statSync(oldPath).ino, oldStat.ino)
    assert.equal(statSync(oldPath).mtimeMs, oldStat.mtimeMs)

    writeFileSync(source, 'v5 node binary')
    const newPath = installPortableNode(source, runtime)
    assert.notEqual(newPath, oldPath)
    assert.equal(portableNodePath(source, runtime).path, newPath)
    assert.equal(readFileSync(oldPath, 'utf8'), 'v4 node binary')
    assert.equal(readFileSync(newPath, 'utf8'), 'v5 node binary')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
