import { WEB_API_PORT, WEB_API_VERSION, WEB_DISCOVERY_REQUEST, WEB_DISCOVERY_RESPONSE, WEB_LIMITS, WebApiError, webRecord,
  webpageOrigin, type WebTaskEvent, type WebTaskResult } from './protocol.ts'

export { WebApiError } from './protocol.ts'
export type { WebTaskEvent, WebTaskResult } from './protocol.ts'
export interface RunOptions { prompt: string; files?: readonly File[]; responseFormat?: 'text' | 'json'; timeoutMs?: number }
export interface WebHello { product: 'tandix'; version: number; origin: string; authorized: boolean; limits: typeof WEB_LIMITS;
  mediaTypes: string[]; backends: string[]; resultFormats: string[] }
export interface DiscoverOptions { timeoutMs?: number }

export class TandixTask {
  private readonly listeners = new Set<(event: WebTaskEvent) => void>()
  private readonly completion: Promise<WebTaskResult>
  private resolve!: (result: WebTaskResult) => void
  private reject!: (error: Error) => void
  constructor(readonly id: string, private readonly cancelTask: () => Promise<void>) {
    this.completion = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.completion.catch(() => {})
  }
  onProgress(listener: (event: WebTaskEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  result(): Promise<WebTaskResult> { return this.completion }
  cancel(): Promise<void> { return this.cancelTask() }
  /** @internal */
  accept(event: WebTaskEvent): void {
    if (event.type === 'completed' && event.result) this.resolve(event.result)
    else if (['failed', 'cancelled'].includes(event.type)) this.reject(new WebApiError(event.error?.code ?? event.type, event.error?.message ?? event.type))
    for (const listener of this.listeners) { try { listener(event) } catch { /* Consumer exceptions must not break result delivery. */ } }
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

  private readonly port: chrome.runtime.Port
  private readonly requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly tasks = new Map<string, TandixTask>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private running = false
  private readonly heartbeat: ReturnType<typeof setInterval>
  constructor(extensionId: string) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) throw new WebApiError('unavailable', 'Tandix is unavailable; use Chrome/Edge and enable the extension')
    this.port = chrome.runtime.connect(extensionId, { name: WEB_API_PORT })
    this.port.onMessage.addListener((message: unknown) => this.receive(message))
    this.port.onDisconnect.addListener(() => this.disconnect(chrome.runtime.lastError?.message ?? 'Tandix connection closed'))
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
      const id = crypto.randomUUID()
      task = new TandixTask(id, async () => { await this.rpc('tasks.cancel', { taskId: id }) })
      this.tasks.set(id, task)
      void task.result().finally(() => { this.tasks.delete(id); this.running = false }).catch(() => {})
      await this.rpc('tasks.run', { taskId: id, prompt: options.prompt, fileIds: uploaded,
        responseFormat: options.responseFormat ?? 'text', ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
      return task
    } catch (error) {
      if (task) { this.tasks.delete(task.id); task.accept({ taskId: task.id, type: 'failed', error: {
        code: error instanceof WebApiError ? error.code : 'upload-failed', message: error instanceof Error ? error.message : 'Upload failed' } }) }
      for (const fileId of uploaded) { try { await this.rpc('files.remove', { fileId }) } catch { /* A disconnected worker already discarded uploads. */ } }
      this.running = false
      throw error
    }
  }
  close(): void { this.disconnect('Client closed'); this.port.disconnect() }
  private disconnect(message: string): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.heartbeat)
    const error = new WebApiError('disconnected', message)
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error) }
    this.requests.clear()
    for (const task of this.tasks.values()) task.accept({ taskId: task.id, type: 'failed', error: { code: error.code, message } })
    this.tasks.clear()
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    const dispatch = () => {
      if (this.closed) throw new WebApiError('disconnected', 'Tandix connection closed')
      const id = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { this.requests.delete(id); reject(new WebApiError('request-timeout', `Tandix ${method} timed out`)); this.close() }, 125_000)
        this.requests.set(id, { resolve, reject, timer })
        try { this.port.postMessage({ id, method, params }) } catch (error) {
          clearTimeout(timer); this.requests.delete(id); reject(error); this.close()
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
