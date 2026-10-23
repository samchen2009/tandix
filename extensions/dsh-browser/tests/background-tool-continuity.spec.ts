// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SESSION_CONTEXT_STORAGE_KEY } from '../src/background/session-continuity.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const port = { name: 'dsh-panel', postMessage: vi.fn(), onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port }
}

function browserTab(url: string): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: 'Page',
    url,
  }
}

function storedUrlKey(sessionData: Record<string, unknown>): string | undefined {
  return (sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY] as {
    tabs?: Record<string, { urlKey?: string }>
  } | undefined)?.tabs?.[1]?.urlKey
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('tool-driven session checkpoints', () => {
  it('updates only after a successful navigation candidate', async () => {
    let currentTab = browserTab('https://example.com/start')
    let childTab: chrome.tabs.Tab | undefined
    let manualTab: chrome.tabs.Tab | undefined
    let action: (name: string) => Promise<unknown> = async () => ({ ok: true, result: { text: 'snapshot' } })
    const onConnect = chromeEvent<[chrome.runtime.Port]>()
    const onCreated = chromeEvent<[chrome.tabs.Tab]>()
    const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
    const onCreatedNavigationTarget = chromeEvent<[{ sourceTabId: number; tabId: number; sourceFrameId: number }]>()
    const sessionData: Record<string, unknown> = {}
    const sendMessage = vi.fn(async (_tabId: number, message: unknown) => {
      const name = (message as { action?: string }).action
      return name === undefined ? undefined : await action(name)
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
      sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
      storage: {
        local: {
          get: vi.fn(async () => ({
            dshSettings: {
              bridgeUrl: 'wss://bridge.example/ext/bridge',
              sharePageContent: 'auto',
              trustedActionOrigins: ['https://example.com'],
            },
          })),
          set: vi.fn(async () => {}),
        },
        session: {
          get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
          remove: vi.fn(async (key: string) => { delete sessionData[key] }),
        },
      },
      tabs: {
        get: vi.fn(async (id: number) => id === childTab?.id ? childTab : id === manualTab?.id ? manualTab : currentTab),
        query: vi.fn(async (query: chrome.tabs.QueryInfo) => [currentTab, childTab, manualTab]
          .filter((tab): tab is chrome.tabs.Tab => tab !== undefined && (query.active !== true || tab.active))),
        sendMessage,
        onCreated,
        onActivated,
        onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
        onReplaced: chromeEvent<[number, number]>(),
        onRemoved: chromeEvent<[number]>(),
      },
      scripting: { executeScript: vi.fn(async () => []) },
      webNavigation: {
        onCreatedNavigationTarget,
        getAllFrames: vi.fn(async () => [{
          tabId: 1,
          frameId: 0,
          parentFrameId: -1,
          documentId: 'document-1',
          url: currentTab.url!,
        }]),
        onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: chromeEvent<[number]>(),
        onRemoved: chromeEvent<[number]>(),
      },
    } as unknown as typeof chrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/start') })
    panel.onDisconnect.emit()

    const call = async (id: string, name: string): Promise<void> => {
      socket.receive({
        t: 'tool.call',
        id,
        name,
        args: name === 'browser_navigate' ? { url: 'https://example.com/target' } : {},
        expiresAt: Date.now() + 10_000,
        sessionId: 'session-live',
      })
      await vi.waitFor(() => {
        expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id }))
      })
    }

    action = async (name) => {
      if (name === 'browser_navigate') {
        currentTab = browserTab('https://example.com/failed')
        return { ok: false, error: { code: 'action-failed', message: 'navigation failed' } }
      }
      return { ok: true, result: { text: 'snapshot' } }
    }
    await call('failed', 'browser_navigate')
    expect(storedUrlKey(sessionData)).toBe('https://example.com/start')

    action = async () => {
      currentTab = browserTab('https://example.com/non-navigation')
      manualTab = { ...browserTab('https://example.com/non-navigation'), id: 3, openerTabId: 1, active: false }
      onCreated.emit(manualTab)
      return { ok: true, result: { text: 'snapshot' } }
    }
    await call('snapshot', 'browser_snapshot')
    expect(storedUrlKey(sessionData)).toBe('https://example.com/start')
    expect(sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).not.toHaveProperty('tabs.3')

    let finishCommitted!: () => void
    action = async () => await new Promise((resolve) => {
      finishCommitted = () => resolve({ ok: true, result: { text: 'navigated' } })
    })
    socket.receive({
      t: 'tool.call',
      id: 'committed',
      name: 'browser_navigate',
      args: { url: 'https://example.com/target' },
      expiresAt: Date.now() + 10_000,
      sessionId: 'session-live',
    })
    await vi.waitFor(() => { expect(finishCommitted).toBeTypeOf('function') })
    currentTab = browserTab('https://example.com/committed')
    socket.receive({ t: 'tool.cancel', id: 'committed' })
    finishCommitted()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'committed', ok: true }))
    })
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/committed') })

    action = async () => {
      currentTab = browserTab('https://example.com/success?step=2#done')
      return { ok: true, result: { text: 'navigated' } }
    }
    await call('success', 'browser_navigate')
    await vi.waitFor(() => { expect(storedUrlKey(sessionData)).toBe('https://example.com/success') })

    // A click opens a linked page while its source action is still completing.
    action = async (name) => {
      if (name === 'browser_click' && childTab === undefined) {
        childTab = { ...browserTab('https://example.com/details'), id: 2, openerTabId: 1 }
        currentTab.active = false
        onCreated.emit(childTab)
        onCreatedNavigationTarget.emit({ sourceTabId: 1, tabId: 2, sourceFrameId: 0 })
        onActivated.emit({ tabId: 2, windowId: 1 })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return { ok: true, result: { text: 'page snapshot' } }
    }
    await call('popup', 'browser_click')
    await vi.waitFor(() => {
      expect(sessionData.dshTabAffinity).toMatchObject({ sessionTabs: { 'session-live': { tabId: 2 } } })
    })
    const refresh = (socket.sent as Array<{ t: string; id: string; method?: string }>).filter(frame =>
      frame.t === 'rpc' && frame.method === 'bridge.injectBrowserSnapshot').at(-1)!
    expect(refresh).toBeDefined()
    // This action was generated before the new page snapshot reached the agent.
    socket.receive({ t: 'tool.call', id: 'stale-click', name: 'browser_click', args: { index: 1 },
      expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    const delivered = sendMessage.mock.calls.length
    socket.receive({ t: 'rpc.result', id: refresh.id, ok: true, result: {} })
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({
      t: 'tool.result', id: 'stale-click', ok: false,
      error: expect.objectContaining({ message: expect.stringContaining('No action was performed') }),
    })))
    expect(sendMessage.mock.calls).toHaveLength(delivered)
    expect(sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
      tabs: { 1: { sessionId: 'session-live' }, 2: { sessionId: 'session-live' } },
    })
  })
})
