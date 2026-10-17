// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { File as NodeFile } from 'node:buffer'
import { WebApiServer, type WebApiDeps } from '../src/background/web-api.ts'
import { TandixClient } from '../src/web-api/client.ts'
import { WEB_API_PORT, WEB_DISCOVERY_REQUEST, WEB_DISCOVERY_RESPONSE, WEB_LIMITS } from '../src/web-api/protocol.ts'
import { installWebDiscovery } from '../src/content/web-discovery.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error The real companion is a JavaScript runtime module.
import { WebTaskStore } from '../../../scripts/runtime/web-task-store.mjs'

function channel<T extends unknown[]>() {
  const listeners: Array<(...args: T) => void> = []
  return { addListener: (listener: (...args: T) => void) => listeners.push(listener),
    emit: (...args: T) => listeners.forEach(listener => listener(...args)) }
}
const cleanup: Array<() => void> = []
function harness(options: { allowed?: boolean; backend?: string; sender?: object } = {}) {
  const incoming = channel<[unknown]>()
  const outgoing = channel<[unknown]>()
  const disconnected = channel<[]>()
  let closed = false
  const close = vi.fn(() => { if (!closed) { closed = true; disconnected.emit() } })
  const port = { name: WEB_API_PORT, sender: { url: 'https://app.example/work', tab: { id: 12 }, frameId: 0, ...options.sender },
    onMessage: incoming, onDisconnect: disconnected, postMessage: vi.fn((value: unknown) => outgoing.emit(value)), disconnect: close } as unknown as chrome.runtime.Port
  const page = { onMessage: outgoing, onDisconnect: disconnected, postMessage: (value: unknown) => incoming.emit(value), disconnect: close } as unknown as chrome.runtime.Port
  let sequence = 0
  const directory = mkdtempSync(join(tmpdir(), 'tandix-web-wire-'))
  let store: any
  const deps: WebApiDeps = {
    allowed: vi.fn(async () => options.allowed ?? true), authorize: vi.fn(async () => true),
    acquire: vi.fn(async () => options.backend ?? 'codex'), release: vi.fn(),
    rpc: vi.fn(async (method, payload: any) => {
      if (method === 'web.tasks.run') return store.run(payload)
      if (method === 'web.tasks.get') return store.get(payload.origin, payload.taskId, payload.afterSeq)
      if (method === 'web.tasks.resume') return store.resume(payload)
      if (method === 'web.tasks.cancel') return store.cancel(payload.origin, payload.taskId)
      return method === 'session.create' ? { sessionId: `session-${++sequence}` } : {}
    }),
  }
  store = new WebTaskStore({ directory,
    createSession: (job: any) => deps.rpc('session.create', { webTaskId: job.taskId }), adoptSession: () => {},
    inspectSession: async () => ({ id: 'turn-1', status: 'interrupted' }),
    startTurn: (job: any, content: any) => deps.rpc('session.prompt', { sessionId: job.sessionId, content }),
    cancelSession: (job: any) => deps.rpc('session.cancel', { sessionId: job.sessionId }),
  })
  const server = new WebApiServer(deps)
  server.connect(port)
  cleanup.push(() => { server.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  let id = 0
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve) => {
    const requestId = String(++id)
    outgoing.addListener((message: any) => { if (message.id === requestId) resolve(message) })
    incoming.emit({ id: requestId, method, params })
  })
  const emit = (sessionId: string, type: string, data: unknown) => store.ingest({ t: 'event',
    frame: { rpcId: '', method: 'session/event', payload: { sessionId, event: { type, data } } } } as ServerFrame)
  const taskParams = () => ({ taskId: crypto.randomUUID(), prompt: 'Read the files', fileIds: [], responseFormat: 'text' })
  return { server, store, deps, port, page, request, emit, taskParams, close }
}
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('automatic Tandix discovery', () => {
  const extensionId = 'a'.repeat(32)
  function pageTransport() {
    vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
      queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: window.location.origin })))
    })
  }
  it('discovers the extension and verifies hello without prompts, stored IDs or agent startup', async () => {
    const h = harness({ sender: { url: window.location.href } })
    const connect = vi.fn(() => h.page)
    vi.stubGlobal('chrome', { runtime: { connect } })
    pageTransport()
    cleanup.push(installWebDiscovery(window, () => ({ extensionId, extensionVersion: '0.1.4' })))
    const client = await TandixClient.discover()
    cleanup.push(() => client.close())
    expect(connect).toHaveBeenCalledWith(extensionId, { name: WEB_API_PORT })
    expect(h.deps.authorize).not.toHaveBeenCalled()
    expect(h.deps.acquire).not.toHaveBeenCalled()
    expect((await client.hello()).product).toBe('tandix')
  })
  it('retries discovery when the page SDK starts before the content script', async () => {
    vi.useFakeTimers()
    const h = harness({ sender: { url: window.location.href } })
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => h.page) } })
    pageTransport()
    const pending = TandixClient.discover({ timeoutMs: 2000 })
    await vi.advanceTimersByTimeAsync(500)
    cleanup.push(installWebDiscovery(window, () => ({ extensionId, extensionVersion: '0.1.4' })))
    await vi.advanceTimersByTimeAsync(300)
    const client = await pending; cleanup.push(() => client.close())
    expect((await client.hello()).version).toBe(1)
  })
  it('does not reveal identity to another origin or another frame and disposes stale listeners', () => {
    const identity = vi.fn(() => ({ extensionId, extensionVersion: '0.1.4' }))
    const dispose = installWebDiscovery(window, identity)
    const data = { type: WEB_DISCOVERY_REQUEST, requestId: crypto.randomUUID() }
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: 'https://different.example' }))
    window.dispatchEvent(new MessageEvent('message', { data, source: null, origin: window.location.origin }))
    expect(identity).not.toHaveBeenCalled()
    window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: window.location.origin }))
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: WEB_DISCOVERY_RESPONSE, extensionId }), window.location.origin)
    dispose(); identity.mockClear()
    window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: window.location.origin }))
    expect(identity).not.toHaveBeenCalled()
  })
  it('ignores unsolicited, wrong-version and cross-origin responses', async () => {
    vi.useFakeTimers()
    const connect = vi.fn()
    vi.stubGlobal('chrome', { runtime: { connect } })
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const pending = TandixClient.discover({ timeoutMs: 100 })
    const request = post.mock.calls[0]![0]
    const info = { type: WEB_DISCOVERY_RESPONSE, requestId: request.requestId, product: 'tandix', version: 1, extensionId }
    for (const [data, origin] of [[{ ...info, requestId: crypto.randomUUID() }, window.location.origin],
      [{ ...info, version: 2 }, window.location.origin], [info, 'https://different.example']] as const) {
      window.dispatchEvent(new MessageEvent('message', { data, source: window, origin }))
    }
    const rejected = expect(pending).rejects.toMatchObject({ code: 'discovery-timeout' })
    await vi.advanceTimersByTimeAsync(101); await rejected
    expect(connect).not.toHaveBeenCalled()
  })
  it('requires an actual compatible extension handshake before accepting a discovery hint', async () => {
    vi.useFakeTimers()
    const incoming = channel<[unknown]>()
    const disconnected = channel<[]>()
    const close = vi.fn()
    const port = { onMessage: incoming, onDisconnect: disconnected, disconnect: close,
      postMessage: (message: any) => incoming.emit({ id: message.id, ok: true, result: { product: 'other', version: 1, origin: window.location.origin } }) }
    vi.stubGlobal('chrome', { runtime: { connect: () => port } })
    pageTransport()
    cleanup.push(installWebDiscovery(window, () => ({ extensionId, extensionVersion: '0.1.4' })))
    const rejected = expect(TandixClient.discover({ timeoutMs: 100 })).rejects.toMatchObject({ code: 'discovery-timeout' })
    await vi.advanceTimersByTimeAsync(101); await rejected
    expect(close).toHaveBeenCalled()
  })
  it('rejects file URLs immediately instead of waiting for an extension timeout', async () => {
    const fileWindow = { location: new URL('file:///tmp/index.html'), top: null as unknown }
    fileWindow.top = fileWindow
    vi.stubGlobal('window', fileWindow)
    await expect(TandixClient.discover()).rejects.toMatchObject({ code: 'unsupported-page' })
  })
})

describe('webpage task boundary', () => {
  it('returns the same accepted task when the same uploaded submission is acknowledged twice', async () => {
    const h = harness(); const data = btoa('%PDF-1.7\n')
    const { fileId } = (await h.request('files.begin', { name: 'exam.pdf', mediaType: 'application/pdf', bytes: atob(data).length })).result
    await h.request('files.chunk', { fileId, offset: 0, data })
    const job = { ...h.taskParams(), fileIds: [fileId] }
    expect(await h.request('tasks.run', job)).toMatchObject({ ok: true })
    const repeated = await h.request('tasks.run', job)
    expect(repeated).toMatchObject({ ok: true, result: { taskId: job.taskId } })
    await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
    expect(vi.mocked(h.deps.rpc).mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(1)
  })
  it('keeps accepted work alive across page disconnect and allows a new same-origin observer', async () => {
    const first = harness(); const job = first.taskParams()
    await first.request('tasks.run', job)
    await vi.waitFor(() => expect(first.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
    first.close()
    expect(first.deps.rpc).not.toHaveBeenCalledWith('session.cancel', expect.anything())
    first.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'Already graded' }] } })
    first.emit('session-1', 'turn/end', { status: 'completed' })
    const replacement = harness()
    vi.mocked(replacement.deps.rpc).mockImplementation(first.deps.rpc)
    const recovered = (await replacement.request('tasks.attach', { taskId: job.taskId })).result
    expect(recovered).toMatchObject({ taskId: job.taskId, backend: 'codex', sessionId: 'session-1', result: { text: 'Already graded' } })
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(1)
  })
  it('does not allow another origin to query, cancel or resume a task by guessing its ID', async () => {
    const first = harness(); const job = first.taskParams(); await first.request('tasks.run', job)
    const other = harness({ sender: { url: 'https://other.example/task' } })
    vi.mocked(other.deps.rpc).mockImplementation(first.deps.rpc)
    for (const method of ['tasks.get', 'tasks.attach', 'tasks.cancel', 'tasks.resume']) {
      const reply = await other.request(method, { taskId: job.taskId, origin: 'https://app.example', requestId: crypto.randomUUID() })
      expect(reply.error.code).toBe('unknown-task')
      expect(JSON.stringify(reply)).not.toContain('session-1')
    }
  })
  it.each([{ frameId: 1 }, { url: 'http://untrusted.example' }, { id: 'another-extension' }])('rejects non-page/iframe senders %j', sender => {
    const h = harness({ sender }); expect(h.close).toHaveBeenCalled(); expect(h.deps.acquire).not.toHaveBeenCalled()
  })
  it('reports discovery without starting an agent and refuses unauthorized mutations', async () => {
    const h = harness({ allowed: false })
    expect((await h.request('hello')).result).toMatchObject({ version: 1, authorized: false })
    expect((await h.request('tasks.run', h.taskParams())).error.code).toBe('authorization-required')
    expect(h.deps.acquire).not.toHaveBeenCalled()
  })
  it('does not expose raw gateway methods', async () => {
    const h = harness()
    expect((await h.request('codex.mcp.add', { command: 'arbitrary' })).error.code).toBe('unknown-method')
    expect(h.deps.rpc).not.toHaveBeenCalled()
  })
  it('rejects wrong offsets, invalid base64, MIME mismatches, and incomplete files', async () => {
    const h = harness()
    const { fileId } = (await h.request('files.begin', { name: 'a.pdf', mediaType: 'application/pdf', bytes: 6 })).result
    expect((await h.request('files.chunk', { fileId, offset: 1, data: btoa('%PDF-1') })).error.code).toBe('invalid-chunk')
    expect((await h.request('files.chunk', { fileId, offset: 0, data: '!!!!' })).error.code).toBe('invalid-chunk')
    expect((await h.request('tasks.run', { ...h.taskParams(), fileIds: [fileId] })).error.code).toBe('incomplete-upload')
    await h.request('files.chunk', { fileId, offset: 0, data: btoa('broken') })
    expect((await h.request('tasks.run', { ...h.taskParams(), fileIds: [fileId] })).error.code).toBe('invalid-file')
    expect(h.deps.acquire).not.toHaveBeenCalled()
  })
  it('returns only the owning task final JSON and treats failed turns as failures', async () => {
    const h = harness()
    const job = h.taskParams()
    await h.request('tasks.run', { ...job, responseFormat: 'json' })
    await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
    h.emit('unrelated-session', 'assistant/message', { message: { content: [{ type: 'text', text: 'secret' }] } })
    h.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: '{"count":2}' }] } })
    h.emit('session-1', 'turn/end', { status: 'completed' })
    expect((await h.request('tasks.get', { taskId: job.taskId })).result).toMatchObject({ status: 'completed', result: { taskId: job.taskId, text: '{"count":2}', data: { count: 2 } } })
    expect(JSON.stringify(vi.mocked(h.port.postMessage).mock.calls)).not.toContain('secret')
    expect(h.deps.release).toHaveBeenCalledTimes(1)
    const second = h.taskParams()
    await h.request('tasks.run', second)
    await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-2' })))
    h.emit('session-2', 'turn/end', { status: 'failed', error: 'Model failed' })
    expect((await h.request('tasks.get', { taskId: second.taskId })).result).toMatchObject({ status: 'interrupted', error: { code: 'interrupted', message: 'Model failed' } })
  })
  it('cancels owned tasks on explicit cancellation and grant revocation', async () => {
    for (const action of ['cancel', 'revoke']) {
      const h = harness(); const job = h.taskParams()
      await h.request('tasks.run', job)
      await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
      if (action === 'cancel') await h.request('tasks.cancel', { taskId: job.taskId })
      else h.server.revoke('https://app.example')
      await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.cancel', { sessionId: 'session-1' }))
      await vi.waitFor(() => expect(h.deps.release).toHaveBeenCalledTimes(1))
    }
  })
  it('fails unsupported backends and malformed JSON without reporting success', async () => {
    const h = harness({ backend: 'workbuddy' }); await h.request('tasks.run', h.taskParams())
    expect((await h.request('tasks.run', h.taskParams())).error.code).toBe('unsupported-backend')
    expect(h.deps.rpc).not.toHaveBeenCalled()
    const second = harness(); await second.request('tasks.run', { ...second.taskParams(), responseFormat: 'json' })
    await vi.waitFor(() => expect(second.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
    second.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'not json' }] } })
    second.emit('session-1', 'turn/end', { status: 'completed' })
    expect((await second.request('tasks.get', { taskId: [...second.store.jobs.keys()][0] })).result).toMatchObject({ status: 'failed', error: { code: 'invalid-json' } })
  })
  it('times out without retrying the agent task', async () => {
    vi.useFakeTimers()
    const h = harness(); const job = h.taskParams(); await h.request('tasks.run', { ...job, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1001)
    expect((await h.request('tasks.get', { taskId: job.taskId })).result).toMatchObject({ status: 'interrupted', resumable: true, error: { code: 'timeout' } })
    expect(h.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('returns clarification as an explicit failure instead of leaving an invisible question pending', async () => {
    const h = harness(); const job = h.taskParams(); await h.request('tasks.run', job)
    await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
    h.store.ingest({ t: 'event', frame: { rpcId: 'question-id', method: 'question/requested', payload: {
      sessionId: 'session-1', questions: [{ question: 'Which date range?' }],
    } } })
    expect((await h.request('tasks.get', { taskId: job.taskId })).result).toMatchObject({ status: 'interrupted', resumable: true })
    await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.cancel', { sessionId: 'session-1' }))
  })
})

describe('SDK to extension wire', () => {
  it('automatically reconnects and fetches the original result without another run or prompt', async () => {
    vi.useFakeTimers()
    const first = harness(); const replacement = harness()
    vi.mocked(replacement.deps.rpc).mockImplementation(first.deps.rpc)
    const connect = vi.fn().mockReturnValueOnce(first.page).mockReturnValue(replacement.page)
    vi.stubGlobal('chrome', { runtime: { connect } })
    const client = new TandixClient('test-extension'); cleanup.push(() => client.close())
    const task = await client.run({ taskId: crypto.randomUUID(), prompt: 'Grade once' })
    await vi.advanceTimersByTimeAsync(1)
    first.close()
    first.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'Score: 95' }] } })
    first.emit('session-1', 'turn/end', { status: 'completed' })
    await vi.advanceTimersByTimeAsync(1100)
    await expect(task.result()).resolves.toMatchObject({ taskId: task.id, text: 'Score: 95' })
    expect(task.snapshot).toMatchObject({ backend: 'codex', sessionId: 'session-1', attempt: 1 })
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'web.tasks.run')).toHaveLength(1)
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(1)
    expect(connect).toHaveBeenCalledTimes(2)
  })
  it('recovers a lost acceptance response by task ID instead of submitting twice', async () => {
    vi.useFakeTimers()
    const first = harness(); const replacement = harness()
    vi.mocked(replacement.deps.rpc).mockImplementation(first.deps.rpc)
    const original = vi.mocked(first.port.postMessage).getMockImplementation()!
    vi.mocked(first.port.postMessage).mockImplementation((message: any) => {
      if (message.result?.taskId && message.ok) { first.close(); return }
      original(message)
    })
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn().mockReturnValueOnce(first.page).mockReturnValue(replacement.page) } })
    const client = new TandixClient('test-extension'); cleanup.push(() => client.close())
    const id = crypto.randomUUID()
    const task = await client.run({ taskId: id, prompt: 'Grade once' })
    await vi.advanceTimersByTimeAsync(1)
    first.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'Done once' }] } })
    first.emit('session-1', 'turn/end', { status: 'completed' })
    await vi.advanceTimersByTimeAsync(1100)
    await expect(task.result()).resolves.toMatchObject({ taskId: id, text: 'Done once' })
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'web.tasks.run')).toHaveLength(1)
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
  })
  it('attaches after a page reload and replays sequenced progress without rerunning the agent', async () => {
    const first = harness(); const job = first.taskParams(); await first.request('tasks.run', job)
    await vi.waitFor(() => expect(first.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.anything()))
    first.store.event(first.store.jobs.get(job.taskId), 'delta', { text: 'Page 1 graded' })
    first.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'Completed grading' }] } })
    first.emit('session-1', 'turn/end', { status: 'completed' })
    const second = harness(); vi.mocked(second.deps.rpc).mockImplementation(first.deps.rpc)
    vi.stubGlobal('chrome', { runtime: { connect: () => second.page } })
    const client = new TandixClient('test-extension'); cleanup.push(() => client.close())
    const task = await client.attach(job.taskId)
    const events: any[] = []; task.onProgress(event => events.push(event))
    await expect(task.result()).resolves.toMatchObject({ text: 'Completed grading' })
    expect(events.some(event => event.type === 'delta' && event.text === 'Page 1 graded')).toBe(true)
    expect(new Set(events.map(event => event.seq)).size).toBe(events.length)
    expect(vi.mocked(first.deps.rpc).mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(1)
  })
  it('keeps heartbeats flowing while the user reviews a pending authorization', async () => {
    vi.useFakeTimers()
    const h = harness({ allowed: false })
    let decide!: (allowed: boolean) => void
    vi.mocked(h.deps.authorize).mockImplementation(() => new Promise(resolve => { decide = resolve }))
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => h.page) } })
    const client = new TandixClient('test-extension'); cleanup.push(() => client.close())
    const authorization = client.authorize()
    await vi.advanceTimersByTimeAsync(41_000)
    expect(h.deps.authorize).toHaveBeenCalledTimes(1)
    expect(h.deps.allowed).toHaveBeenCalledTimes(2)
    decide(false)
    await expect(authorization).resolves.toBe(false)
  })

  it('uploads a chunked PDF and multiple images and receives the final result', async () => {
    const h = harness()
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => h.page) } })
    const closeBitmap = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: closeBitmap })))
    const client = new TandixClient('test-extension'); cleanup.push(() => client.close())
    const pdf = new NodeFile(['%PDF-1.7\n', 'a'.repeat(WEB_LIMITS.chunkBytes)], 'report.pdf', { type: 'application/pdf' }) as unknown as File
    const png = new NodeFile([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], 'first.png', { type: 'image/png' }) as unknown as File
    const jpg = new NodeFile([new Uint8Array([255, 216, 255, 0])], 'second.jpg', { type: 'image/jpeg' }) as unknown as File
    const task = await client.run({ prompt: 'Extract the totals', files: [pdf, png, jpg] })
    await vi.waitFor(() => expect(h.deps.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ content: expect.arrayContaining([
      expect.objectContaining({ type: 'file', name: 'report.pdf', data: expect.stringMatching(/^JVBER/u) }),
      expect.objectContaining({ type: 'image', name: 'first.png' }), expect.objectContaining({ type: 'image', name: 'second.jpg' }),
    ]) })))
    h.emit('session-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'Total: 42' }] } })
    h.emit('session-1', 'turn/end', { status: 'completed' })
    await expect(task.result()).resolves.toEqual({ taskId: task.id, text: 'Total: 42' })
    expect(closeBitmap).toHaveBeenCalledTimes(2)
  })
})
