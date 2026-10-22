import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ARTIFACT_MAX_BYTES, readSessionArtifact } from '../runtime/artifacts.mjs'
import { CodexBridge } from '../runtime/codex-bridge.mjs'
import { CursorBridge } from '../runtime/cursor-bridge.mjs'
import { WorkBuddyBridge } from '../runtime/workbuddy-bridge.mjs'

const reply = (href, type = 'assistant/message') => [{ event: { type,
  data: { message: { content: [{ type: 'text', text: `[下载长图](<${href}>)` }] } } } }]

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'tandix artifacts '))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const cwd = join(workspace, 'workspace')
  await mkdir(join(cwd, 'output'), { recursive: true })
  const path = join(cwd, 'output', '数学学习 长图.png')
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 34, 0, 17])
  await writeFile(path, bytes)
  return { workspace, cwd, path, bytes, events: reply(path) }
}

test('file downloads preserve the exact bytes and Chinese filename of a linked workspace output', async t => {
  const f = await fixture(t)
  for (const href of [f.path, pathToFileURL(f.path).href, `sandbox:${f.path}`, 'output/数学学习%20长图.png']) {
    const file = await readSessionArtifact({ ...f, path: href, events: reply(href) })
    assert.deepEqual(Buffer.from(file.data, 'base64'), f.bytes)
    assert.equal(file.filename, '数学学习 长图.png')
    assert.equal(file.size, f.bytes.length)
    assert.equal(file.mediaType, 'image/png')
  }
})

test('user links, another session’s reply, and unlinked paths never grant downloads', async t => {
  const f = await fixture(t)
  for (const events of [[], reply(f.path, 'user/message'), reply(join(f.cwd, 'different.png'))]) {
    await assert.rejects(readSessionArtifact({ ...f, events }), /not linked/u)
  }
})

test('outside paths, parent traversal and symlinks cannot escape the task directory', async t => {
  const f = await fixture(t)
  const directory = join(f.workspace, 'private')
  await mkdir(directory)
  const outside = join(directory, 'outside.png')
  await writeFile(outside, 'private data')
  const alias = join(f.cwd, 'output', 'alias')
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [outside, '../private/outside.png', 'output/../../private/outside.png', join(alias, 'outside.png')]) {
    await assert.rejects(readSessionArtifact({ ...f, path, events: reply(path) }), /Invalid artifact path|outside this session/u)
  }
})

test('only an explicitly selected task folder adds a second allowed download root', async t => {
  const f = await fixture(t)
  const outside = join(f.workspace, 'selected', 'report.pdf')
  await mkdir(join(f.workspace, 'selected'))
  await writeFile(outside, 'PDF')
  const file = await readSessionArtifact({ ...f, path: outside, events: reply(outside), roots: [f.cwd, join(f.workspace, 'selected')] })
  assert.equal(file.mediaType, 'application/pdf')
})

test('missing files, directories and oversized outputs return errors instead of fake links', async t => {
  const f = await fixture(t)
  const missing = join(f.cwd, 'missing.png')
  await assert.rejects(readSessionArtifact({ ...f, path: missing, events: reply(missing) }), /ENOENT/u)
  await assert.rejects(readSessionArtifact({ ...f, path: join(f.cwd, 'output'), events: reply(join(f.cwd, 'output')) }), /regular file/u)
  await truncate(f.path, ARTIFACT_MAX_BYTES + 1)
  await assert.rejects(readSessionArtifact(f), /25 MiB/u)
})

test('network URLs, network shares and invalid encodings are not local artifacts', async t => {
  const f = await fixture(t)
  for (const path of ['https://example.com/a.png', 'file://other-host/share/a.png', '//host/file', '\\\\host\\file', '%XX', 'output/a%00.png']) {
    await assert.rejects(readSessionArtifact({ ...f, path, events: reply(path) }))
  }
})

for (const Bridge of [CodexBridge, CursorBridge, WorkBuddyBridge]) {
  test(`${Bridge.name} serves only a known chat session’s linked files, including stored history`, async t => {
    const f = await fixture(t)
    const bridge = new Bridge({ workspace: f.workspace, hostDir: join(f.workspace, 'host'), extensionId: 'a'.repeat(32) })
    bridge.sessions.clear()
    if (Bridge === CodexBridge) {
      bridge.sessions.add('owned'); bridge.sessions.add('other')
      bridge.call = async (method, params) => {
        assert.equal(method, 'thread/read')
        return { thread: { turns: [{ items: params.threadId === 'owned'
          ? [{ type: 'agentMessage', text: `[下载长图](<${f.path}>)` }] : [] }] } }
      }
    } else {
      bridge.sessions.set('owned', { events: f.events })
      bridge.sessions.set('other', { events: [] })
    }
    const file = await bridge.rpc('session.artifact', { sessionId: 'owned', path: f.path })
    assert.deepEqual(Buffer.from(file.data, 'base64'), f.bytes)
    await assert.rejects(bridge.rpc('session.artifact', { sessionId: 'unknown', path: f.path }), /Unknown/u)
    await assert.rejects(bridge.rpc('session.artifact', { sessionId: 'other', path: f.path }), /not linked/u)
  })
}
