import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexBridge } from '../traceforge-codex-bridge.mjs'
import { titleFromCodexTurns } from '../traceforge-session-title.mjs'

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
  const bridge = new CodexBridge({ workspace: '/tmp/tandix-title-workspace',
    hostDir: '/tmp/tandix-title-host', extensionId: 'abcdefghijklmnopabcdefghijklmnop' })
  bridge.sessions = new Set(['older', 'newer'])
  bridge.call = async (method, params) => {
    if (method === 'thread/read') return { thread: {
      updatedAt: params.threadId === 'newer' ? 20 : 10,
      name: null, preview: 'Browser context after tab handoff (untrusted):',
    } }
    if (method === 'thread/turns/list') return { data: [userTurn(
      'Browser context after tab handoff (untrusted):\npage data',
      params.threadId === 'newer' ? '编辑飞书周报' : '查询历史邮件',
    )] }
    throw new Error(`Unexpected ${method}`)
  }
  const result = await bridge.rpc('session.list', {})
  assert.deepEqual(result.items.map(item => item.sessionId), ['newer', 'older'])
  assert.deepEqual(result.items.map(item => item.projections.values.title), ['编辑飞书周报', '查询历史邮件'])
})
