import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { findWorkBuddyAgent, WorkBuddyBridge } from '../runtime/workbuddy-bridge.mjs'
import { CursorBridge, findCursorAgent } from '../runtime/cursor-bridge.mjs'

for (const [backend, Bridge, findAgent, envKey, executable] of [
  ['workbuddy', WorkBuddyBridge, findWorkBuddyAgent, 'WORKBUDDY_AGENT_PATH', 'codebuddy'],
  ['cursor', CursorBridge, findCursorAgent, 'CURSOR_AGENT_PATH', 'cursor-agent'],
]) describe(backend, () => {

function bridge() {
  const b = new Bridge({ agentPath: '/agent', workspace: '/tmp', runtimePath: new URL('../../package.json', import.meta.url).pathname,
    hostDir: `/tmp/tandix-unpersisted-${backend}-unit`, extensionId: 'a'.repeat(32) })
  b.sessions.clear()
  b.sessions.set('s1', { id: 's1', events: [], updatedAt: 1, title: null })
  b.sessions.set('s2', { id: 's2', events: [], updatedAt: 1, title: null })
  b.persist = () => {}
  const sent = []; const written = []
  b.browser = { readyState: 1, send: text => sent.push(JSON.parse(text)), close() {} }
  b.write = message => written.push(message)
  return { b, sent, written }
}

test('ACP permission routing preserves session ownership and never grants persistent permission', () => {
  const { b, sent, written } = bridge()
  b.requestPermission({ id: 71, params: { sessionId: 's2', toolCall: { title: 'Edit', rawInput: { path: '/tmp/example' } },
    options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'forever', kind: 'allow_always' }, { optionId: 'deny', kind: 'reject_once' }] } })
  assert.equal(sent[0].frame.payload.backend, backend)
  assert.equal(sent[0].frame.payload.sessionId, 's2')
  assert.equal(written.length, 0)
  b.settlePermission(sent[0].frame.rpcId, 'accept')
  assert.deepEqual(written[0], { jsonrpc: '2.0', id: 71, result: { outcome: { outcome: 'selected', optionId: 'once' } } })
  assert.equal(b.settlePermission(sent[0].frame.rpcId, 'accept'), false)
  b.requestPermission({ id: 72, params: { sessionId: 's1', options: [{ optionId: 'forever', kind: 'allow_always' }] } })
  b.settlePermission([...b.permissions.keys()][0], 'accept')
  assert.equal(written.at(-1).result.outcome.outcome, 'cancelled')
  b.close()
})

test('ACP chunks become a coherent Tandix stream and durable history', async () => {
  const { b, sent } = bridge()
  b.receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'unknown', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } } } }))
  assert.equal(sent.length, 0)
  for (const text of ['你好', '，已检查网页。']) b.update({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
  b.finishStream('s1')
  const history = await b.rpc('session.history', { sessionId: 's1' })
  assert.equal(history.events[0].event.data.message.content[0].text, '你好，已检查网页。')
  assert.equal(history.events[0].event.data.turn, 1)
  const streams = sent.filter(frame => frame.frame?.method === 'session/assistant-stream').map(frame => frame.frame.payload.frame)
  assert.deepEqual(streams.map(frame => frame.type), ['start', 'chunk', 'chunk', 'end'])
  assert.deepEqual(streams.map(frame => frame.revision), [1, 2, 3, 4])
  assert.equal(streams.at(-1).outcome.seq, 1)
  assert.equal((await b.rpc('session.history', { sessionId: 's2' })).events.length, 0)
  b.close()
})

test('prompt RPC returns before the turn ends and cancellation targets only its own session', async () => {
  const { b, written, sent } = bridge()
  b.loaded.add('s1'); b.loaded.add('s2')
  const completions = new Map()
  b.call = async (method, params) => {
    assert.equal(method, 'session/prompt')
    assert.match(params.prompt[0].text, /Tandix/u)
    return new Promise(resolve => completions.set(params.sessionId, resolve))
  }
  assert.deepEqual(await b.rpc('session.prompt', { sessionId: 's1', content: [{ type: 'text', text: 'Read the page' }] }), { accepted: true })
  await b.rpc('session.prompt', { sessionId: 's2', content: [{ type: 'text', text: 'Other tab' }] })
  await assert.rejects(b.rpc('session.prompt', { sessionId: 's1', content: [{ type: 'text', text: 'Again' }] }), /already running/u)
  await b.rpc('session.cancel', { sessionId: 's1' })
  assert.deepEqual(written.at(-1), { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } })
  assert.equal(sent.some(frame => frame.frame?.payload?.event?.type === 'turn/end'), false)
  completions.get('s1')({ stopReason: 'cancelled' }); completions.get('s2')({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.turns.size, 0)
  assert.equal(sent.filter(frame => frame.frame?.payload?.event?.type === 'turn/end').length, 2)
  b.close()
})

test('browser calls and authenticated MCP routes remain isolated by session', async () => {
  const { b, sent } = bridge()
  const one = b.requestBrowser('browser_snapshot', {}, 's1')
  const two = b.requestBrowser('browser_snapshot', {}, 's2')
  assert.deepEqual(sent.map(frame => frame.sessionId), ['s1', 's2'])
  b.close()
  await assert.rejects(one, /stopped/u); await assert.rejects(two, /stopped/u)
})

test('cancel rejects only browser actions owned by the cancelled session', async () => {
  const { b, sent } = bridge()
  b.turns.add('s1'); b.turns.add('s2')
  const one = b.requestBrowser('browser_click', { index: 1 }, 's1')
  const two = b.requestBrowser('browser_snapshot', {}, 's2')
  await b.rpc('session.cancel', { sessionId: 's1' })
  await assert.rejects(one, /cancelled/u)
  assert.equal(b.toolPending.size, 1)
  assert.equal(sent.filter(frame => frame.t === 'tool.cancel').length, 1)
  b.close(); await assert.rejects(two, /stopped/u)
})

test('session loading blocks duplicate prompts and does not append replayed history', async () => {
  const { b } = bridge()
  b.agentCapabilities = { loadSession: true }
  let finishLoad
  b.call = async method => {
    if (method === 'session/load') {
      b.update({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } })
      await new Promise(resolve => { finishLoad = resolve }); return {}
    }
    return { stopReason: 'end_turn' }
  }
  const payload = { sessionId: 's1', content: [{ type: 'text', text: 'Read' }] }
  const first = b.rpc('session.prompt', payload)
  await assert.rejects(b.rpc('session.prompt', payload), /already running/u)
  finishLoad(); await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.sessions.get('s1').events.some(item => item.event.type === 'assistant/message'), false)
  assert.equal(b.turns.size, 0)
  b.close()
})

test('agent discovery checks configured path and local installation; directories are not agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tandix-wb-discovery-'))
  try {
    const path = join(root, executable); await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, 0o700)
    assert.equal(findAgent({ env: { PATH: root }, home: root, platform: 'darwin' }), await realpath(path))
    assert.equal(findAgent({ env: { [envKey]: path, PATH: '' }, home: root }), await realpath(path))
    assert.throws(() => findAgent({ env: { [envKey]: 'relative' } }), /absolute/u)
    assert.throws(() => findAgent({ env: { [envKey]: join(root, 'missing') } }), /executable/u)
    assert.throws(() => findAgent({ env: { [envKey]: root } }), /executable/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('selected sandbox boundaries are rejected until ACP enforces them', async () => {
  const { b } = bridge(); b.sandboxDirectory = '/tmp/restricted'
  await assert.rejects(b.start(), /does not yet enforce/u)
  b.close()
})

test('local ACP process reaches the browser through the real MCP transport and returns a durable reply', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tandix-wb-ipc-'))
  const fixture = fileURLToPath(new URL('./fixtures/workbuddy-acp.mjs', import.meta.url))
  const workspace = fileURLToPath(new URL('../../', import.meta.url))
  const runtimePath = await realpath(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const { WebSocket } = createRequire(runtimePath)('ws')
  let b; let socket
  try {
    await chmod(fixture, 0o700)
    b = await Bridge.open({ agentPath: fixture, workspace, runtimePath, hostDir: root, extensionId: 'a'.repeat(32) })
    const config = await fetch(`http://127.0.0.1:${b.port}/ext/bridge-config`).then(response => response.json())
    assert.equal(config.backend, backend)
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/tool/${'0'.repeat(32)}`, { method: 'POST' })).status, 403)
    const frames = []
    socket = new WebSocket(b.wsUrl, { origin: `chrome-extension://${'a'.repeat(32)}` })
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame)
      if (frame.t === 'tool.call') socket.send(JSON.stringify({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'Demo page read' } }))
    })
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const waitFor = async predicate => {
      const deadline = Date.now() + 8000
      while (!predicate()) { if (Date.now() > deadline) throw new Error('Protocol frame timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    socket.send(JSON.stringify({ t: 'hello', caps: {} }))
    await waitFor(() => frames.some(frame => frame.t === 'hello.ok'))
    socket.send(JSON.stringify({ t: 'rpc', id: 'create', method: 'session.create', payload: {} }))
    await waitFor(() => frames.some(frame => frame.id === 'create'))
    const sessionId = frames.find(frame => frame.id === 'create').result.result.value.sessionId
    socket.send(JSON.stringify({ t: 'rpc', id: 'prompt', method: 'session.prompt', payload: { sessionId, content: [{ type: 'text', text: 'Read the page' }] } }))
    await waitFor(() => frames.some(frame => frame.frame?.payload?.event?.type === 'turn/end'))
    assert.equal(frames.find(frame => frame.id === 'prompt').ok, true)
    assert.equal(frames.find(frame => frame.t === 'tool.call').sessionId, sessionId)
    assert.equal(b.turns.size, 0)
    const reply = b.sessions.get(sessionId).events.find(item => item.event.type === 'assistant/message')
    assert.equal(reply.event.data.message.content[0].text, 'Demo page read')
  } finally { socket?.terminate(); b?.close(); await rm(root, { recursive: true, force: true }) }
})

})
