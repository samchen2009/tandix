export const PAGE_SESSION_CONTEXT_STORAGE_KEY = 'dshPageSessionContexts'
/** Obsolete global-recency key retained only so startup can remove it. */
export const LEGACY_RECENT_SESSION_STORAGE_KEY = 'dshRecentBrowserSession'

export interface PageSessionContext {
  sessionId: string
  windowId: number
  urlKey: string
  updatedAt: number
}

interface StoredPageSessionContexts {
  version: 1
  tabs: Record<string, PageSessionContext>
}

interface PageSessionContextStorage {
  read: () => Promise<unknown>
  write: (value: StoredPageSessionContexts) => Promise<void>
}

export interface PageContextTab {
  id?: number
  windowId: number
  url?: string
  title?: string
}

/** Normalize the page identity used for automatic conversation restoration. */
export function pageUrlKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

/** Browser-lifetime mapping from a live tab to its conversation. */
export class PageSessionContextTracker {
  private tabs = new Map<number, PageSessionContext>()
  private liveTabs = new Map<number, PageContextTab>()
  private revision = 0
  private persistence = Promise.resolve()
  readonly ready: Promise<void>

  constructor(
    private readonly storage: PageSessionContextStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.ready = this.restore()
  }

  /** Add a tab to a session, replacing only that tab's prior owner. */
  bind(sessionValue: unknown, tab: PageContextTab): boolean {
    const sessionId = normalizeSessionId(sessionValue)
    const tabId = normalizeId(tab.id)
    const windowId = normalizeId(tab.windowId)
    if (sessionId === undefined || tabId === undefined || windowId === undefined) return false

    // URL is retained as metadata, not as identity: navigation inside the same
    // tab must not silently start a different agent conversation.
    const urlKey = pageUrlKey(tab.url) ?? this.tabs.get(tabId)?.urlKey ?? ''
    this.tabs.set(tabId, { sessionId, windowId, urlKey, updatedAt: this.now() })
    this.liveTabs.set(tabId, { ...tab })
    this.persist()
    return true
  }

  /** All pages belonging to one conversation, in their association order. */
  list(sessionId: string): Array<PageContextTab & { id: number }> {
    return [...this.tabs.entries()]
      .filter(([, context]) => context.sessionId === sessionId)
      .map(([id, context]) => ({
        id, windowId: context.windowId, url: context.urlKey,
        ...this.liveTabs.get(id),
      }))
  }

  /** Refresh page metadata without changing its conversation. */
  observeTab(tab: PageContextTab): boolean {
    if (tab.id === undefined || !this.tabs.has(tab.id)) return false
    const context = this.tabs.get(tab.id)!
    this.liveTabs.set(tab.id, { ...tab })
    if (context.windowId !== tab.windowId) {
      context.windowId = tab.windowId
      this.persist()
    }
    return true
  }

  /** Hydrate live metadata and prune tabs closed while the worker was asleep. */
  reconcile(tabs: PageContextTab[]): void {
    const live = new Map(tabs.map(tab => [tab.id, tab]))
    for (const id of this.tabs.keys()) {
      const tab = live.get(id)
      if (tab === undefined) this.removeTab(id)
      else this.observeTab(tab)
    }
  }

  /** Return a session only for the exact live tab and window. */
  candidate(tab: PageContextTab): string | null {
    const tabId = normalizeId(tab.id)
    const windowId = normalizeId(tab.windowId)
    if (tabId === undefined || windowId === undefined) return null
    const context = this.tabs.get(tabId)
    return context?.windowId === windowId
      ? context.sessionId
      : null
  }

  removeTab(tabValue: unknown): boolean {
    const tabId = normalizeId(tabValue)
    if (tabId === undefined || !this.tabs.delete(tabId)) return false
    this.liveTabs.delete(tabId)
    this.persist()
    return true
  }

  /** Transfer identity during Chrome's prerender/replacement tab swap. */
  replaceTab(removedValue: unknown, addedValue: unknown): boolean {
    const removedTabId = normalizeId(removedValue)
    const addedTabId = normalizeId(addedValue)
    if (removedTabId === undefined || addedTabId === undefined || removedTabId === addedTabId) return false
    const context = this.tabs.get(removedTabId)
    if (context === undefined) return false
    this.tabs.delete(removedTabId)
    const live = this.liveTabs.get(removedTabId)
    this.liveTabs.delete(removedTabId)
    if (live !== undefined) this.liveTabs.set(addedTabId, { ...live, id: addedTabId })
    this.tabs.delete(addedTabId)
    this.tabs.set(addedTabId, context)
    this.persist()
    return true
  }

  private persist(): void {
    this.revision += 1
    const value: StoredPageSessionContexts = {
      version: 1,
      tabs: Object.fromEntries(
        [...this.tabs.entries()].map(([tabId, context]) => [String(tabId), { ...context }]),
      ),
    }
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      await this.storage.write(value)
    }).catch(() => {})
  }

  private async restore(): Promise<void> {
    const revision = this.revision
    try {
      const restored = parseStoredContexts(await this.storage.read())
      if (this.revision === revision) this.tabs = restored
    } catch {
      // Session continuity is best effort; a storage failure still permits a new chat.
    }
  }
}

function parseStoredContexts(value: unknown): Map<number, PageSessionContext> {
  const restored = new Map<number, PageSessionContext>()
  if (typeof value !== 'object' || value === null) return restored
  const record = value as { version?: unknown; tabs?: unknown }
  if (record.version !== 1 || typeof record.tabs !== 'object' || record.tabs === null) return restored
  for (const [tabKey, raw] of Object.entries(record.tabs)) {
    const tabId = normalizeId(Number(tabKey))
    if (tabId === undefined || typeof raw !== 'object' || raw === null) continue
    const context = raw as Partial<PageSessionContext>
    const sessionId = normalizeSessionId(context.sessionId)
    const windowId = normalizeId(context.windowId)
    const urlKey = context.urlKey === '' ? '' : pageUrlKey(context.urlKey)
    const updatedAt = typeof context.updatedAt === 'number' && Number.isFinite(context.updatedAt) && context.updatedAt >= 0
      ? context.updatedAt
      : undefined
    if (sessionId === undefined || windowId === undefined || urlKey === undefined || updatedAt === undefined) continue
    restored.set(tabId, { sessionId, windowId, urlKey, updatedAt })
  }
  return restored
}

function normalizeId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function normalizeSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
