import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTO_AGENT_PRIORITY, selectAutomaticAgent } from '../runtime/native-host.mjs'

for (const selected of ['codex', 'cursor', 'workbuddy', 'dsh']) {
  test(`auto chooses ${selected} only after higher-priority agents fail`, async () => {
    const attempts = []
    const failures = []
    const result = await selectAutomaticAgent(async backend => {
      attempts.push(backend)
      if (backend !== selected) throw new Error(`${backend} is not signed in`)
      return `ws://127.0.0.1/${backend}`
    }, (backend, detail) => failures.push({ backend, detail }))
    const expected = ['codex', 'cursor', 'workbuddy', 'dsh'].slice(0, ['codex', 'cursor', 'workbuddy', 'dsh'].indexOf(selected) + 1)
    assert.deepEqual(attempts, expected)
    assert.deepEqual(failures.map(entry => entry.backend), expected.slice(0, -1))
    assert.deepEqual(result, { backend: selected, url: `ws://127.0.0.1/${selected}` })
  })
}

test('auto reports every failed agent when none can connect', async () => {
  const attempts = []
  await assert.rejects(selectAutomaticAgent(async backend => {
    attempts.push(backend)
    throw new Error(`failure-${backend}`)
  }), error => {
    for (const backend of AUTO_AGENT_PRIORITY) assert.ok(error.message.includes(`failure-${backend}`))
    return true
  })
  assert.deepEqual(attempts, ['codex', 'cursor', 'workbuddy', 'dsh'])
})
