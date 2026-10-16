import { webRecord, webpageOrigin } from '../web-api/protocol.ts'

const KEY = 'tandixWebOrigins'
const PAGE = 'web-access/index.html'
interface Pending { origin: string; resolve(allowed: boolean): void; timer: ReturnType<typeof setTimeout> }

/** Grants can only be edited by the bundled extension page, never by a webpage message. */
export class WebAccess {
  private readonly pending = new Map<string, Pending>()
  private readonly requestedAt = new Map<string, number>()
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(private readonly revoked: (origin: string) => void) {}
  async origins(): Promise<string[]> {
    const value = (await chrome.storage.local.get(KEY))[KEY]
    return Array.isArray(value) ? value.filter((origin): origin is string => typeof origin === 'string' && webpageOrigin(origin) === origin) : []
  }
  async allowed(origin: string): Promise<boolean> { return (await this.origins()).includes(origin) }
  async authorize(origin: string): Promise<boolean> {
    if (await this.allowed(origin)) return true
    if (this.pending.size >= 3 || [...this.pending.values()].some(item => item.origin === origin)) throw new Error('An authorization request is already pending')
    if (Date.now() - (this.requestedAt.get(origin) ?? 0) < 60_000) throw new Error('Wait before requesting authorization again')
    if (this.requestedAt.size >= 128) this.requestedAt.delete(this.requestedAt.keys().next().value!)
    this.requestedAt.set(origin, Date.now())
    const id = crypto.randomUUID()
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false), 120_000)
      this.pending.set(id, { origin, resolve, timer })
      void chrome.tabs.create({ url: chrome.runtime.getURL(`${PAGE}?request=${id}`), active: true })
        .catch(() => this.settle(id, false))
    })
  }
  private settle(id: string, allowed: boolean): void {
    const item = this.pending.get(id)
    if (!item) return
    clearTimeout(item.timer); this.pending.delete(id); item.resolve(allowed)
  }
  install(): void {
    chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
      if (!webRecord(message) || message.type !== 'tandix-web-access') return
      if (sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== chrome.runtime.getURL(PAGE)) return
      const operation = this.mutations.then(() => this.handle(message))
      this.mutations = operation.catch(() => {})
      void operation.then(result => respond({ ok: true, result }), error => respond({ ok: false,
        error: error instanceof Error ? error.message : 'Authorization failed' }))
      return true
    })
  }
  private async handle(message: Record<string, unknown>): Promise<unknown> {
    const origins = await this.origins()
    const request = this.pending.get(String(message.requestId))
    if (message.action === 'get') return { origins, requestedOrigin: request?.origin ?? null }
    if (message.action === 'decide') {
      if (!request || typeof message.allow !== 'boolean') throw new Error('Authorization request expired; retry from the webpage')
      if (message.allow) await chrome.storage.local.set({ [KEY]: [...new Set([...origins, request.origin])] })
      this.settle(String(message.requestId), message.allow)
      return {}
    }
    if (message.action === 'revoke' && typeof message.origin === 'string') {
      await chrome.storage.local.set({ [KEY]: origins.filter(origin => origin !== message.origin) })
      this.revoked(message.origin)
      return {}
    }
    throw new Error('Unknown authorization action')
  }
}
