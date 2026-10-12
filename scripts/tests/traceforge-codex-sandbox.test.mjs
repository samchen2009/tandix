import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CodexBridge, TANDIX_DEVELOPER_INSTRUCTIONS } from '../traceforge-codex-bridge.mjs'
import { TANDIX_BROWSER_INSTRUCTIONS } from '../traceforge-browser-guidance.mjs'

const options = {
  workspace: '/tmp/tandix-test-workspace',
  hostDir: '/tmp/tandix-test-host',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
}

test('Codex keeps its existing workspace-write mode without a selected folder', () => {
  const bridge = new CodexBridge(options)
  assert.deepEqual(bridge.sandboxOptions(), { sandbox: 'workspace-write' })
})

test('Codex adds a selected folder without losing its own workspace', () => {
  const bridge = new CodexBridge({ ...options, sandboxDirectory: '/Users/test/Downloads/Invoices' })
  assert.deepEqual(bridge.sandboxOptions(), {
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/tmp/tandix-test-workspace/workspace', '/Users/test/Downloads/Invoices'],
    },
  })
})

test('parallel Codex browser calls retain their owning session', async () => {
  const bridge = new CodexBridge(options)
  const sent = []
  bridge.browser = { readyState: 1, send: (raw) => { sent.push(JSON.parse(raw)) } }
  const first = bridge.requestBrowser('browser_snapshot', {}, 'session-one')
  const second = bridge.requestBrowser('browser_snapshot', {}, 'session-two')
  assert.deepEqual(sent.map((frame) => frame.sessionId), ['session-one', 'session-two'])
  for (const frame of sent) {
    const pending = bridge.toolPending.get(frame.id)
    clearTimeout(pending.timer)
    pending.resolve({ ok: true })
  }
  await Promise.all([first, second])
})

test('Codex tool HTTP endpoint rejects unknown routes and dispatches a known session', async () => {
  const bridge = new CodexBridge(options)
  bridge.secret = 'private-secret'
  const routeToken = 'a'.repeat(32)
  bridge.toolRoutes.set(routeToken, 'session-one')
  const calls = []
  bridge.requestBrowser = async (...args) => {
    calls.push(args)
    return { ok: true, result: { text: 'page' } }
  }
  const request = (url, name = 'browser_snapshot', args = {}) => ({
    method: 'POST', url, headers: { authorization: 'Bearer private-secret' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ name, args }) },
  })
  const response = () => ({
    status: null, body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  })
  const unknown = response()
  await bridge.handleHttp(request(`/tool/${'b'.repeat(32)}`), unknown)
  assert.equal(unknown.status, 404)
  const known = response()
  await bridge.handleHttp(request(`/tool/${routeToken}`), known)
  assert.equal(known.status, 200)
  assert.deepEqual(calls, [['browser_snapshot', {}, 'session-one']])
  const save = response()
  const skill = { name: '周报', description: '写周报时使用', instructions: '核对数据。' }
  await bridge.handleHttp(request(`/tool/${routeToken}`, 'tandix_skill_save', skill), save)
  assert.equal(save.status, 200)
  assert.deepEqual(calls.at(-1), ['tandix_skill_save', skill, 'session-one'])
})

test('Codex sessions are placed in the Tandix section when supported', async () => {
  const bridge = new CodexBridge(options)
  const calls = []
  bridge.call = async (method, params) => {
    calls.push([method, params])
    if (method === 'threadSection/list') return { data: [], nextCursor: null }
    if (method === 'threadSection/create') return { section: { id: 'tandix-section' } }
    return {}
  }
  await bridge.groupSession('session-one')
  assert.deepEqual(calls.map(([method]) => method), [
    'threadSection/list', 'threadSection/create', 'thread/section/move',
  ])
  assert.deepEqual(calls[2][1], { threadId: 'session-one', sectionId: 'tandix-section' })
})

test('Codex verifies that the per-session browser MCP tools are connected', async () => {
  const bridge = new CodexBridge(options)
  bridge.call = async (method, params) => {
    assert.equal(method, 'mcpServerStatus/list')
    assert.equal(params.threadId, 'session-one')
    return { data: [{
      name: 'tandix',
      runtimeStatus: 'connected',
      tools: {
        snapshot: { name: 'browser_snapshot' },
        click: { name: 'browser_click' },
        type: { name: 'browser_type' },
        list: { name: 'browser_list_tabs' },
        follow: { name: 'browser_follow_tab' },
      },
    }] }
  }
  await bridge.verifyBrowserMcpTools('session-one')
})

test('Tandix instructions distinguish its browser from other providers and require an actual tool check', () => {
  assert.ok(TANDIX_BROWSER_INSTRUCTIONS.length <= 512)
  assert.match(TANDIX_BROWSER_INSTRUCTIONS, /call browser_snapshot/u)
  assert.match(TANDIX_BROWSER_INSTRUCTIONS, /browser_list_tabs and browser_follow_tab/u)
  assert.match(TANDIX_BROWSER_INSTRUCTIONS, /other browser connectors have separate tab inventories/u)
  assert.match(readFileSync(new URL('../traceforge-codex-mcp.mjs', import.meta.url), 'utf8'),
    /instructions: TANDIX_BROWSER_INSTRUCTIONS/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /Choose the next useful tool from the user's objective and current evidence/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /Check a Tandix browser tool before reporting the tab unavailable/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /Do not use another browser connector to operate a Tandix-controlled tab/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /ask the user to connect another extension for this tab/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /Do not replace an existing email thread or document/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /Never send a draft-only message/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /tell Tandix exactly what information or evidence you need/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /You remain responsible for deciding how to proceed/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /side-panel tabs are extension UI, not browser tabs/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /not Codex SKILL\.md skills/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /do not claim it appears in Tandix Skills/u)
  assert.match(TANDIX_DEVELOPER_INSTRUCTIONS, /a failed tool call or the end of a turn does not itself complete the Goal/u)
  assert.doesNotMatch(TANDIX_DEVELOPER_INSTRUCTIONS, /lark-doc/u)
})

test('Codex rejects a browser MCP server missing tab discovery or form-entry tools', async () => {
  const bridge = new CodexBridge(options)
  bridge.call = async () => ({ data: [{ name: 'tandix', runtimeStatus: 'connected', tools: {
    snapshot: { name: 'browser_snapshot' },
  } }] })
  await assert.rejects(bridge.verifyBrowserMcpTools('session-one'), /missing browser_click, browser_type, browser_list_tabs, browser_follow_tab/u)
})

test('resuming an existing Tandix session refreshes browser instructions before the next turn', async () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  bridge.verifyBrowserMcpTools = async () => {}
  bridge.browserToolConfig = () => ({ mcp_servers: { tandix: {} } })
  bridge.rememberToolRoute = () => {}
  const calls = []
  bridge.call = async (method, params) => {
    calls.push([method, params])
    return { accepted: true }
  }
  await bridge.rpc('session.prompt', { sessionId: 'session-one', content: [{ type: 'text', text: 'Draft a reply' }] })
  assert.equal(calls[0][0], 'thread/resume')
  assert.equal(calls[0][1].developerInstructions, TANDIX_DEVELOPER_INSTRUCTIONS)
  assert.equal(calls[1][0], 'turn/start')
})

test('Codex refuses a chat session whose browser MCP tools did not start', async () => {
  const bridge = new CodexBridge(options)
  bridge.call = async () => ({ data: [{
    name: 'tandix', runtimeStatus: 'failed', tools: {}, toolsError: 'spawn failed',
  }] })
  await assert.rejects(
    bridge.verifyBrowserMcpTools('session-one'),
    /browser MCP tools failed to start \(spawn failed\)/u,
  )
})

test('Codex exposes installed skills, configured MCP servers and plugins to Tandix', async () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  const calls = []
  bridge.call = async (method, params) => {
    calls.push([method, params])
    if (method === 'skills/list') return { data: [{ cwd: '/tmp/tandix-test-workspace/workspace',
      skills: [{ name: 'example', description: 'Example skill', path: '/skills/example/SKILL.md',
        scope: 'user', enabled: true, pluginId: null }], errors: [] }] }
    if (method === 'plugin/list') return { marketplaces: [{ name: 'catalog', path: null,
      plugins: [{ id: 'plugin-one', name: 'example-plugin', installed: false, enabled: false,
        availability: 'AVAILABLE', interface: { shortDescription: 'Example plugin' } }] }] }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'external', runtimeStatus: 'connected',
      authStatus: 'oAuth', tools: { read: { name: 'read_document' } }, toolsError: null }], nextCursor: null }
    throw new Error(`Unexpected method ${method}`)
  }
  const result = await bridge.rpc('codex.capabilities', { sessionId: 'session-one' })
  assert.equal(result.skills[0].name, 'example')
  assert.deepEqual(result.mcpServers[0].tools, ['read_document'])
  assert.equal(result.plugins[0].remoteMarketplaceName, 'catalog')
  assert.equal(calls.find(([method]) => method === 'mcpServerStatus/list')[1].threadId, 'session-one')
})

test('Codex adds a generic MCP server to its own config and reloads it', async () => {
  const bridge = new CodexBridge(options)
  const calls = []
  bridge.call = async (method, params) => {
    calls.push([method, params])
    if (method === 'config/value/write') return { status: 'ok' }
    return {}
  }
  await bridge.rpc('codex.mcp.add', { name: 'docs', transport: 'http', url: 'https://example.com/mcp' })
  assert.deepEqual(calls, [
    ['config/value/write', { keyPath: 'mcp_servers.docs', value: { url: 'https://example.com/mcp' }, mergeStrategy: 'upsert' }],
    ['config/mcpServer/reload', {}],
  ])
  await assert.rejects(bridge.rpc('codex.mcp.add', {
    name: 'bad.name', transport: 'http', url: 'https://example.com/mcp',
  }), /Invalid MCP server name/u)
  await assert.rejects(bridge.rpc('codex.mcp.add', {
    name: 'unsafe', transport: 'http', url: 'https://user:password@example.com/mcp',
  }), /cannot contain credentials/u)
})

test('Tandix delegates goal lifecycle to Codex and rejects invalid updates', async () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  const calls = []
  bridge.call = async (method, params) => {
    calls.push([method, params])
    return method === 'thread/goal/get' ? { goal: null } : { goal: { threadId: 'session-one', status: 'active' } }
  }
  await bridge.rpc('codex.goal.get', { sessionId: 'session-one' })
  await bridge.rpc('codex.goal.set', { sessionId: 'session-one', objective: '  Finish report  ', tokenBudget: 30000 })
  await bridge.rpc('codex.goal.set', { sessionId: 'session-one', status: 'paused' })
  await bridge.rpc('codex.goal.clear', { sessionId: 'session-one' })
  assert.deepEqual(calls, [
    ['thread/goal/get', { threadId: 'session-one' }],
    ['thread/goal/set', { threadId: 'session-one', objective: 'Finish report', tokenBudget: 30000 }],
    ['thread/goal/set', { threadId: 'session-one', status: 'paused' }],
    ['thread/goal/clear', { threadId: 'session-one' }],
  ])
  await assert.rejects(bridge.rpc('codex.goal.set', { sessionId: 'other', objective: 'bad' }), /Unknown Tandix/u)
  await assert.rejects(bridge.rpc('codex.goal.set', { sessionId: 'session-one', status: 'complete' }), /Invalid goal/u)
  await assert.rejects(bridge.rpc('codex.goal.set', { sessionId: 'session-one', objective: 'bad', tokenBudget: -1 }), /positive integer/u)
})

test('shared Goal protocol normalizes the Codex token budget', async () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  const calls = []
  bridge.call = async (method, params) => {
    calls.push([method, params])
    return { goal: { objective: 'Finish report', status: params?.status ?? 'active', tokensUsed: 42, tokenBudget: 30000 } }
  }
  const created = await bridge.rpc('goal.create', { sessionId: 'session-one', objective: ' Finish report ', budgetLimit: 30000 })
  assert.deepEqual(created.goal, { objective: 'Finish report', status: 'active', budgetKind: 'tokens',
    budgetUsed: 42, budgetLimit: 30000 })
  await bridge.rpc('goal.pause', { sessionId: 'session-one' })
  await bridge.rpc('goal.resume', { sessionId: 'session-one' })
  await bridge.rpc('goal.clear', { sessionId: 'session-one' })
  assert.deepEqual(calls, [
    ['thread/goal/set', { threadId: 'session-one', objective: 'Finish report', tokenBudget: 30000 }],
    ['thread/goal/set', { threadId: 'session-one', status: 'paused' }],
    ['thread/goal/set', { threadId: 'session-one', status: 'active' }],
    ['thread/goal/clear', { threadId: 'session-one' }],
  ])
})

test('Codex goal notifications reach only their owning Tandix session', () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  const frames = []
  bridge.browser = { readyState: 1, send: raw => frames.push(JSON.parse(raw)) }
  bridge.onCodexEvent('thread/goal/updated', { threadId: 'session-one', goal: { status: 'active' } })
  bridge.onCodexEvent('thread/goal/updated', { threadId: 'other', goal: { status: 'active' } })
  bridge.onCodexEvent('thread/goal/cleared', { threadId: 'session-one' })
  assert.deepEqual(frames.map(frame => frame.frame.method), ['goal/updated', 'goal/cleared'])
  assert.equal(frames[0].frame.payload.sessionId, 'session-one')
})

test('external MCP activity shows the server and tool without forwarding arguments', () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  bridge.onCodexEvent('item/started', { threadId: 'session-one', item: {
    id: 'call-one', type: 'mcpToolCall', server: 'external', tool: 'read_document',
    arguments: { token: 'private', documentId: 'confidential' },
  } })
  bridge.onCodexEvent('item/completed', { threadId: 'session-one', item: {
    id: 'call-one', type: 'mcpToolCall', server: 'external', tool: 'read_document',
  } })
  const [started, completed] = bridge.liveEvents.get('session-one').map(entry => entry.event)
  assert.equal(started.data.name, 'external.read_document')
  assert.equal(started.data.arguments, '{}')
  assert.equal(completed.data.message.source.callId, 'call-one')
})

test('Codex user input requests are answered through the Tandix question UI', () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  const browserFrames = []
  const codexFrames = []
  bridge.browser = { readyState: 1, send: raw => browserFrames.push(JSON.parse(raw)) }
  bridge.writeCodex = frame => codexFrames.push(frame)
  bridge.requestAgentApproval({ id: 42, method: 'item/tool/requestUserInput', params: {
    threadId: 'session-one', questions: [{ id: 'choice', header: 'Choose', question: 'Which option?',
      options: [{ label: 'First', description: 'First option' }], isSecret: false }],
  } })
  const requested = browserFrames.find(frame => frame.frame?.method === 'question/requested')
  assert.equal(requested.frame.payload.questions[0].id, 'choice')
  assert.equal(bridge.settleAgentQuestion(requested.frame.rpcId, { ok: true,
    value: { answer: { answers: [{ id: 'choice', selected: ['First'] }] } } }), true)
  assert.deepEqual(codexFrames, [{ id: 42, result: { answers: { choice: { answers: ['First'] } } } }])
  assert.equal(browserFrames.at(-1).frame.method, 'question/resolved')
})

test('MCP form elicitation returns structured answers to Codex', () => {
  const bridge = new CodexBridge(options)
  bridge.sessions.add('session-one')
  const browserFrames = []
  const codexFrames = []
  bridge.browser = { readyState: 1, send: raw => browserFrames.push(JSON.parse(raw)) }
  bridge.writeCodex = frame => codexFrames.push(frame)
  bridge.requestAgentApproval({ id: 43, method: 'mcpServer/elicitation/request', params: {
    threadId: 'session-one', serverName: 'external', mode: 'form', message: 'Choose a format',
    requestedSchema: { type: 'object', properties: {
      format: { type: 'string', enum: ['pdf', 'docx'] }, count: { type: 'integer' },
    }, required: ['format'] },
  } })
  const requested = browserFrames.find(frame => frame.frame?.method === 'question/requested')
  assert.equal(requested.frame.payload.questions[1].optional, true)
  bridge.settleAgentQuestion(requested.frame.rpcId, { ok: true,
    value: { answer: { answers: [{ id: 'format', selected: ['pdf'] }, { id: 'count', selected: [], custom: '2' }] } } })
  assert.deepEqual(codexFrames, [{ id: 43, result: {
    action: 'accept', content: { format: 'pdf', count: 2 }, _meta: null,
  } }])
})

test('Codex saves a pasted video inside the sandbox workspace with a safe name', () => {
  const bridge = new CodexBridge(options)
  const saved = bridge.savePromptFile({ name: '../clip.mp4', data: 'AQID' })

  assert.equal(saved.name, 'clip.mp4')
  assert.match(saved.path, /^\/tmp\/tandix-test-workspace\/workspace\/attachments\/[0-9a-f-]+\/clip\.mp4$/u)
  assert.deepEqual(readFileSync(saved.path), Buffer.from([1, 2, 3]))
})
