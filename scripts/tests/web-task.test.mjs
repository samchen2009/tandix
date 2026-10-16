import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { CodexBridge } from '../runtime/codex-bridge.mjs'

test('the companion advertises isolated webpage task support before accepting sessions', async () => {
  const bridge = new CodexBridge({ workspace: '/tmp', hostDir: '/tmp', extensionId: 'test' })
  const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await bridge.handleHttp({ method: 'GET', url: '/ext/bridge-config' }, response)
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).webTaskApiVersion, 1)
})

test('web PDF tasks use private workspaces, disable Tandix browser MCP and preserve task sandbox at prompt time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tandix-web-test-'))
  try {
    const bridge = new CodexBridge({ workspace: root, hostDir: root, extensionId: 'test', sandboxDirectory: '/unrelated-user-folder' })
    const calls = []
    bridge.call = async (method, params) => {
      calls.push([method, params])
      if (method === 'thread/start') return { thread: { id: `session-${calls.length}` } }
      return {}
    }
    const first = await bridge.rpc('session.create', { webTaskId: randomUUID() })
    const second = await bridge.rpc('session.create', { webTaskId: randomUUID() })
    const firstDir = bridge.webTaskDirectories.get(first.sessionId)
    assert.notEqual(firstDir, bridge.webTaskDirectories.get(second.sessionId))
    assert.equal(calls[0][1].sandbox, 'workspace-write')
    assert.equal(calls[0][1].ephemeral, true)
    assert.deepEqual(calls[0][1].config, { mcp_servers: { tandix: { enabled: false } },
      sandbox_workspace_write: { writable_roots: [firstDir], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } })
    assert.equal(calls[0][1].approvalPolicy, 'on-request')
    const pdf = Buffer.from('%PDF-1.7\nexample')
    await bridge.rpc('session.prompt', { sessionId: first.sessionId, content: [
      { type: 'text', text: 'Read this PDF' }, { type: 'file', name: 'report.pdf', mediaType: 'application/pdf', data: pdf.toString('base64') },
      { type: 'image', name: 'image.png', mediaType: 'image/png', data: 'aW1hZ2U=' },
    ] })
    const prompt = calls.find(([method]) => method === 'turn/start')[1]
    assert.deepEqual(prompt.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [firstDir], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true })
    const attachment = prompt.input.find(part => part.type === 'text' && part.text.startsWith('<USER_ATTACHMENT'))
    const path = attachment.text.split('\n')[1]
    assert.ok(path.startsWith(join(firstDir, 'attachments') + '/'))
    assert.deepEqual(readFileSync(path), pdf)
    assert.ok(prompt.input.some(part => part.type === 'image' && part.url.startsWith('data:image/png;base64,')))
    assert.deepEqual(await bridge.rpc('session.list', {}), { items: [] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('agent failure and cancellation retain terminal status for webpage consumers', () => {
  const bridge = new CodexBridge({ workspace: '/tmp', hostDir: '/tmp', extensionId: 'test' })
  bridge.sessions.add('web')
  const events = []
  bridge.event = (id, type, data) => { events.push({ id, type, data }) }
  for (const status of ['completed', 'failed', 'interrupted']) {
    bridge.receiveCodex(JSON.stringify({ method: 'turn/completed', params: { threadId: 'web', turn: { status, error: { message: 'Details' } } } }))
    assert.equal(events.at(-1).type, 'turn/end')
    assert.equal(events.at(-1).data.status, status)
    assert.equal(events.at(-1).data.error, 'Details')
  }
})
