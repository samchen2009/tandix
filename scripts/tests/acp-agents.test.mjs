import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACP_AGENTS, acpAgentPaths, findAcpAgent, isAdditionalAcpAgent } from '../runtime/acp-agents.mjs'
import { ExtraAcpBridge } from '../runtime/extra-acp-bridge.mjs'
import { acpConfiguration, acpControls } from '../runtime/agent-configuration.mjs'

test('only fixed agent IDs are accepted and credential values are not saved', () => {
  for (const id of ['__proto__', 'constructor', 'auto', '', undefined]) {
    assert.equal(isAdditionalAcpAgent(id), false)
    assert.throws(() => findAcpAgent(id), /Unsupported/)
  }
  assert.deepEqual(acpAgentPaths({ KIMI_AGENT_PATH: '/local/kimi', API_KEY: 'secret' }), { kimi: '/local/kimi' })
  assert.deepEqual(Object.keys(ACP_AGENTS), ['kimi', 'qwen', 'opencode', 'gemini'])
})

test('OpenCode chats use separate working directories and retain their own MCP routes on resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tandix-opencode-isolation-'))
  const options = { backend: 'opencode', workspace: root, hostDir: join(root, 'state'),
    runtimePath: new URL('../../package.json', import.meta.url).pathname, extensionId: 'a'.repeat(32) }
  const bridge = new ExtraAcpBridge(options)
  const calls = []
  bridge.agentCapabilities = { loadSession: true }
  bridge.call = async (method, params) => { calls.push({ method, params }); return method === 'session/new' ? { sessionId: `s${calls.length}` } : {} }
  try {
    const one = await bridge.rpc('session.create', {})
    const two = await bridge.rpc('session.create', {})
    assert.notEqual(calls[0].params.cwd, calls[1].params.cwd)
    assert.notEqual(calls[0].params.mcpServers[0].args[2], calls[1].params.mcpServers[0].args[2])
    const resumed = new ExtraAcpBridge(options)
    resumed.agentCapabilities = { loadSession: true }
    resumed.call = bridge.call
    await resumed.load(one.sessionId)
    assert.equal(calls[2].params.cwd, calls[0].params.cwd)
    assert.notEqual(resumed.sessionCwd(resumed.session(two.sessionId)), calls[2].params.cwd)
    assert.throws(() => resumed.sessionCwd({ workspaceId: '../../foreign' }), /Invalid/)
    resumed.close()
  } finally { bridge.close(); rmSync(root, { recursive: true, force: true }) }
})

test('Gemini legacy model selection uses model IDs and never confuses approval modes with models', async () => {
  const bridge = new ExtraAcpBridge({ backend: 'gemini', workspace: '/tmp', hostDir: '/tmp/tandix-unpersisted-gemini-config' })
  bridge.sessions.clear(); bridge.persist = () => {}
  const response = { models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'Model A' }, { modelId: 'b', name: 'Model B' }] },
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Ask permissions' }] } }
  bridge.sessions.set('owned', { events: [], configuration: acpConfiguration('gemini', 'owned', response), controls: acpControls('gemini', response) })
  bridge.loaded.add('owned')
  const calls = []; bridge.call = async (method, params) => { calls.push({ method, params }); return {} }
  assert.equal((await bridge.rpc('agent.configuration', { sessionId: 'owned' })).modelLabel, 'Model A')
  await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 'owned', model: 'default' }), /does not offer/)
  const selected = await bridge.rpc('agent.configuration.set', { sessionId: 'owned', model: 'b' })
  assert.deepEqual(calls, [{ method: 'session/set_model', params: { sessionId: 'owned', modelId: 'b' } }])
  assert.equal(selected.modelLabel, 'Model B')
  bridge.close()
})
