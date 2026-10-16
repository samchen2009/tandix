import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { WEB_API_PORT, WEB_API_VERSION, WEB_LIMITS, WEB_MEDIA_TYPES, WebApiError, webRecord, webpageOrigin,
  type WebFileInfo, type WebTaskEvent } from '../web-api/protocol.ts'

interface Upload extends WebFileInfo { chunks: string[]; received: number }
interface Client {
  port: chrome.runtime.Port; origin: string; closed: boolean; busy: boolean
  uploads: Map<string, Upload>; bytes: number; task: Job | null; expiry: ReturnType<typeof setTimeout>
}
interface Job {
  id: string; client: Client; sessionId?: string; done: boolean; leased: boolean
  text: string; format: 'text' | 'json'; timer: ReturnType<typeof setTimeout>
}
export interface WebApiDeps {
  allowed(origin: string): Promise<boolean>
  authorize(origin: string): Promise<boolean>
  acquire(): Promise<string>
  release(): void
  rpc(method: string, payload: unknown): Promise<unknown>
}

/** Only explicit methods are exposed: webpage callers never get a gateway RPC proxy. */
export class WebApiServer {
  private readonly clients = new Set<Client>()
  private readonly sessions = new Map<string, Job>()
  private readonly webSessions = new Set<string>()
  private active = 0
  constructor(private readonly deps: WebApiDeps) {}

  isWebSession(sessionId: string | undefined): boolean { return sessionId !== undefined && this.webSessions.has(sessionId) }

  connect(port: chrome.runtime.Port): void {
    const sender = port.sender
    const origin = webpageOrigin(sender?.url ?? '')
    if (port.name !== WEB_API_PORT || !origin || sender?.id || sender?.tab?.id === undefined || sender.frameId !== 0
      || this.clients.size >= 8) { port.disconnect(); return }
    const client: Client = { port, origin, closed: false, busy: false, uploads: new Map(), bytes: 0, task: null,
      expiry: setTimeout(() => this.close(client), WEB_LIMITS.maxTaskMs) }
    this.clients.add(client)
    port.onDisconnect.addListener(() => this.close(client))
    port.onMessage.addListener((message: unknown) => {
      // Sequence upload mutations and bound outstanding requests per connection.
      if (!webRecord(message) || typeof message.id !== 'string' || message.id.length > 100) return
      if (message.method === 'hello') {
        void this.request(client, 'hello', {}).then(
          result => this.reply(client, message.id as string, result),
          error => this.reply(client, message.id as string, undefined, error),
        )
        return
      }
      if (client.busy) { this.reply(client, message.id, undefined, new WebApiError('busy', 'Wait for the preceding request')); return }
      client.busy = true
      void this.request(client, message.method, message.params).then(
        result => { client.busy = false; this.reply(client, message.id as string, result) },
        error => { client.busy = false; this.reply(client, message.id as string, undefined, error) },
      )
    })
  }

  private send(client: Client, message: unknown): void {
    if (client.closed) return
    try { client.port.postMessage(message) } catch { this.close(client) }
  }
  private reply(client: Client, id: string, result?: unknown, error?: unknown): void {
    this.send(client, error === undefined ? { id, ok: true, result } : { id, ok: false, error: {
      code: error instanceof WebApiError ? error.code : 'agent-error',
      message: error instanceof Error ? error.message : 'Request failed',
    } })
  }
  private event(job: Job, event: Omit<WebTaskEvent, 'taskId'>): void {
    this.send(job.client, { event: { taskId: job.id, ...event } })
  }
  private async request(client: Client, method: unknown, params: unknown): Promise<unknown> {
    clearTimeout(client.expiry)
    client.expiry = setTimeout(() => this.close(client), WEB_LIMITS.maxTaskMs)
    if (method === 'hello') return { product: 'tandix', version: WEB_API_VERSION, origin: client.origin,
      authorized: await this.deps.allowed(client.origin), limits: WEB_LIMITS,
      mediaTypes: WEB_MEDIA_TYPES, backends: ['codex'], resultFormats: ['text', 'json'] }
    if (method === 'permissions.request') return { authorized: await this.deps.authorize(client.origin) }
    if (!await this.deps.allowed(client.origin)) throw new WebApiError('authorization-required', 'Authorize this site in Tandix first')
    if (client.closed) throw new WebApiError('disconnected', 'Page disconnected')
    if (!webRecord(params)) throw new WebApiError('invalid-request', 'Expected an object')
    if (method === 'files.begin') {
      if (client.task !== null || client.uploads.size >= WEB_LIMITS.maxFiles) throw new WebApiError('busy', 'Finish the current task or remove uploads')
      const { name, mediaType, bytes } = params
      if (typeof name !== 'string' || name.length === 0 || name.length > 160 || /[\x00-\x1f/\\]/u.test(name)
        || !WEB_MEDIA_TYPES.includes(mediaType as never) || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0
        || bytes > WEB_LIMITS.maxFileBytes || (mediaType !== 'application/pdf' && bytes > WEB_LIMITS.maxImageBytes)
        || client.bytes + bytes > WEB_LIMITS.maxTotalBytes) throw new WebApiError('invalid-file', 'Unsupported file type, filename or size')
      const fileId = crypto.randomUUID()
      client.uploads.set(fileId, { name, mediaType: mediaType as WebFileInfo['mediaType'], bytes, chunks: [], received: 0 })
      client.bytes += bytes
      return { fileId }
    }
    if (method === 'files.chunk') {
      const upload = client.uploads.get(String(params.fileId))
      const data = params.data
      if (!upload || typeof data !== 'string' || data.length > WEB_LIMITS.chunkBytes / 3 * 4
        || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
        || params.offset !== upload.received) throw new WebApiError('invalid-chunk', 'Invalid chunk, offset or file ID')
      const decoded = atob(data)
      if (btoa(decoded) !== data || upload.received + decoded.length > upload.bytes
        || (upload.received + decoded.length < upload.bytes && decoded.length % 3 !== 0)) throw new WebApiError('invalid-chunk', 'Invalid encoding or length')
      upload.chunks.push(data)
      upload.received += decoded.length
      return { received: upload.received }
    }
    if (method === 'files.remove') {
      const upload = client.uploads.get(String(params.fileId))
      if (upload) { client.bytes -= upload.bytes; client.uploads.delete(String(params.fileId)) }
      return { removed: !!upload }
    }
    if (method === 'tasks.cancel') {
      const job = client.task
      if (!job || job.id !== params.taskId) throw new WebApiError('unknown-task', 'Task does not belong to this connection')
      await this.cancel(job, 'cancelled', 'Cancelled by webpage')
      return { cancelled: true }
    }
    if (method !== 'tasks.run') throw new WebApiError('unknown-method', 'Unknown Tandix webpage method')
    if (client.task !== null || this.active >= 4) throw new WebApiError('busy', 'Too many active tasks')
    if (typeof params.taskId !== 'string' || !/^[a-f0-9-]{36}$/u.test(params.taskId)
      || typeof params.prompt !== 'string' || params.prompt.trim() === '' || params.prompt.length > WEB_LIMITS.maxPromptChars
      || !Array.isArray(params.fileIds) || params.fileIds.length > WEB_LIMITS.maxFiles
      || new Set(params.fileIds).size !== params.fileIds.length
      || !['text', 'json'].includes(String(params.responseFormat))
      || (params.timeoutMs !== undefined && (typeof params.timeoutMs !== 'number' || !Number.isSafeInteger(params.timeoutMs)
        || params.timeoutMs < 1000 || params.timeoutMs > WEB_LIMITS.maxTaskMs))) throw new WebApiError('invalid-request', 'Invalid task parameters')
    const uploads = params.fileIds.map(id => client.uploads.get(String(id)))
    if (uploads.some(file => !file || file.received !== file.bytes)) throw new WebApiError('incomplete-upload', 'Missing or incomplete attachment')
    const files = uploads as Upload[]
    for (const file of files) {
      const prefix = atob(file.chunks.slice(0, 6).join('')).slice(0, 16)
      const valid = file.mediaType === 'application/pdf' ? prefix.startsWith('%PDF-')
        : file.mediaType === 'image/png' ? prefix.startsWith('\x89PNG\r\n\x1a\n')
        : file.mediaType === 'image/jpeg' ? prefix.startsWith('\xff\xd8\xff')
        : file.mediaType === 'image/gif' ? /^GIF8[79]a/u.test(prefix)
        : prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP'
      if (!valid) throw new WebApiError('invalid-file', 'Attachment content does not match its media type')
      if (file.mediaType !== 'application/pdf') {
        let bitmap: ImageBitmap
        try {
          const parts = file.chunks.map(chunk => Uint8Array.from(atob(chunk), char => char.charCodeAt(0)))
          bitmap = await createImageBitmap(new Blob(parts, { type: file.mediaType }))
        } catch { throw new WebApiError('invalid-file', 'Image could not be decoded') }
        try {
          if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 36_000_000) {
            throw new WebApiError('invalid-file', 'Image exceeds 8192 px per side or 36 million pixels')
          }
        } finally { bitmap.close() }
      }
    }
    if (client.closed || !await this.deps.allowed(client.origin)) throw new WebApiError('authorization-revoked', 'Site authorization was revoked')
    const job: Job = { id: params.taskId, client, done: false, leased: false, text: '', format: params.responseFormat as 'text' | 'json',
      timer: setTimeout(() => { void this.cancel(job, 'timeout', 'Task timed out') }, params.timeoutMs as number ?? WEB_LIMITS.maxTaskMs) }
    client.task = job
    this.active++
    const content = [{ type: 'text', text: params.prompt + (job.format === 'json' ? '\nReturn the final answer as valid JSON, without Markdown fences.' : '') },
      ...files.map(file => ({ type: file.mediaType === 'application/pdf' ? 'file' : 'image',
        mediaType: file.mediaType, name: file.name, data: file.chunks.join('') }))]
    client.uploads.clear(); client.bytes = 0
    void this.start(job, content)
    return { taskId: job.id }
  }

  private async start(job: Job, content: unknown[]): Promise<void> {
    try {
      // acquire() claims the lease synchronously, before asynchronous startup.
      job.leased = true
      const backend = await this.deps.acquire()
      if (job.done) return
      if (backend !== 'codex') throw new WebApiError('unsupported-backend', 'Web file tasks currently require the Codex backend; select Codex in Tandix settings')
      if (!await this.deps.allowed(job.client.origin) || job.client.closed || job.done) throw new WebApiError('authorization-revoked', 'Site authorization was revoked')
      const created = await this.deps.rpc('session.create', { webTaskId: job.id })
      if (!webRecord(created) || typeof created.sessionId !== 'string') throw new Error('Agent did not return a session ID')
      job.sessionId = created.sessionId
      this.webSessions.add(job.sessionId)
      if (job.done) { await this.deps.rpc('session.cancel', { sessionId: job.sessionId }); return }
      this.sessions.set(job.sessionId, job)
      this.event(job, { type: 'started' })
      await this.deps.rpc('session.prompt', { sessionId: job.sessionId, mode: 'queue', content })
      if (job.done) await this.deps.rpc('session.cancel', { sessionId: job.sessionId })
    } catch (error) {
      this.finish(job, { type: 'failed', error: { code: error instanceof WebApiError ? error.code : 'agent-error',
        message: error instanceof Error ? error.message : 'Agent failed' } })
    } finally {
      if (job.done) this.release(job)
    }
  }

  ingest(frame: ServerFrame): void {
    if (frame.t !== 'event' || !webRecord(frame.frame.payload)) return
    const payload = frame.frame.payload
    const job = this.sessions.get(String(payload.sessionId))
    if (!job || job.done) return
    if (frame.frame.method === 'question/requested') {
      const questions = Array.isArray(payload.questions) ? payload.questions.filter(webRecord)
        .filter(question => question.secret !== true && typeof question.question === 'string')
        .map(question => String(question.question).slice(0, 500)).slice(0, 4).join('\n') : ''
      void this.cancel(job, 'user-input-required', `Agent needs additional input. Update the prompt and submit a new task.${questions ? `\n${questions}` : ''}`)
      return
    }
    if (frame.frame.method === 'agent-approval/requested') {
      this.event(job, { type: 'waiting-for-user' }); return
    }
    if (frame.frame.method === 'session/assistant-stream' && webRecord(payload.frame) && webRecord(payload.frame.chunk)
      && payload.frame.chunk.type === 'text-delta' && typeof payload.frame.chunk.text === 'string') {
      this.event(job, { type: 'delta', text: payload.frame.chunk.text.slice(0, WEB_LIMITS.maxResultChars) }); return
    }
    if (frame.frame.method !== 'session/event' || !webRecord(payload.event)) return
    const event = payload.event
    const data = webRecord(event.data) ? event.data : {}
    if (event.type === 'assistant/message' && webRecord(data.message) && Array.isArray(data.message.content)) {
      const text = data.message.content.filter(webRecord).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('')
      if (text.length > WEB_LIMITS.maxResultChars) { void this.cancel(job, 'result-too-large', 'Agent result exceeds the limit'); return }
      job.text = text
    }
    if (event.type !== 'turn/end') return
    if (data.status !== 'completed') {
      this.finish(job, { type: data.status === 'interrupted' ? 'cancelled' : 'failed',
        error: { code: 'agent-failed', message: typeof data.error === 'string' ? data.error : 'Agent did not complete the task' } }); return
    }
    try {
      if (!job.text.trim()) throw new WebApiError('empty-result', 'Agent returned no final text')
      const result = { taskId: job.id, text: job.text, ...(job.format === 'json' ? { data: JSON.parse(job.text) as unknown } : {}) }
      this.finish(job, { type: 'completed', result })
    } catch (error) {
      this.finish(job, { type: 'failed', error: { code: error instanceof WebApiError ? error.code : 'invalid-json',
        message: error instanceof WebApiError ? error.message : 'Final answer is not valid JSON' } })
    }
  }

  private release(job: Job): void {
    if (job.leased) { job.leased = false; this.deps.release() }
  }
  private finish(job: Job, event: Omit<WebTaskEvent, 'taskId'>): void {
    if (job.done) return
    job.done = true
    clearTimeout(job.timer)
    if (job.sessionId) this.sessions.delete(job.sessionId)
    this.event(job, event)
    job.client.task = null
    this.active--
    this.release(job)
  }
  private async cancel(job: Job, code: string, message: string): Promise<void> {
    if (job.done) return
    // Stop returning data immediately; a failed cancellation never implies success.
    this.finish(job, { type: code === 'cancelled' ? 'cancelled' : 'failed', error: { code, message } })
    if (job.sessionId) { try { await this.deps.rpc('session.cancel', { sessionId: job.sessionId }) } catch { /* Connection loss is already terminal. */ } }
  }
  failDisconnected(): void {
    for (const job of this.sessions.values()) this.finish(job, { type: 'failed',
      error: { code: 'agent-disconnected', message: 'Agent connection lost; task was not retried' } })
  }
  revoke(origin: string): void {
    for (const client of this.clients) if (client.origin === origin) this.close(client)
  }
  private close(client: Client): void {
    if (client.closed) return
    client.closed = true
    clearTimeout(client.expiry)
    client.uploads.clear(); client.bytes = 0
    this.clients.delete(client)
    if (client.task) void this.cancel(client.task, 'cancelled', 'Webpage connection closed')
    try { client.port.disconnect() } catch { /* Already disconnected. */ }
  }
}
