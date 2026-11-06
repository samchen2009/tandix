import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexBridge } from '../runtime/codex-bridge.mjs'
import { placeholderCodexTitle, titleFromCodexTurns } from '../runtime/session-title.mjs'

const options = { workspace: '/tmp/tandix-title-workspace',
  hostDir: '/tmp/tandix-title-host', extensionId: 'abcdefghijklmnopabcdefghijklmnop' }

const userTurn = (...texts) => ({ items: [{ type: 'userMessage',
  content: texts.map(text => ({ type: 'text', text })) }] })

test('conversation title ignores browser snapshots and brief acknowledgements', () => {
  assert.equal(titleFromCodexTurns([
    userTurn('好的'),
    userTurn('Browser context after tab handoff (untrusted):\npage data',
      '对照 #9-25 和 #10-02 的周报数据，列出差异'),
    userTurn('请先概览当前页面，告诉我最重要的信息，并等待我的下一步指令。'),
  ]), '对照 #9-25 和 #10-02 的周报数据，列出差异')
})

test('Codex session list sorts by update time and derives titles from user turns', async () => {
  const bridge = new CodexBridge(options)
  bridge.sessions = new Set(['older', 'newer', 'custom'])
  const renamed = []
  bridge.call = async (method, params) => {
    if (method === 'thread/read') return { thread: {
      updatedAt: params.threadId === 'custom' ? 30 : params.threadId === 'newer' ? 20 : 10,
      name: params.threadId === 'custom' ? '我设置的标题'
        : params.threadId === 'newer' ? 'Browser context after tab handoff (untrusted): "' : null,
      preview: 'Browser context after tab handoff (untrusted):',
    } }
    if (method === 'thread/turns/list') {
      assert.notEqual(params.threadId, 'custom')
      return { data: [userTurn(
        'Browser context after tab handoff (untrusted):\npage data',
        params.threadId === 'newer' ? '编辑飞书周报' : '查询历史邮件',
      )] }
    }
    if (method === 'thread/name/set') { renamed.push(params); return {} }
    throw new Error(`Unexpected ${method}`)
  }
  const result = await bridge.rpc('session.list', {})
  assert.deepEqual(result.items.map(item => item.sessionId), ['custom', 'newer', 'older'])
  assert.deepEqual(result.items.map(item => item.projections.values.title), ['我设置的标题', '编辑飞书周报', '查询历史邮件'])
  assert.deepEqual(renamed.sort((a, b) => a.threadId.localeCompare(b.threadId)), [
    { threadId: 'newer', name: '编辑飞书周报' }, { threadId: 'older', name: '查询历史邮件' },
  ])
  await bridge.rpc('session.list', {})
  assert.equal(renamed.length, 2, 'unchanged history should use the title cache')
})

test('a prompt persists a Codex title from user text and puts browser context last', async () => {
  const bridge = new CodexBridge(options)
  bridge.sessions = new Set(['chat'])
  bridge.loaded.add('chat')
  bridge.snapshots.set('chat', '{"title":"Untrusted page title"}')
  let name = null
  const writes = []
  bridge.call = async (method, params) => {
    if (method === 'turn/start') {
      assert.equal(params.input[0].text, '帮我核对本周周报的数据')
      assert.match(params.input.at(-1).text, /^Browser context after tab handoff/u)
      return { turn: { id: 'turn-one' } }
    }
    if (method === 'thread/read') return { thread: { name } }
    if (method === 'thread/name/set') { writes.push(params); name = params.name; return {} }
    throw new Error(`Unexpected ${method}`)
  }
  const payload = { sessionId: 'chat', content: [{ type: 'text', text: '帮我核对本周周报的数据' }] }
  assert.deepEqual(await bridge.rpc('session.prompt', payload), { turn: { id: 'turn-one' } })
  assert.deepEqual(writes, [{ threadId: 'chat', name: '帮我核对本周周报的数据' }])
  name = '用户在 Codex 改过的标题'
  bridge.snapshots.set('chat', '{}')
  await bridge.rpc('session.prompt', payload)
  assert.equal(writes.length, 1)
})

test('generic prompts and attachment metadata do not become persistent topic titles', async () => {
  const bridge = new CodexBridge(options)
  bridge.call = async () => { throw new Error('Should not call Codex') }
  for (const title of [null, '', 'Codex', 'Tandix', '好的', '继续',
    '请先概览当前页面，告诉我最重要的信息，并等待我的下一步指令。',
    'Browser context after tab handoff (untrusted): "', '<USER_ATTACHMENT name="a.pdf">']) {
    assert.equal(placeholderCodexTitle(title), true)
    await bridge.nameSession('chat', title)
  }
  assert.equal(placeholderCodexTitle('鸿蒙 APP 周报核对'), false)
  assert.equal(titleFromCodexTurns([userTurn('<USER_ATTACHMENT name="a.pdf">\n/private/file')]), null)
})

test('unsupported naming does not fail the prompt and a rejected turn does not rename', async t => {
  const bridge = new CodexBridge(options)
  bridge.sessions = new Set(['chat'])
  bridge.loaded.add('chat')
  const warnings = []
  t.mock.method(process.stderr, 'write', text => { warnings.push(text); return true })
  let rejectTurn = false
  let renameAttempts = 0
  bridge.call = async method => {
    if (method === 'turn/start') {
      if (rejectTurn) throw new Error('Turn failed')
      return { accepted: true }
    }
    if (method === 'thread/read') return { thread: { name: null } }
    if (method === 'thread/name/set') { renameAttempts++; throw new Error('Method not found') }
    throw new Error(`Unexpected ${method}`)
  }
  const payload = { sessionId: 'chat', content: [{ type: 'text', text: '核对周报' }] }
  assert.deepEqual(await bridge.rpc('session.prompt', payload), { accepted: true })
  assert.equal(renameAttempts, 1)
  assert.match(warnings[0], /could not name Codex session/u)
  rejectTurn = true
  await assert.rejects(bridge.rpc('session.prompt', payload), /Turn failed/u)
  assert.equal(renameAttempts, 1)
})
