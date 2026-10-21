import assert from 'node:assert/strict'
import test from 'node:test'
import { acpConfiguration, acpControls, codexConfiguration } from '../runtime/agent-configuration.mjs'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CursorBridge } from '../runtime/cursor-bridge.mjs'
import { WorkBuddyBridge } from '../runtime/workbuddy-bridge.mjs'
import { CodexBridge } from '../runtime/codex-bridge.mjs'

const options = { workspace: '/tmp/tandix-config-tests', hostDir: '/tmp/tandix-unpersisted-config', extensionId: 'a'.repeat(32) }
test('ACP normalizes advertised model and reasoning fields, excluding credentials and unknown options', () => {
  const value = acpConfiguration('workbuddy', 's', { apiKey: 'private-value', configOptions: [null,
    { id: 'agent-model', category: 'model', currentValue: 'model-a', options: [{ group: 'Models', options: [{ value: 'model-a', name: 'Model A' }] }] },
    { id: 'thinking', category: 'thought_level', currentValue: 'high' },
    { id: 'api_key', currentValue: 'private-value' },
  ] })
  assert.equal(value.modelId, 'model-a'); assert.equal(value.modelLabel, 'Model A'); assert.equal(value.reasoningEffort, 'high')
  assert.equal(JSON.stringify(value).includes('private-value'), false)
})
test('Cursor auto reports the selected preset without guessing an execution model or parsing reasoning from a suffix', () => {
  const value = acpConfiguration('cursor', 's', { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'auto' }] } })
  assert.equal(value.modelLabel, 'auto'); assert.equal(value.reasoningEffort, null)
  assert.equal(acpConfiguration('cursor', 's', { modes: { currentModeId: 'default' } }).modelLabel, 'auto')
})
test('ACP configuration remains session-owned and distinguishes live from saved metadata', async () => {
  for (const Bridge of [CursorBridge, WorkBuddyBridge]) {
    const bridge = new Bridge(options); bridge.sessions.clear(); bridge.persist = () => {}
    bridge.sessions.set('one', { events: [], configuration: acpConfiguration(bridge.backend, 'one', { configOptions: [{ id: 'model', currentValue: 'one-model' }] }) })
    bridge.sessions.set('two', { events: [] })
    assert.equal((await bridge.rpc('agent.configuration', { sessionId: 'one' })).source, 'last-known')
    bridge.loaded.add('one')
    assert.equal((await bridge.rpc('agent.configuration', { sessionId: 'one' })).source, 'session')
    assert.equal((await bridge.rpc('agent.configuration', { sessionId: 'two' })).modelId, null)
    await assert.rejects(bridge.rpc('agent.configuration', { sessionId: 'foreign' }), /Unknown/u)
    bridge.update({ sessionId: 'one', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'new-model' }] } })
    assert.equal((await bridge.rpc('agent.configuration', { sessionId: 'one' })).modelId, 'new-model')
    assert.equal((await bridge.rpc('agent.configuration', { sessionId: 'two' })).modelId, null)
  }
})
test('Codex reads only owned thread metadata and returns only display-safe configuration', async () => {
  const bridge = new CodexBridge(options); bridge.sessions.clear(); bridge.sessions.add('owned'); bridge.loaded.add('owned')
  const calls = []
  bridge.call = async (method, params) => { calls.push([method, params]); return { thread: { model: 'session-model', modelProvider: 'provider', reasoningEffort: 'low', instructions: 'private' } } }
  const value = await bridge.rpc('agent.configuration', { sessionId: 'owned' })
  assert.equal(value.modelId, 'session-model'); assert.equal(value.reasoningEffort, 'low'); assert.equal(value.source, 'session')
  assert.deepEqual(calls[0], ['thread/read', { threadId: 'owned', includeTurns: false }])
  assert.equal(JSON.stringify(value).includes('private'), false)
  await assert.rejects(bridge.rpc('agent.configuration', { sessionId: 'foreign' }), /Unknown/u)
  bridge.call = async () => ({ config: { model: 'default-model', model_reasoning_effort: 'high', api_key: 'secret' } })
  const defaults = await bridge.rpc('agent.configuration', {})
  assert.equal(defaults.source, 'default'); assert.equal(defaults.modelId, 'default-model'); assert.equal(JSON.stringify(defaults).includes('secret'), false)
})
test('Codex does not forward arbitrary configuration keys', () => {
  const value = codexConfiguration('s', { model: 'm', reasoningEffort: 'high', apiKey: 'secret', sandbox: { type: 'workspaceWrite', writableRoots: ['/private'] } })
  assert.equal(value.sandbox, 'workspaceWrite'); assert.equal(JSON.stringify(value).includes('/private'), false)
})
test('an explicit unset Codex reasoning value clears an older selection', async () => {
  const bridge = new CodexBridge(options); bridge.sessions.clear(); bridge.sessions.add('s'); bridge.loaded.add('s')
  bridge.sessionConfigurations.set('s', { model: 'old', effort: 'high', reasoningEffort: 'high' })
  bridge.call = async () => ({ thread: { model: 'new', reasoningEffort: null } })
  const result = await bridge.rpc('agent.configuration', { sessionId: 's' })
  assert.equal(result.modelId, 'new'); assert.equal(result.reasoningEffort, null)
})
test('Codex settings notifications refresh only the owning Tandix session', () => {
  const bridge = new CodexBridge(options); bridge.sessions.clear(); bridge.sessions.add('s')
  const sent = []; bridge.browserSend = frame => sent.push(frame)
  bridge.onCodexEvent('thread/settings/updated', { threadId: 'foreign', threadSettings: { model: 'wrong' } })
  assert.equal(sent.length, 0)
  bridge.onCodexEvent('thread/settings/updated', { threadId: 's', threadSettings: { model: 'updated', effort: 'low' } })
  assert.equal(sent[0].frame.method, 'agent/configuration-changed'); assert.equal(sent[0].frame.payload.sessionId, 's')
  assert.equal(bridge.sessionConfigurations.get('s').model, 'updated')
})

test('Codex validates, persists and forwards chat model settings on the next turn', async () => {
  const hostDir = mkdtempSync(join(tmpdir(), 'tandix-model-test-'))
  try {
    writeFileSync(join(hostDir, 'codex-sessions.json'), JSON.stringify(['s']))
    const bridge = new CodexBridge({ ...options, hostDir }); bridge.loaded.add('s')
    const calls = []
    bridge.call = async (method, params) => {
      calls.push([method, params])
      if (method === 'model/list') return { data: [{ model: 'm', displayName: 'Model M', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }] }
      if (method === 'thread/read') return { thread: { model: 'old' } }
      return {}
    }
    await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 'foreign', model: 'm' }), /chat session/u)
    await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'm', reasoningEffort: 'invalid' }), /Unsupported/u)
    assert.equal(bridge.modelSelections.size, 0)
    const result = await bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'm', reasoningEffort: 'high', apiKey: 'ignore' })
    assert.equal(result.saved, true); assert.equal(result.source, 'next-turn')
    assert.deepEqual(JSON.parse(readFileSync(bridge.modelSelectionsPath, 'utf8')), { s: { model: 'm', effort: 'high' } })
    assert.equal((await bridge.rpc('agent.configuration', { sessionId: 's' })).modelId, 'm')
    await bridge.rpc('session.prompt', { sessionId: 's', content: [{ type: 'text', text: 'hello' }] })
    const turn = calls.find(([method]) => method === 'turn/start')[1]
    assert.equal(turn.model, 'm'); assert.equal(turn.effort, 'high'); assert.equal(turn.apiKey, undefined)
    assert.deepEqual(new CodexBridge({ ...options, hostDir }).modelSelections.get('s'), { model: 'm', effort: 'high' })
    bridge.turns.set('s', 'turn')
    await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'm' }), /current operation/u)
  } finally { rmSync(hostDir, { recursive: true, force: true }) }
})

const selectableOptions = (model = 'a', effort = 'low') => ({ configOptions: [
  { id: 'model', category: 'model', currentValue: model, options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B' }] },
  { id: 'thinking', category: 'thought_level', currentValue: effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
] })
test('ACP applies only advertised model and reasoning controls and refreshes confirmed metadata', async () => {
  const bridge = new WorkBuddyBridge(options); bridge.sessions.clear(); bridge.persist = () => {}
  bridge.sessions.set('s', { events: [], configuration: acpConfiguration('workbuddy', 's', selectableOptions()), controls: acpControls('workbuddy', selectableOptions()) })
  bridge.loaded.add('s')
  const calls = []
  bridge.call = async (method, params) => { calls.push([method, params]); return selectableOptions('b', params.configId === 'thinking' ? params.value : 'low') }
  await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'invented' }), /does not offer/u)
  assert.equal(calls.length, 0)
  const result = await bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'b', reasoningEffort: 'high' })
  assert.equal(result.modelId, 'b'); assert.equal(result.reasoningEffortId, 'high'); assert.equal(result.saved, true)
  assert.deepEqual(calls, [
    ['session/set_config_option', { sessionId: 's', configId: 'model', value: 'b' }],
    ['session/set_config_option', { sessionId: 's', configId: 'thinking', value: 'high' }],
  ])
  bridge.turns.add('s')
  await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'a' }), /current operation/u)
})
test('ACP retains accepted model changes when the reasoning request fails', async () => {
  const bridge = new WorkBuddyBridge(options); bridge.sessions.clear(); const persisted = []; bridge.persist = () => persisted.push(true)
  bridge.sessions.set('s', { events: [], configuration: acpConfiguration('workbuddy', 's', selectableOptions()), controls: acpControls('workbuddy', selectableOptions()) })
  bridge.loaded.add('s')
  bridge.call = async (_, params) => { if (params.configId === 'thinking') throw new Error('Runtime refused reasoning'); return selectableOptions('b') }
  await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'b', reasoningEffort: 'high' }), /Runtime refused/u)
  assert.equal((await bridge.rpc('agent.configuration', { sessionId: 's' })).modelId, 'b')
  assert.equal(persisted.length, 1); assert.equal(bridge.configurationChanges.size, 0)
})
test('Cursor maps advertised legacy presets to set_mode; unavailable controls remain read-only', async () => {
  const bridge = new CursorBridge(options); bridge.sessions.clear(); bridge.persist = () => {}
  const response = { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'auto' }, { id: 'model-b', name: 'Model B' }] } }
  bridge.sessions.set('s', { events: [], configuration: acpConfiguration('cursor', 's', response), controls: acpControls('cursor', response) })
  bridge.loaded.add('s')
  const calls = []; bridge.call = async (method, params) => { calls.push([method, params]); return {} }
  const result = await bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'model-b' })
  assert.equal(result.modelLabel, 'Model B')
  assert.deepEqual(calls, [['session/set_mode', { sessionId: 's', modeId: 'model-b' }]])
  bridge.sessions.get('s').controls = acpControls('cursor', {})
  await assert.rejects(bridge.rpc('agent.configuration.set', { sessionId: 's', model: 'model-b' }), /does not offer/u)
})
