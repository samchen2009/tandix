import { WEB_API_PORT, WEB_API_VERSION, WEB_DISCOVERY_REQUEST, WEB_DISCOVERY_RESPONSE, WEB_LIMITS, WebApiError, webRecord,
  webpageOrigin, type WebTaskEvent, type WebTaskResult, type WebTaskSnapshot } from './protocol.ts'

export { WebApiError } from './protocol.ts'
export type { WebTaskEvent, WebTaskResult, WebTaskSnapshot } from './protocol.ts'
export interface RunOptions { taskId?: string; prompt: string; files?: readonly File[]; responseFormat?: 'text' | 'json'; timeoutMs?: number }
export interface WebHello { product: 'tandix'; version: number; origin: string; authorized: boolean; limits: typeof WEB_LIMITS;
  mediaTypes: string[]; backends: string[]; resultFormats: string[]; taskRecovery?: number }
export interface DiscoverOptions { timeoutMs?: number }

export interface ResumeOptions { requestId?: string; prompt?: string }
export class TandixTask {
  private readonly listeners = new Set<(event: WebTaskEvent) => void>()
  private readonly recent: WebTaskEvent[] = []
  private readonly completion: Promise<WebTaskResult>
  private snapshotThrough = 0
  private resolve!: (result: WebTaskResult) => void
  private reject!: (error: Error) => void
  cursor = 0
  snapshot?: WebTaskSnapshot
  done = false
  constructor(readonly id: string, private readonly cancelTask: () => Promise<void>,
    private readonly resumeTask: (options?: ResumeOptions) => Promise<void>) {
    this.completion = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.completion.catch(() => {})
  }
  onProgress(listener: (event: WebTaskEvent) => void): () => void {
    this.listeners.add(listener)
    for (const event of this.recent) { try { listener(event) } catch { /* Consumer callback. */ } }
    return () => { this.listeners.delete(listener) }
  }
  result(): Promise<WebTaskResult> { return this.completion }
  cancel(): Promise<void> { return this.cancelTask() }
  resume(options?: ResumeOptions): Promise<void> { return this.resumeTask(options) }
  /** @internal */
  apply(snapshot: WebTaskSnapshot): void {
    if (this.snapshot && snapshot.lastSeq < this.snapshot.lastSeq) return
    this.snapshot = snapshot
    if (snapshot.reset) {
      this.snapshotThrough = snapshot.lastSeq
      this.recent.splice(0)
      this.accept({ taskId: this.id, type: 'snapshot', text: snapshot.text })
    }
    for (const event of snapshot.events) {
      if (event.type === 'delta' && event.seq !== undefined && event.seq <= this.snapshotThrough) this.cursor = Math.max(this.cursor, event.seq)
      else this.accept(event)
    }
    this.cursor = Math.max(this.cursor, snapshot.cursor)
    if (!snapshot.hasMore && !this.done && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
      this.accept({ taskId: this.id, type: snapshot.status as 'completed' | 'failed' | 'cancelled',
        ...(snapshot.result ? { result: snapshot.result } : {}), ...(snapshot.error ? { error: snapshot.error } : {}) })
    }
  }
  /** @internal */
  accept(event: WebTaskEvent): void {
    if (event.seq !== undefined) { if (event.seq <= this.cursor) return; this.cursor = event.seq }
    if (event.type === 'completed' && event.result) { this.done = true; this.resolve(event.result) }
    else if (['failed', 'cancelled'].includes(event.type)) {
      this.done = true; this.reject(new WebApiError(event.error?.code ?? event.type, event.error?.message ?? event.type))
    }
    this.recent.push(event); if (this.recent.length > 500) this.recent.shift()
    for (const listener of this.listeners) { try { listener(event) } catch { /* Consumer callback. */ } }
  }
}

/** Chrome/Edge webpage client. Bundle this module into the calling site. */
export class TandixClient {
  /** Find Tandix without enumerating installed extensions or prompting for permissions. */
  static async discover(options: DiscoverOptions = {}): Promise<TandixClient> {
    if (typeof window === 'undefined' || window.top !== window || !webpageOrigin(window.location.href)) {
      throw new WebApiError('unsupported-page', 'Open this page over HTTPS or http://localhost / http://127.0.0.1, in the top-level tab')
    }
    const timeoutMs = options.timeoutMs ?? 5000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new WebApiError('invalid-request', 'Discovery timeout must be between 100 and 30000 ms')
    }
    const requestId = crypto.randomUUID()
    return new Promise<TandixClient>((resolve, reject) => {
      const candidates = new Map<string, TandixClient>()
      let settled = false
      const cleanup = (keep?: TandixClient): void => {
        settled = true
        clearTimeout(deadline); clearInterval(retry)
        window.removeEventListener('message', receive)
        for (const candidate of candidates.values()) if (candidate !== keep) candidate.close()
      }
      const receive = (event: MessageEvent): void => {
        if (settled || event.source !== window || event.origin !== window.location.origin || !webRecord(event.data)) return
        const info = event.data
        if (info.type !== WEB_DISCOVERY_RESPONSE || info.requestId !== requestId || info.product !== 'tandix'
          || info.version !== WEB_API_VERSION || typeof info.extensionId !== 'string' || !/^[a-p]{32}$/u.test(info.extensionId)
          || candidates.has(info.extensionId) || candidates.size >= 4) return
        let candidate: TandixClient
        try { candidate = new TandixClient(info.extensionId) } catch { return }
        candidates.set(info.extensionId, candidate)
        // A page message is only a discovery hint. Verify through the actual extension channel.
        void candidate.hello().then(hello => {
          if (!settled && hello.product === 'tandix' && hello.version === WEB_API_VERSION && hello.origin === window.location.origin) {
            cleanup(candidate); resolve(candidate)
          } else if (!settled) candidate.close()
        }, () => { candidate.close() })
      }
      const announce = (): void => window.postMessage({ type: WEB_DISCOVERY_REQUEST, requestId }, window.location.origin)
      const deadline = setTimeout(() => {
        cleanup(); reject(new WebApiError('discovery-timeout', 'Tandix was not detected. Install or enable Tandix, then reload this page and retry'))
      }, timeoutMs)
      const retry = setInterval(announce, 250)
      window.addEventListener('message', receive)
      announce()
    })
  }

  private port: chrome.runtime.Port | null = null
  private readonly polls = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly tasks = new Map<string, TandixTask>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private running = false
  private readonly heartbeat: ReturnType<typeof setInterval>
  constructor(private readonly extensionId: string) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) throw new WebApiError('unavailable', 'Tandix is unavailable; use Chrome/Edge and enable the extension')
    this.connectPort()
    // Actual messages, rather than an idle port alone, keep the MV3 worker active.
    this.heartbeat = setInterval(() => { void this.hello().catch(() => {}) }, 20_000)
  }
  hello(): Promise<WebHello> { return this.rpc('hello', {}) as Promise<WebHello> }
  async authorize(): Promise<boolean> {
    const result = await this.rpc('permissions.request', {}) as { authorized: boolean }
    return result.authorized
  }
  async run(options: RunOptions): Promise<TandixTask> {
    if (this.running) throw new WebApiError('busy', 'One task or upload at a time per client')
    this.running = true
    const uploaded: string[] = []
    let task: TandixTask | undefined
    try {
      const hello = await this.hello()
      if (!hello.authorized) throw new WebApiError('authorization-required', 'Call authorize() after a user action first')
      if (hello.taskRecovery !== 1) throw new WebApiError('unsupported-companion', 'Update Tandix before submitting recoverable tasks')
      const files = options.files ?? []
      if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > hello.limits.maxPromptChars
        || files.length > hello.limits.maxFiles || files.reduce((sum, file) => sum + file.size, 0) > hello.limits.maxTotalBytes) {
        throw new WebApiError('invalid-request', 'Prompt or attachment limits exceeded')
      }
      for (const file of files) {
        if (!hello.mediaTypes.includes(file.type) || file.size <= 0 || file.size > hello.limits.maxFileBytes
          || (file.type !== 'application/pdf' && file.size > hello.limits.maxImageBytes)) throw new WebApiError('invalid-file', `Unsupported file: ${file.name}`)
        const { fileId } = await this.rpc('files.begin', { name: file.name, mediaType: file.type, bytes: file.size }) as { fileId: string }
        uploaded.push(fileId)
        for (let offset = 0; offset < file.size; offset += hello.limits.chunkBytes) {
          const bytes = new Uint8Array(await file.slice(offset, offset + hello.limits.chunkBytes).arrayBuffer())
          let binary = ''
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          await this.rpc('files.chunk', { fileId, offset, data: btoa(binary) })
        }
      }
      const id = options.taskId ?? crypto.randomUUID()
      task = this.task(id)
      const snapshot = await this.rpc('tasks.run', { taskId: id, prompt: options.prompt, fileIds: uploaded,
        responseFormat: options.responseFormat ?? 'text', ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }) as WebTaskSnapshot
      task.apply(snapshot); this.watch(task)
      return task
    } catch (error) {
      if (task && error instanceof WebApiError && ['disconnected', 'request-timeout'].includes(error.code)) {
        // The acceptance reply may be lost. Query this ID; never repeat tasks.run.
        this.watch(task)
        return task
      }
      if (task) { this.tasks.delete(task.id); task.accept({ taskId: task.id, type: 'failed', error: {
        code: error instanceof WebApiError ? error.code : 'upload-failed', message: error instanceof Error ? error.message : 'Upload failed' } }) }
      for (const fileId of uploaded) { try { await this.rpc('files.remove', { fileId }) } catch { /* A disconnected worker already discarded uploads. */ } }
      this.running = false
      throw error
    }
  }
  getTask(taskId: string, afterSeq = 0): Promise<WebTaskSnapshot> {
    return this.rpc('tasks.get', { taskId, afterSeq }) as Promise<WebTaskSnapshot>
  }
  async attach(taskId: string, options: { afterSeq?: number } = {}): Promise<TandixTask> {
    const task = this.tasks.get(taskId) ?? this.task(taskId)
    if (options.afterSeq !== undefined) task.cursor = Math.max(task.cursor, options.afterSeq)
    try {
      const snapshot = await this.rpc('tasks.attach', { taskId, afterSeq: task.cursor }) as WebTaskSnapshot
      task.apply(snapshot); this.watch(task)
    } catch (error) {
      if (error instanceof WebApiError && ['disconnected', 'request-timeout', 'task-busy'].includes(error.code)) this.watch(task)
      else {
        task.accept({ taskId, type: 'failed', error: { code: error instanceof WebApiError ? error.code : 'request-failed',
          message: error instanceof Error ? error.message : 'Could not attach to task' } })
        throw error
      }
    }
    return task
  }
  private task(id: string): TandixTask {
    let pendingResume: { requestId: string; prompt?: string } | undefined
    const task = new TandixTask(id,
      async () => { task.apply(await this.rpc('tasks.cancel', { taskId: id }) as WebTaskSnapshot) },
      async (options: ResumeOptions = {}) => {
        if (!pendingResume || pendingResume.prompt !== options.prompt || options.requestId) {
          pendingResume = { ...options, requestId: options.requestId ?? crypto.randomUUID() }
        }
        const snapshot = await this.rpc('tasks.resume', { taskId: id, ...pendingResume }) as WebTaskSnapshot
        pendingResume = undefined; task.apply(snapshot); this.watch(task)
      })
    this.tasks.set(id, task)
    void task.result().finally(() => {
      clearTimeout(this.polls.get(id)); this.polls.delete(id); this.tasks.delete(id); this.running = false
    }).catch(() => {})
    return task
  }
  private watch(task: TandixTask, delay = 1000): void {
    clearTimeout(this.polls.get(task.id))
    if (this.closed || task.done) return
    this.polls.set(task.id, setTimeout(() => {
      void this.getTask(task.id, task.cursor).then(snapshot => {
        task.apply(snapshot); this.watch(task, snapshot.hasMore ? 0 : 1000)
      }, (error: unknown) => {
        if (error instanceof WebApiError && !['disconnected', 'request-timeout', 'agent-error', 'codex-error', 'task-busy', 'busy'].includes(error.code)) {
          task.accept({ taskId: task.id, type: 'failed', error: { code: error.code, message: error.message } }); return
        }
        task.accept({ taskId: task.id, type: 'disconnected', text: 'Connection interrupted; reconnecting to the same task.' })
        this.watch(task, Math.min(delay * 2, 10000))
      })
    }, delay))
  }
  private connectPort(): chrome.runtime.Port {
    if (this.port) return this.port
    const port = chrome.runtime.connect(this.extensionId, { name: WEB_API_PORT })
    this.port = port
    port.onMessage.addListener((message: unknown) => { if (this.port === port) this.receive(message) })
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.disconnect(chrome.runtime.lastError?.message ?? 'Tandix connection closed')
    })
    return port
  }
  close(): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.heartbeat)
    const port = this.port
    this.disconnect('Client detached; the task remains available by ID')
    port?.disconnect()
    for (const timer of this.polls.values()) clearTimeout(timer)
    for (const task of this.tasks.values()) task.accept({ taskId: task.id, type: 'failed',
      error: { code: 'disconnected', message: 'Client detached. Attach to this task ID to recover it.' } })
    this.tasks.clear()
  }
  private disconnect(message: string): void {
    this.port = null
    const error = new WebApiError('disconnected', message)
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error) }
    this.requests.clear()
    if (!this.closed) for (const task of this.tasks.values()) task.accept({ taskId: task.id, type: 'disconnected', text: message })
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    const dispatch = () => {
      if (this.closed) throw new WebApiError('disconnected', 'Tandix connection closed')
      const id = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { const port = this.port; this.disconnect(`Tandix ${method} timed out`); port?.disconnect(); reject(new WebApiError('request-timeout', `Tandix ${method} timed out`)) }, 125_000)
        this.requests.set(id, { resolve, reject, timer })
        try { this.connectPort().postMessage({ id, method, params }) } catch (error) {
          clearTimeout(timer); this.requests.delete(id); reject(error); this.disconnect('Connection interrupted')
        }
      })
    }
    // Authorization may wait two minutes. Its pending reply must not block
    // heartbeat traffic, otherwise Chrome can suspend the MV3 worker.
    if (method === 'hello') return dispatch()
    const request = this.queue.then(dispatch)
    this.queue = request.catch(() => {})
    return request
  }
  private receive(message: unknown): void {
    if (!webRecord(message)) return
    if (webRecord(message.event) && typeof message.event.taskId === 'string') {
      this.tasks.get(message.event.taskId)?.accept(message.event as unknown as WebTaskEvent); return
    }
    const request = this.requests.get(String(message.id))
    if (!request) return
    clearTimeout(request.timer); this.requests.delete(String(message.id))
    if (message.ok === true) request.resolve(message.result)
    else { const error = webRecord(message.error) ? message.error : {}; request.reject(new WebApiError(String(error.code ?? 'request-failed'), String(error.message ?? 'Request failed'))) }
  }
}
