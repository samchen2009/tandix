import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSkillsRequest } from '../runtime/skills-store.mjs'
import { fileURLToPath } from 'node:url'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tandix-skills-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, call: request => handleSkillsRequest({ collection: 'managed', ...request }, { directory }) }
}
function managed(id, extra = {}) {
  return { id, name: id, description: '用途', instructions: '核对资料。', sourceSessionId: 's', createdAt: 1, updatedAt: 2, ...extra }
}
function chat(id) {
  return { id, name: id, schemaVersion: 'tandix.agent-skill/v1', version: 1, goal: '检查', success: '完成',
    steps: ['核对'], parameters: [], allowedOrigins: [], sourceSessionId: 's', createdAt: 1 }
}

test('migration merges two installations without overwriting native edits', async t => {
  const { call } = fixture(t)
  await call({ action: 'import', skills: [managed('old')] })
  const original = await call({ action: 'list' })
  await call({ action: 'upsert', skill: managed('old', { instructions: '更新后的指令' }) })
  // An old copy and a different extension ID's empty cache must not replace the library.
  await call({ action: 'import', skills: [managed('old'), managed('other')] })
  await call({ action: 'import', skills: [] })
  const moved = await call({ action: 'list' })
  assert.equal(moved.storeId, original.storeId)
  assert.equal(moved.skills.length, 2)
  assert.equal(moved.skills.find(skill => skill.id === 'old').instructions, '更新后的指令')
})

test('deletions survive migration from an old extension cache', async t => {
  const { call } = fixture(t)
  const skill = chat('deleted')
  await call({ collection: 'chat', action: 'import', skills: [skill] })
  await call({ collection: 'chat', action: 'delete', id: skill.id })
  await call({ collection: 'chat', action: 'import', skills: [skill] })
  assert.deepEqual((await call({ collection: 'chat', action: 'list' })).skills, [])
  // A deliberate user save may restore it.
  await call({ collection: 'chat', action: 'upsert', skill })
  assert.equal((await call({ collection: 'chat', action: 'list' })).skills.length, 1)
})

test('concurrent processes preserve all skills and deduplicate managed names', async t => {
  const { call, directory } = fixture(t)
  const moduleUrl = new URL('../runtime/skills-store.mjs', import.meta.url).href
  const save = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {handleSkillsRequest} from ${JSON.stringify(moduleUrl)};
       await handleSkillsRequest(JSON.parse(process.argv[1]), {directory:process.argv[2]});`,
      JSON.stringify({ collection: 'managed', action: 'upsert', skill: managed(id) }), directory], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', data => { error += data })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))
  })
  await Promise.all(Array.from({ length: 8 }, (_, index) => save(`skill-${index}`)))
  assert.equal((await call({ action: 'list' })).skills.length, 8)
  const result = await call({ action: 'upsert', skill: managed('new-id', { name: 'SKILL-1', createdAt: 5 }) })
  assert.equal(result.skill.id, 'skill-1')
  assert.equal(result.skill.createdAt, 1)
  assert.equal((await call({ action: 'list' })).skills.length, 8)
})

test('large multilingual libraries use bounded consistent native-message pages', async t => {
  const { call } = fixture(t)
  await call({ action: 'import', skills: Array.from({ length: 100 }, (_, index) => managed(String(index), { instructions: '中'.repeat(30_000) })) })
  let page = await call({ action: 'list' })
  let count = page.skills.length
  const revision = page.revision
  while (page.next !== null) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024)
    page = await call({ action: 'list', offset: page.next, revision })
    count += page.skills.length
  }
  assert.equal(count, 100)
  await call({ action: 'upsert', skill: managed('0') })
  await assert.rejects(call({ action: 'list', offset: 4, revision }), /changed during reading/)
})

test('invalid writes and corrupt files preserve the library and backup', async t => {
  const { call, directory } = fixture(t)
  await call({ action: 'upsert', skill: managed('one') })
  const path = join(directory, 'library.json')
  const previous = readFileSync(path, 'utf8')
  await assert.rejects(call({ action: 'upsert', skill: managed('bad', { instructions: '' }) }), /Invalid skill/)
  assert.equal(readFileSync(path, 'utf8'), previous)
  await call({ action: 'upsert', skill: managed('two') })
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), previous)
  writeFileSync(path, '{broken')
  await assert.rejects(call({ action: 'list' }), /Original data was preserved/)
  assert.equal(readFileSync(path, 'utf8'), '{broken')
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), previous)
  await assert.rejects(call({ collection: '../escape', action: 'list' }), /Unsupported/)
})

test('native messaging persists skills without an installation config or agent process', async t => {
  const { directory } = fixture(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/native-host.mjs', import.meta.url))], {
    env: { ...process.env, HOME: directory, USERPROFILE: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  let buffer = Buffer.alloc(0)
  const replies = []
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => { if (replies.length !== 2) reject(new Error(`Native host exited: ${code}`)) })
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0)
        replies.push(JSON.parse(buffer.subarray(4, 4 + length)))
        buffer = buffer.subarray(4 + length)
        if (replies.length === 1) send({ type: 'skills', collection: 'managed', action: 'list' })
        if (replies.length === 2) resolve()
      }
    })
  })
  function send(message) {
    const payload = Buffer.from(JSON.stringify(message))
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length)
    child.stdin.write(Buffer.concat([header, payload]))
  }
  send({ type: 'skills', collection: 'managed', action: 'upsert', skill: managed('native') })
  await done
  assert.equal(replies[0].ok, true)
  assert.deepEqual(replies[1].skills, [managed('native')])
  assert.equal(JSON.parse(readFileSync(join(directory, '.tandix', 'skills', 'library.json'))).managed.length, 1)
  child.stdin.end()
})
