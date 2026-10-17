import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebTaskStore } from '../runtime/web-task-store.mjs'
import { CodexBridge } from '../runtime/codex-bridge.mjs'
import { spawn } from 'node:child_process'

const origin = 'https://app.example'
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tandix-web-recovery-'))
  const calls = { creates: [], prompts: [], cancels: [], adopts: [] }
  let history = { id: 'turn-1', status: 'interrupted' }
  const stores = []
  const open = (extra = {}) => {
    const store = new WebTaskStore({ directory,
      createSession: async job => { calls.creates.push(job.taskId); return { sessionId: 'original-session' } },
      adoptSession: job => { calls.adopts.push(job.sessionId) },
      inspectSession: async () => history,
      startTurn: async (job, content) => {
        const persisted = JSON.parse(readFileSync(join(directory, job.taskId, 'task.json')))
        assert.equal(persisted.sessionId, 'original-session')
        calls.prompts.push({ sessionId: job.sessionId, content, attempt: job.attempt })
        return { turn: { id: `turn-${calls.prompts.length}` } }
      },
      cancelSession: async job => { calls.cancels.push(job.sessionId) }, ...extra,
    })
    stores.push(store); return store
  }
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }) })
  const request = { taskId: randomUUID(), origin, prompt: 'Grade the attached exam', files: [], responseFormat: 'text' }
  const emit = (store, type, data) => store.ingest({ t: 'event', frame: { method: 'session/event', payload: {
    sessionId: 'original-session', event: { type, data },
  } } })
  return { directory, calls, open, request, emit, history: value => { history = value } }
}

test('acceptance and task/session mapping are durable before prompting, with idempotent task IDs', async t => {
  const f = fixture(t); const store = f.open()
  await Promise.all([store.run(f.request), store.run(f.request)])
  await tick()
  assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.prompts.length, 1)
  const status = await store.get(origin, f.request.taskId)
  assert.equal(status.sessionId, 'original-session'); assert.equal(status.backend, 'codex')
  assert.equal(status.status, 'running')
  await assert.rejects(store.run({ ...f.request, prompt: 'Different exam' }), { code: 'task-conflict' })
  await assert.rejects(store.get('https://other.example', f.request.taskId), { code: 'unknown-task' })
  await assert.rejects(store.cancel('https://other.example', f.request.taskId), { code: 'unknown-task' })
})

test('an absent webpage does not affect completion; new observers replay progress and read the same result', async t => {
  const f = fixture(t); const store = f.open(); await store.run(f.request); await tick()
  f.emit(store, 'assistant/message', { message: { content: [{ type: 'text', text: 'Score: 95' }] } })
  f.emit(store, 'turn/end', { status: 'completed' })
  const original = await store.get(origin, f.request.taskId)
  store.close()
  const restored = await f.open().get(origin, f.request.taskId, original.events[0].seq)
  assert.deepEqual(restored.result, { taskId: f.request.taskId, text: 'Score: 95' })
  assert.ok(restored.events.every(event => event.seq > original.events[0].seq))
  assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.prompts.length, 1)
  assert.equal(f.calls.cancels.length, 0)
})

test('repeated interruptions resume the same session with increasing attempts and idempotent continuation IDs', async t => {
  const f = fixture(t); const first = f.open(); await first.run(f.request); await tick()
  first.close()
  const second = f.open()
  const interrupted = await second.get(origin, f.request.taskId)
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.resumable, true)
  assert.equal(f.calls.prompts.length, 1)
  const resume = { taskId: f.request.taskId, origin, requestId: randomUUID(), prompt: 'Continue the remaining pages' }
  await Promise.all([second.resume(resume), second.resume(resume)])
  await tick()
  assert.equal(f.calls.prompts.length, 2); assert.equal(f.calls.creates.length, 1)
  assert.equal(f.calls.prompts[1].sessionId, 'original-session')
  assert.deepEqual(f.calls.prompts[1].content, [{ type: 'text', text: resume.prompt }])
  await assert.rejects(second.resume({ ...resume, prompt: 'Change original instructions' }), { code: 'task-conflict' })
  f.emit(second, 'turn/end', { status: 'failed', error: 'Network unavailable' })
  f.history({ id: 'turn-2', status: 'failed' })
  await second.resume({ ...resume, requestId: randomUUID() }); await tick()
  const current = await second.get(origin, f.request.taskId)
  assert.equal(current.attempt, 3); assert.equal(current.sessionId, 'original-session')
  assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.prompts.length, 3)
})

test('lost completion is reconciled from original thread history without starting another turn', async t => {
  const f = fixture(t); const first = f.open(); await first.run(f.request); await tick(); first.close()
  f.history({ id: 'turn-1', status: 'completed', text: 'Already graded' })
  const second = f.open()
  assert.equal((await second.get(origin, f.request.taskId)).result.text, 'Already graded')
  const result = await second.resume({ origin, taskId: f.request.taskId, requestId: randomUUID() })
  assert.equal(result.status, 'completed'); assert.equal(f.calls.prompts.length, 1)
})

test('a running original turn is never automatically resubmitted or resumed', async t => {
  const f = fixture(t); const first = f.open(); await first.run(f.request); await tick(); first.close()
  f.history({ id: 'turn-1', status: 'inProgress' })
  const second = f.open(); await second.get(origin, f.request.taskId)
  await assert.rejects(second.resume({ origin, taskId: f.request.taskId, requestId: randomUUID() }), { code: 'task-busy' })
  assert.equal(f.calls.prompts.length, 1)
})

test('unknown session creation outcome remains interrupted instead of creating a duplicate session', async t => {
  const f = fixture(t)
  const first = f.open({ createSession: () => new Promise(() => {}) })
  await first.run(f.request); first.close()
  const second = f.open()
  assert.equal((await second.get(origin, f.request.taskId)).sessionId, null)
  await assert.rejects(second.resume({ origin, taskId: f.request.taskId, requestId: randomUUID() }), { code: 'session-unavailable' })
  assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.prompts.length, 0)
})

test('cancel during session creation cannot be overwritten by a delayed creation response', async t => {
  const f = fixture(t); let finish
  const store = f.open({ createSession: () => new Promise(resolve => { finish = resolve }) })
  await store.run(f.request); await store.cancel(origin, f.request.taskId)
  finish({ sessionId: 'original-session' }); await tick()
  assert.equal((await store.get(origin, f.request.taskId)).status, 'cancelled')
  assert.equal(f.calls.prompts.length, 0); assert.deepEqual(f.calls.cancels, ['original-session'])
})

test('cancellation between mapping and prompt dispatch cannot start a model turn', async t => {
  const f = fixture(t); let release; let adopts = 0
  const store = f.open({ adoptSession: () => ++adopts === 1 ? new Promise(resolve => { release = resolve }) : undefined })
  await store.run(f.request); await tick()
  assert.equal(typeof release, 'function')
  await store.cancel(origin, f.request.taskId); release(); await tick()
  assert.equal((await store.get(origin, f.request.taskId)).status, 'cancelled')
  assert.equal(f.calls.prompts.length, 0)
})

test('recovery never silently switches the original agent profile', async t => {
  const f = fixture(t); const first = f.open({ agentId: 'original-profile' })
  await first.run(f.request); await tick(); first.close()
  const other = f.open({ agentId: 'different-profile' })
  await assert.rejects(other.get(origin, f.request.taskId), { code: 'agent-mismatch' })
  await assert.rejects(other.resume({ origin, taskId: f.request.taskId, requestId: randomUUID() }), { code: 'agent-mismatch' })
  assert.equal(f.calls.prompts.length, 1)
})

test('clarification survives cancellation and restart, then continues in the same session', async t => {
  const f = fixture(t); const first = f.open(); await first.run(f.request); await tick()
  first.ingest({ t: 'event', frame: { method: 'question/requested', payload: { sessionId: 'original-session',
    questions: [{ question: 'Which rubric?' }, { question: 'Secret value', secret: true }] } } })
  f.emit(first, 'turn/end', { status: 'interrupted' }); first.close()
  f.history({ id: 'turn-1', status: 'completed', text: 'Please supply the rubric.' })
  const second = f.open()
  const status = await second.get(origin, f.request.taskId)
  assert.equal(status.status, 'interrupted'); assert.equal(status.result, undefined)
  await second.resume({ origin, taskId: f.request.taskId, requestId: randomUUID(), prompt: 'Use the supplied school rubric.' }); await tick()
  assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.prompts.length, 2)
  assert.equal(f.calls.prompts[1].content[0].text, 'Use the supplied school rubric.')
  assert.ok(!JSON.stringify(status).includes('Secret value'))
})

test('two companion processes cannot create two sessions for the same task ID', async t => {
  const f = fixture(t)
  const moduleUrl = new URL('../runtime/web-task-store.mjs', import.meta.url).href
  const program = `import {WebTaskStore} from ${JSON.stringify(moduleUrl)};
    import {appendFileSync} from 'node:fs';
    const directory=process.argv[1], request=JSON.parse(process.argv[2]);
    const store=new WebTaskStore({directory,createSession:async()=>{appendFileSync(directory+'/calls.log','create\\n');return {sessionId:'only-session'}},
      adoptSession:()=>{},inspectSession:async()=>null,startTurn:async()=>{appendFileSync(directory+'/calls.log','prompt\\n');return {}},cancelSession:async()=>{}});
    try {await store.run(request)} catch(error) {if(error.code!=='task-busy')throw error}
    await new Promise(resolve=>setTimeout(resolve,100));store.close();`
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.directory, JSON.stringify(f.request)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''; child.stderr.on('data', data => { error += data }); child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))
  })
  await Promise.all([run(), run()])
  assert.deepEqual(readFileSync(join(f.directory, 'calls.log'), 'utf8').trim().split('\n'), ['create', 'prompt'])
})

test('restoring a web session preserves its task sandbox and disabled browser tools across installation paths', async t => {
  const f = fixture(t)
  const bridge = new CodexBridge({ workspace: join(f.directory, 'new-install'), hostDir: f.directory,
    webTaskDirectory: f.directory, extensionId: 'test', nodePath: process.execPath })
  const calls = []
  bridge.call = async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'thread/start') return { thread: { id: 'original-session' } }
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-1', status: 'interrupted', items: [] }] } }
    return { turn: { id: 'turn-1' } }
  }
  await bridge.rpc('web.tasks.run', { ...f.request, files: [{ name: 'exam.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') }] })
  await tick(); bridge.webTasks.close()
  const restored = new CodexBridge({ workspace: join(f.directory, 'another-install'), hostDir: f.directory,
    webTaskDirectory: f.directory, extensionId: 'test', nodePath: process.execPath })
  restored.call = bridge.call
  await restored.rpc('web.tasks.resume', { origin, taskId: f.request.taskId, requestId: randomUUID() }); await tick()
  const resume = calls.find(call => call.method === 'thread/resume')
  assert.equal(resume.payload.threadId, 'original-session')
  assert.equal(resume.payload.excludeTurns, true)
  assert.equal(resume.payload.config.mcp_servers.tandix.enabled, false)
  assert.equal(resume.payload.cwd, join(f.directory, f.request.taskId, 'work'))
  assert.deepEqual(resume.payload.config.sandbox_workspace_write.writable_roots, [resume.payload.cwd])
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1)
  const finalPrompt = calls.filter(call => call.method === 'turn/start').at(-1).payload
  assert.equal(finalPrompt.input.length, 1)
  assert.equal(finalPrompt.sandboxPolicy.writableRoots[0], resume.payload.cwd)
  restored.webTasks.close()
})

test('modern Codex pagination recovers the final answer without concatenating commentary', async t => {
  const f = fixture(t)
  const bridge = new CodexBridge({ workspace: f.directory, hostDir: f.directory, webTaskDirectory: f.directory, extensionId: 'test' })
  const calls = []
  bridge.call = async (method, params) => {
    calls.push({ method, params })
    assert.equal(method, 'thread/turns/list')
    return { data: [{ id: 'turn-last', status: 'completed', items: [
      { type: 'agentMessage', text: 'Checking the remaining pages…' },
      { type: 'agentMessage', text: '{"score":95}' },
    ] }] }
  }
  const turn = await bridge.inspectWebTaskTurn('original-session')
  assert.deepEqual(turn, { id: 'turn-last', status: 'completed', text: '{"score":95}' })
  assert.deepEqual(calls[0].params, { threadId: 'original-session', limit: 1, sortDirection: 'desc', itemsView: 'full' })
  bridge.webTasks.close()
})

test('legacy Codex history is supported without creating a replacement session', async t => {
  const f = fixture(t)
  const bridge = new CodexBridge({ workspace: f.directory, hostDir: f.directory, webTaskDirectory: f.directory, extensionId: 'test' })
  bridge.call = async method => {
    if (method === 'thread/turns/list') throw new Error('Unknown method')
    assert.equal(method, 'thread/read')
    return { thread: { turns: [{ id: 'legacy-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Existing result' }] }] } }
  }
  assert.equal((await bridge.inspectWebTaskTurn('original-session')).text, 'Existing result')
  bridge.webTasks.close()
})
