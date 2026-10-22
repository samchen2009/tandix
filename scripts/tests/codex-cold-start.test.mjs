import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CodexBridge } from '../runtime/codex-bridge.mjs'

const source = fileURLToPath(new URL('../runtime/', import.meta.url))
const runtimePath = realpathSync(fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)))
const require = createRequire(runtimePath)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'Tandix first install '))
  const clients = []
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()))
    rmSync(root, { recursive: true, force: true })
  })
  // Public source installs have runtime scripts but no pre-existing task workspace.
  const scripts = join(root, 'scripts', 'runtime')
  mkdirSync(scripts, { recursive: true })
  for (const name of ['codex-mcp.mjs', 'browser-guidance.mjs']) cpSync(join(source, name), join(scripts, name))
  const hostDir = join(root, 'host')
  mkdirSync(hostDir)
  const bridge = new CodexBridge({ workspace: root, hostDir, nodePath: process.execPath,
    runtimePath, extensionId: 'a'.repeat(32), webTaskDirectory: join(root, 'web-tasks') })
  bridge.port = 43189; bridge.secret = 'test-secret'; bridge.groupSession = async () => {}
  let tools = []
  let created = 0
  bridge.call = async (method, params) => {
    if (method === 'thread/start' || method === 'thread/resume') {
      assert.equal(params.cwd, join(root, 'workspace'))
      assert.equal(existsSync(params.cwd), true, 'working directory must exist before Codex initializes MCP')
      const config = params.config.mcp_servers.tandix
      assert.equal(config.required, true)
      const client = new Client({ name: 'cold-start-test', version: '1.0.0' }, { capabilities: {} })
      clients.push(client)
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, cwd: params.cwd, stderr: 'pipe' }))
      tools = (await client.listTools()).tools
      return { thread: { id: `session-${++created}` } }
    }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'tandix', runtimeStatus: 'connected',
      tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }] }
    return { accepted: true }
  }
  return { bridge, root }
}

test('a clean first Codex session creates its own directory and starts the real Tandix MCP process', { timeout: 15_000 }, async t => {
  const { bridge, root } = fixture(t)
  const cwd = join(root, 'workspace')
  assert.equal(existsSync(cwd), false)
  const config = bridge.browserToolConfig('a'.repeat(32)).mcp_servers.tandix
  // The Node executable and MCP script both exist, yet a missing cwd alone causes ENOENT.
  const before = spawnSync(config.command, config.args, { cwd })
  assert.equal(before.error?.code, 'ENOENT')
  assert.deepEqual(await bridge.rpc('session.create', {}), { sessionId: 'session-1' })
  assert.equal(bridge.loaded.has('session-1'), true)
  // If a working directory is removed after startup, a subsequent session recreates it.
  rmSync(cwd, { recursive: true })
  assert.deepEqual(await bridge.rpc('session.create', {}), { sessionId: 'session-2' })
})

test('resuming a saved session recreates the task directory before MCP starts', { timeout: 15_000 }, async t => {
  const { bridge, root } = fixture(t)
  bridge.sessions.add('saved-session')
  assert.equal(existsSync(join(root, 'workspace')), false)
  assert.deepEqual(await bridge.rpc('session.prompt', { sessionId: 'saved-session',
    content: [{ type: 'text', text: 'Read this page' }] }), { accepted: true })
  assert.equal(bridge.loaded.has('saved-session'), true)
})

test('a file blocking the workspace produces a real error without starting a thread', async t => {
  const { bridge, root } = fixture(t)
  writeFileSync(join(root, 'workspace'), 'not a directory')
  let called = false
  bridge.call = async () => { called = true; return {} }
  await assert.rejects(bridge.rpc('session.create', {}), /EEXIST|ENOTDIR/u)
  assert.equal(called, false)
})
