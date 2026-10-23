// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SESSION_CONTEXT_STORAGE_KEY } from '../src/background/session-continuity.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort(tabId?: number) {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: 'dsh-panel', postMessage, onMessage, onDisconnect,
    ...(tabId === undefined ? {} : { sender: { url: `chrome-extension://test/panel/index.html?tandixTab=${tabId}` } }),
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function tab(id: number, url: string, windowId = 1): chrome.tabs.Tab {
  return {
    id,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId,
    title: `Tab ${id}`,
    url,
  }
}

function mockChrome(initialTabs: chrome.tabs.Tab[], storedContext?: unknown) {
  const tabs = new Map(initialTabs.map((entry) => [entry.id!, entry]))
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onRemoved = chromeEvent<[number]>()
  const onReplaced = chromeEvent<[number, number]>()
  const onCreated = chromeEvent<[chrome.tabs.Tab]>()
  const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
  const onUpdated = chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()
  const onCreatedNavigationTarget = chromeEvent<[{ sourceTabId: number; tabId: number }]>()
  const update = vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
    const current = tabs.get(tabId)!
    if (properties.active) {
      for (const entry of tabs.values()) if (entry.windowId === current.windowId) entry.active = false
    }
    Object.assign(current, properties)
    if (properties.active) onActivated.emit({ tabId, windowId: current.windowId })
    return current
  })
  const setPanelOptions = vi.fn(async () => {})
  const sessionData: Record<string, unknown> = storedContext === undefined
    ? {}
    : { [PAGE_SESSION_CONTEXT_STORAGE_KEY]: storedContext }
  const sessionSet = vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) })
  const query = vi.fn(async (queryInfo: chrome.tabs.QueryInfo) => {
    const candidates = [...tabs.values()].filter((entry) => queryInfo.windowId === undefined || entry.windowId === queryInfo.windowId)
    return candidates.filter((entry) => queryInfo.active !== true || entry.active)
  })
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setOptions: setPanelOptions, setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
        set: sessionSet,
        remove: vi.fn(async (key: string) => { delete sessionData[key] }),
      },
    },
    tabs: {
      update,
      get: vi.fn(async (tabId: number) => {
        const entry = tabs.get(tabId)
        if (entry === undefined) throw new Error('No tab')
        return entry
      }),
      query,
      sendMessage: vi.fn(async (_tabId: number, message: { type?: string }) =>
        message.type === 'DSH_ACTION' ? { ok: true, result: { text: 'Page snapshot' } } : undefined),
      onCreated,
      onActivated,
      onUpdated,
      onReplaced,
      onRemoved,
    },
    webNavigation: { onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(), onCreatedNavigationTarget },
    windows: {
      update: vi.fn(async () => ({})),
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onConnect, onRemoved, onReplaced, onCreated, onActivated, onUpdated, onCreatedNavigationTarget,
    update, query, sessionData, sessionSet, setPanelOptions, tabs }
}

function resumeHints(postMessage: ReturnType<typeof vi.fn>): Array<string | null> {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; sessionId?: string | null })
    .filter((message) => message.type === 'session.resume-hint')
    .map((message) => message.sessionId ?? null)
}

function latestAffinity(panel: ReturnType<typeof panelPort>): TabAffinityState | undefined {
  return panel.postMessage.mock.calls.map(([message]) => message)
    .filter(message => message.type === 'tab-affinity').at(-1)?.state
}

async function loadBackground(chromeMock: ReturnType<typeof mockChrome>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('background contextual session continuity', () => {
  it('shares a conversation across linked pages and switches the browser from either panel', async () => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/list'),
      { ...tab(2, 'https://example.com/detail'), active: false },
      { ...tab(9, 'https://unrelated.example/'), active: false }], {
      version: 1, tabs: {
        1: { sessionId: 'shared-session', windowId: 1, urlKey: 'https://example.com/list', updatedAt: 1 },
        2: { sessionId: 'shared-session', windowId: 1, urlKey: 'https://example.com/detail', updatedAt: 2 },
      },
    })
    await loadBackground(chromeMock)
    const first = panelPort(1)
    chromeMock.onConnect.emit(first.port)
    first.onMessage.emit({ type: 'panel.window', windowId: 1 })
    first.onMessage.emit({ type: 'session.active', sessionId: 'shared-session', isNew: true })
    await vi.waitFor(() => expect(latestAffinity(first)?.tabs?.map(tab => tab.tabId)).toEqual([1, 2]))
    expect(latestAffinity(first)?.controlled?.tabId).toBe(1)

    const second = panelPort(2)
    chromeMock.onConnect.emit(second.port)
    second.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => expect(second.postMessage).toHaveBeenCalledWith({
      type: 'session.resume-hint', sessionId: 'shared-session', shared: true,
    }))
    second.onMessage.emit({ type: 'session.active', sessionId: 'shared-session' })
    await vi.waitFor(() => expect(latestAffinity(second)?.tabs?.map(tab => tab.tabId)).toEqual([1, 2]))

    first.onMessage.emit({ type: 'tab-affinity.response', decision: 'show-tab',
      revision: latestAffinity(first)!.revision, sessionId: 'shared-session', tabId: 2 })
    await vi.waitFor(() => {
      expect(chromeMock.update).toHaveBeenCalledWith(2, { active: true })
      expect(latestAffinity(first)?.controlled?.tabId).toBe(2)
      expect(latestAffinity(second)?.visibleTabId).toBe(2)
    })
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 2 })

    // Unrelated browser tabs cannot be activated through this conversation's strip.
    chromeMock.update.mockClear()
    first.onMessage.emit({ type: 'tab-affinity.response', decision: 'show-tab',
      revision: latestAffinity(first)!.revision, sessionId: 'shared-session', tabId: 9 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chromeMock.update).not.toHaveBeenCalled()

    // Switching browser tabs does not change either panel's conversation.
    await chromeMock.update(1, { active: true })
    await vi.waitFor(() => {
      expect(latestAffinity(first)?.controlled?.tabId).toBe(1)
      expect(latestAffinity(second)?.visibleTabId).toBe(1)
    })
    expect(latestAffinity(second)?.tabs?.map(tab => tab.tabId)).toEqual([1, 2])

    await chromeMock.update(2, { active: true })
    await vi.waitFor(() => expect(latestAffinity(first)?.controlled?.tabId).toBe(2))
    chromeMock.tabs.delete(2)
    chromeMock.onRemoved.emit(2)
    await vi.waitFor(() => {
      expect(latestAffinity(first)?.tabs?.map(tab => tab.tabId)).toEqual([1])
      expect(latestAffinity(first)?.controlled?.tabId).toBe(1)
    })
    expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
      tabs: { 1: { sessionId: 'shared-session' } },
    })
  })

  it.each([
    { label: 'a fresh tab', url: 'https://unrelated.example/', openerTabId: undefined },
    { label: 'a fresh tab retaining opener metadata', url: 'https://example.com/detail', openerTabId: 1 },
    { label: 'a duplicate of the same URL', url: 'https://example.com/list', openerTabId: 1 },
  ])('starts an independent conversation for $label', async ({ url, openerTabId }) => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/list')])
    await loadBackground(chromeMock)
    const panel = panelPort(1)
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'session.active', sessionId: 'shared', isNew: true })
    await vi.waitFor(() => expect(latestAffinity(panel)?.tabs).toHaveLength(1))
    const child = { ...tab(2, 'about:blank'), active: false, openerTabId }
    chromeMock.tabs.set(2, child)
    chromeMock.onCreated.emit(child)
    const loaded = { ...child, title: 'Manually opened page', url }
    chromeMock.tabs.set(2, loaded)
    chromeMock.onUpdated.emit(2, { title: loaded.title, url: loaded.url }, loaded)
    await chromeMock.update(2, { active: true })
    const second = panelPort(2)
    chromeMock.onConnect.emit(second.port)
    second.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => expect(resumeHints(second.postMessage)).toContain(null))
    second.onMessage.emit({ type: 'session.active', sessionId: 'manual-session', isNew: true })
    await vi.waitFor(() => {
      expect(latestAffinity(panel)?.tabs?.map(tab => tab.tabId)).toEqual([1])
      expect(latestAffinity(second)?.tabs?.map(tab => tab.tabId)).toEqual([2])
    })
    expect(resumeHints(second.postMessage)).not.toContain('shared')
    expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
      tabs: { 1: { sessionId: 'shared' }, 2: { sessionId: 'manual-session' } },
    })
    const updated = { ...loaded, title: 'Updated manual page' }
    chromeMock.tabs.set(2, updated)
    chromeMock.onUpdated.emit(2, { title: updated.title }, updated)
    await vi.waitFor(() => expect(latestAffinity(second)?.tabs?.[0]?.title).toBe('Updated manual page'))
  })

  it.each([
    { label: 'a foreground link', active: true, openerTabId: 1 },
    { label: 'a background link', active: false, openerTabId: 1 },
    { label: 'a link without opener metadata', active: true, openerTabId: undefined },
  ])('records $label in its source conversation without a running Tandix action', async ({ active, openerTabId }) => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/list')])
    await loadBackground(chromeMock)
    const source = panelPort(1)
    chromeMock.onConnect.emit(source.port)
    source.onMessage.emit({ type: 'session.active', sessionId: 'source-session', isNew: true })
    await vi.waitFor(() => expect(latestAffinity(source)?.tabs).toHaveLength(1))

    const child = { ...tab(2, 'https://example.com/detail'), active, openerTabId }
    chromeMock.tabs.set(2, child)
    chromeMock.onCreated.emit(child)
    if (active) await chromeMock.update(2, { active: true })
    chromeMock.onCreatedNavigationTarget.emit({ sourceTabId: 1, tabId: 2 })
    // A destination panel may connect before the async membership update finishes.
    const destination = panelPort(2)
    chromeMock.onConnect.emit(destination.port)
    destination.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => {
      expect(latestAffinity(source)?.tabs?.map(tab => tab.tabId)).toEqual([1, 2])
      expect(destination.postMessage).toHaveBeenCalledWith({
        type: 'session.resume-hint', sessionId: 'source-session', shared: true,
      })
    })
    destination.onMessage.emit({ type: 'session.active', sessionId: 'source-session' })
    await vi.waitFor(() => expect(latestAffinity(destination)?.tabs?.map(tab => tab.tabId)).toEqual([1, 2]))
    expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
      tabs: { 1: { sessionId: 'source-session' }, 2: { sessionId: 'source-session' } },
    })
  })

  it('disables the global Chrome panel and configures a panel instance per tab', async () => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/one'), tab(2, 'https://example.com/two')])
    await loadBackground(chromeMock)
    await vi.waitFor(() => {
      expect(chromeMock.setPanelOptions).toHaveBeenCalledWith({ enabled: false })
      expect(chromeMock.setPanelOptions).toHaveBeenCalledWith({
        tabId: 1, path: 'panel/index.html?tandixTab=1', enabled: true,
      })
      expect(chromeMock.setPanelOptions).toHaveBeenCalledWith({
        tabId: 2, path: 'panel/index.html?tandixTab=2', enabled: true,
      })
    })
  })

  it('returns a hint for the same tab across navigation, never a different tab', async () => {
    const stored = {
      version: 1,
      tabs: {
        1: { sessionId: 'session-page', windowId: 1, urlKey: 'https://example.com/orders', updatedAt: 1 },
      },
    }
    const chromeMock = mockChrome([tab(1, 'https://example.com/orders?q=new#receipt')], stored)
    await loadBackground(chromeMock)

    const matching = panelPort()
    chromeMock.onConnect.emit(matching.port)
    matching.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(matching.postMessage)).toContain('session-page') })

    chromeMock.tabs.set(1, tab(1, 'https://example.com/account'))
    const differentPath = panelPort()
    chromeMock.onConnect.emit(differentPath.port)
    differentPath.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(differentPath.postMessage)).toContain('session-page') })

    chromeMock.tabs.delete(1)
    chromeMock.tabs.set(2, tab(2, 'https://example.com/orders'))
    const differentTab = panelPort()
    chromeMock.onConnect.emit(differentTab.port)
    differentTab.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(differentTab.postMessage)).toContain(null) })
  })

  it('keeps one independent session per tab even when both panels share a window', async () => {
    const first = tab(1, 'https://example.com/one')
    const second = { ...tab(2, 'https://example.com/two'), active: false }
    const chromeMock = mockChrome([first, second])
    await loadBackground(chromeMock)

    const panelOne = panelPort(1)
    chromeMock.onConnect.emit(panelOne.port)
    panelOne.onMessage.emit({ type: 'panel.window', windowId: 1 })
    panelOne.onMessage.emit({ type: 'session.active', sessionId: 'session-one', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 1: { sessionId: 'session-one' } },
      })
    })

    chromeMock.tabs.set(1, { ...first, active: false })
    chromeMock.tabs.set(2, { ...second, active: true })
    const panelTwo = panelPort(2)
    chromeMock.onConnect.emit(panelTwo.port)
    panelTwo.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(panelTwo.postMessage)).toContain(null) })
    panelTwo.onMessage.emit({ type: 'session.active', sessionId: 'session-two', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 1: { sessionId: 'session-one' }, 2: { sessionId: 'session-two' } },
      })
    })
    expect(resumeHints(panelOne.postMessage)).not.toContain('session-two')
  })

  it('keeps a tab session after the panel closes and the tab navigates', async () => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/start')])
    await loadBackground(chromeMock)
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'panel.window', windowId: 1 })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 1: { sessionId: 'session-live', urlKey: 'https://example.com/start' } },
      })
    })

    chromeMock.tabs.set(1, tab(1, 'https://example.com/during-panel?step=2'))
    panel.onDisconnect.emit()
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 1: { sessionId: 'session-live', urlKey: 'https://example.com/during-panel' } },
      })
    })

    chromeMock.tabs.set(1, tab(1, 'https://example.com/after-close'))
    const reopened = panelPort()
    chromeMock.onConnect.emit(reopened.port)
    reopened.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(reopened.postMessage)).toContain('session-live') })
    expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
      tabs: { 1: { urlKey: 'https://example.com/during-panel' } },
    })
  })

  it('retains the original page when the user associates another tab', async () => {
    const first = tab(1, 'https://example.com/first')
    const chromeMock = mockChrome([first])
    await loadBackground(chromeMock)
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: { 1: {} } })
    })

    chromeMock.tabs.set(1, { ...first, active: false })
    chromeMock.tabs.set(2, tab(2, 'https://example.com/second'))
    panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'rebind' })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'rebind', ok: true })
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 2: { sessionId: 'session-live', urlKey: 'https://example.com/second' } },
      })
    })
    expect((chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY] as { tabs: Record<string, unknown> }).tabs)
      .toHaveProperty('1')
  })

  it('migrates replacement tabs and removes closed-tab recovery contexts', async () => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/page')])
    await loadBackground(chromeMock)
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: { 1: {} } })
    })

    chromeMock.tabs.delete(1)
    chromeMock.tabs.set(9, tab(9, 'https://example.com/page'))
    chromeMock.onReplaced.emit(9, 1)
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: { 9: {} } })
    })

    chromeMock.tabs.delete(9)
    chromeMock.onRemoved.emit(9)
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: {} })
    })
  })
})
