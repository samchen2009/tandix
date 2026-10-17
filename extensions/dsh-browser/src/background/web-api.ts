import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { WEB_API_PORT, WEB_API_VERSION, WEB_LIMITS, WEB_MEDIA_TYPES, WebApiError, webRecord, webpageOrigin,
  type WebFileInfo, type WebTaskSnapshot } from '../web-api/protocol.ts'

interface Upload extends WebFileInfo { chunks: string[]; received: number }
interface Client {
  port: chrome.runtime.Port; origin: string; closed: boolean; busy: boolean
  uploads: Map<string, Upload>; bytes: number; task: string | null; expiry: ReturnType<typeof setTimeout>
  receipts: Map<string, string>
}
interface Job { id: string; origin: string; sessionId?: string; timer?: ReturnType<typeof setTimeout> }
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
  private readonly jobs = new Map<string, Job>()
  private readonly taskRequests = new Map<string, Promise<WebTaskSnapshot>>()
  private readonly webSessions = new Set<string>()
  constructor(private readonly deps: WebApiDeps) {}

  isWebSession(sessionId: string | undefined): boolean { return sessionId !== undefined && this.webSessions.has(sessionId) }

  connect(port: chrome.runtime.Port): void {
    const sender = port.sender
    const origin = webpageOrigin(sender?.url ?? '')
    if (port.name !== WEB_API_PORT || !origin || sender?.id || sender?.tab?.id === undefined || sender.frameId !== 0
      || this.clients.size >= 8) { port.disconnect(); return }
    const client: Client = { port, origin, closed: false, busy: false, uploads: new Map(), receipts: new Map(), bytes: 0, task: null,
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
      code: error instanceof WebApiError ? error.code : webRecord(error) && typeof error.code === 'string' ? error.code : 'agent-error',
      message: error instanceof Error ? error.message : 'Request failed',
    } })
  }
  private async request(client: Client, method: unknown, params: unknown): Promise<unknown> {
    clearTimeout(client.expiry)
    client.expiry = setTimeout(() => this.close(client), WEB_LIMITS.maxTaskMs)
    if (method === 'hello') return { product: 'tandix', version: WEB_API_VERSION, origin: client.origin,
      authorized: await this.deps.allowed(client.origin), limits: WEB_LIMITS,
      mediaTypes: WEB_MEDIA_TYPES, backends: ['codex'], resultFormats: ['text', 'json'], taskRecovery: 1 }
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
    if (['tasks.get', 'tasks.attach', 'tasks.resume', 'tasks.cancel'].includes(String(method))) {
      if (typeof params.taskId !== 'string' || !/^[a-f0-9-]{36}$/u.test(params.taskId)) throw new WebApiError('invalid-request', 'Invalid task ID')
      return this.proxy(client.origin, String(method) === 'tasks.attach' ? 'get' : String(method).slice(6), params)
    }
    if (method !== 'tasks.run') throw new WebApiError('unknown-method', 'Unknown Tandix webpage method')
    const signature = JSON.stringify({ taskId: params.taskId, prompt: params.prompt, fileIds: params.fileIds,
      responseFormat: params.responseFormat, timeoutMs: params.timeoutMs ?? WEB_LIMITS.maxTaskMs })
    if (client.receipts.get(String(params.taskId)) === signature) return this.proxy(client.origin, 'get', { taskId: params.taskId })
    if ((client.task !== null && client.task !== params.taskId) || (this.jobs.size >= 4 && !this.jobs.has(String(params.taskId)))) throw new WebApiError('busy', 'Too many active tasks; attach to an existing task')
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
    const result = await this.proxy(client.origin, 'run', { ...params,
      files: files.map(file => ({ name: file.name, mediaType: file.mediaType, data: file.chunks.join('') })) })
    client.receipts.set(result.taskId, signature)
    if (client.receipts.size > 20) client.receipts.delete(client.receipts.keys().next().value!)
    client.uploads.clear(); client.bytes = 0
    client.task = ['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status) ? null : result.taskId
    return result
  }

  private proxy(origin: string, action: string, params: Record<string, unknown>): Promise<WebTaskSnapshot> {
    const id = String(params.taskId)
    const previous = this.taskRequests.get(id) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.dispatch(origin, action, params))
    this.taskRequests.set(id, operation)
    void operation.finally(() => { if (this.taskRequests.get(id) === operation) this.taskRequests.delete(id) }).catch(() => {})
    return operation
  }
  private async dispatch(origin: string, action: string, params: Record<string, unknown>): Promise<WebTaskSnapshot> {
    const id = String(params.taskId)
    const tracked = this.jobs.get(id)
    if (tracked && tracked.origin !== origin) throw new WebApiError('unknown-task', 'Task not found')
    let temporaryLease = !tracked
    try {
      if (temporaryLease) {
        const backend = await this.deps.acquire()
        if (backend !== 'codex') throw new WebApiError('unsupported-backend', 'This webpage task belongs to Codex. Select Codex and attach to the same task ID.')
      }
      // Origin always comes from Chrome's validated sender, never webpage params.
      const snapshot = await this.deps.rpc(`web.tasks.${action}`, { ...params, origin }) as WebTaskSnapshot
      if (!webRecord(snapshot) || snapshot.taskId !== id || snapshot.backend !== 'codex' || typeof snapshot.status !== 'string') {
        throw new WebApiError('agent-error', 'Companion returned an invalid task snapshot')
      }
      if (snapshot.sessionId) this.webSessions.add(snapshot.sessionId)
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.status)) {
        if (tracked) { clearTimeout(tracked.timer); this.jobs.delete(id); this.deps.release() }
        for (const client of this.clients) if (client.task === id) client.task = null
      } else if (!tracked) {
        const job: Job = { id, origin, sessionId: snapshot.sessionId ?? undefined }
        this.jobs.set(id, job); temporaryLease = false
        this.poll(job)
      }
      return snapshot
    } finally { if (temporaryLease) this.deps.release() }
  }
  private poll(job: Job): void {
    clearTimeout(job.timer)
    job.timer = setTimeout(() => {
      if (!this.jobs.has(job.id)) return
      void this.proxy(job.origin, 'get', { taskId: job.id }).catch(() => {
        // Retain the lease while the bridge reconnects. Never resubmit a prompt.
      }).finally(() => { if (this.jobs.has(job.id)) this.poll(job) })
    }, 5000)
  }
  ingest(_frame: ServerFrame): void { /* Progress is replayed by sequence through tasks.get. */ }
  failDisconnected(): void { /* Durable tasks stay in the companion and reconcile on reconnect. */ }
  dispose(): void {
    for (const job of this.jobs.values()) { clearTimeout(job.timer); this.deps.release() }
    this.jobs.clear()
    for (const client of this.clients) this.close(client)
  }
  revoke(origin: string): void {
    for (const job of this.jobs.values()) if (job.origin === origin) {
      void this.proxy(origin, 'cancel', { taskId: job.id }).catch(() => {})
    }
    for (const client of this.clients) if (client.origin === origin) this.close(client)
  }
  private close(client: Client): void {
    if (client.closed) return
    client.closed = true
    clearTimeout(client.expiry)
    client.uploads.clear(); client.bytes = 0
    this.clients.delete(client)
    // A page/Port disconnect only detaches its observer; accepted tasks keep their lease.
    try { client.port.disconnect() } catch { /* Already disconnected. */ }
  }
}
