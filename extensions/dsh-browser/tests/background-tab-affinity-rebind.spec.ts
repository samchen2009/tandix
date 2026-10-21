// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

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
  const port = {
    name: 'dsh-panel',
    postMessage,
    onMessage,
    onDisconnect,
    ...(tabId === undefined ? {} : { sender: { url: `chrome-extension://test/panel/index.html?tandixTab=${tabId}` } }),
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function tab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
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
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
  }
}

function mockChrome() {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
  const query = vi.fn(async () => [tab(1)])
  const update = vi.fn(async (tabId: number) => tab(tabId))
  const updateWindow = vi.fn(async () => ({ id: 1 }))
  vi.stubGlobal('chrome', {
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: chromeEvent<[chrome.alarms.Alarm]>(),
    },
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
    sidePanel: {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      update,
      sendMessage: vi.fn(async (_tabId: number, message: { type?: string }) =>
        message.type === 'DSH_ACTION' ? { ok: true, result: { text: 'Page snapshot' } } : undefined),
      onActivated,
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      update: updateWindow,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onActivated, onConnect, query, update, updateWindow }
}

async function connectPanelForTest() {
  const chromeMock = mockChrome()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => {
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
  })
  panel.postMessage.mockClear()
  return { ...chromeMock, ...panel }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('background tab-affinity rebind protocol', () => {
  it('keeps tab-specific Tandix panels bound to their own pages', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    const first = panelPort(1)
    const second = panelPort(2)
    chromeMock.onConnect.emit(first.port)
    chromeMock.onConnect.emit(second.port)
    first.onMessage.emit({ type: 'panel.window', windowId: 1 })
    second.onMessage.emit({ type: 'panel.window', windowId: 1 })
    first.onMessage.emit({ type: 'session.active', sessionId: 'session-1', isNew: true })
    second.onMessage.emit({ type: 'session.active', sessionId: 'session-2', isNew: true })

    await vi.waitFor(() => {
      expect(first.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity',
        state: expect.objectContaining({
          status: 'following',
          controlled: expect.objectContaining({ tabId: 1 }),
          active: expect.objectContaining({ tabId: 1 }),
        }),
      }))
      expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity',
        state: expect.objectContaining({
          status: 'following',
          controlled: expect.objectContaining({ tabId: 2 }),
          active: expect.objectContaining({ tabId: 2 }),
        }),
      }))
    })

    first.postMessage.mockClear()
    second.postMessage.mockClear()
    chromeMock.onActivated.emit({ tabId: 2, windowId: 1 })

    await vi.waitFor(() => {
      const firstStates = first.postMessage.mock.calls
        .map(([message]) => message as { type?: string; state?: { status?: string; controlled?: { tabId?: number } } })
        .filter((message) => message.type === 'tab-affinity')
      const secondStates = second.postMessage.mock.calls
        .map(([message]) => message as { type?: string; state?: { status?: string; controlled?: { tabId?: number } } })
        .filter((message) => message.type === 'tab-affinity')
      expect(firstStates.at(-1)?.state).toMatchObject({ status: 'following', controlled: { tabId: 1 } })
      expect(secondStates.at(-1)?.state).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
      expect(firstStates.some((message) => message.state?.status === 'handoff')).toBe(false)
      expect(secondStates.some((message) => message.state?.status === 'handoff')).toBe(false)
    })
  })

  it('shows the controlled tab without rebinding the assistant to the current tab', async () => {
    const { onActivated, onMessage, postMessage, query, update, updateWindow } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity',
        state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
      }))
    })

    onActivated.emit({ tabId: 2, windowId: 1 })
    query.mockResolvedValue([tab(2)])
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity',
        state: expect.objectContaining({ status: 'handoff', controlled: expect.objectContaining({ tabId: 1 }) }),
      }))
    })
    const handoff = postMessage.mock.calls.map(([message]) => message as { type?: string; state?: { revision: number; status: string } })
      .filter((message) => message.type === 'tab-affinity' && message.state?.status === 'handoff').at(-1)?.state
    expect(handoff).toBeDefined()
    onMessage.emit({ type: 'tab-affinity.response', revision: handoff!.revision, decision: 'keep' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity',
        state: expect.objectContaining({ status: 'background', controlled: expect.objectContaining({ tabId: 1 }) }),
      }))
    })
    const background = postMessage.mock.calls.map(([message]) => message as { type?: string; state?: { revision: number; status: string } })
      .filter((message) => message.type === 'tab-affinity' && message.state?.status === 'background').at(-1)?.state
    expect(background).toBeDefined()
    onMessage.emit({ type: 'tab-affinity.response', revision: background!.revision, decision: 'show-controlled' })

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(1, { active: true })
      expect(updateWindow).toHaveBeenCalledWith(1, { focused: true })
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity',
        state: expect.objectContaining({
          status: 'following',
          controlled: expect.objectContaining({ tabId: 1 }),
          active: expect.objectContaining({ tabId: 1 }),
        }),
      }))
    })
  })

  it('uses the requesting panel session for show-controlled and follow decisions', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await import('../src/background/index.ts')
    const first = panelPort(1)
    const second = panelPort(2)
    chromeMock.onConnect.emit(first.port)
    chromeMock.onConnect.emit(second.port)
    first.onMessage.emit({ type: 'panel.window', windowId: 1 })
    second.onMessage.emit({ type: 'panel.window', windowId: 1 })
    first.onMessage.emit({ type: 'session.active', sessionId: 'first-session', isNew: true })
    second.onMessage.emit({ type: 'session.active', sessionId: 'second-session', isNew: true })
    await vi.waitFor(() => {
      expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity', state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 2 }) }),
      }))
    })
    const third = panelPort(3)
    chromeMock.onConnect.emit(third.port)
    third.onMessage.emit({ type: 'panel.window', windowId: 1 })
    third.onMessage.emit({ type: 'session.active', sessionId: 'first-session' })
    second.onMessage.emit({ type: 'session.active', sessionId: 'second-session' })
    const state = () => third.postMessage.mock.calls.map(([message]) => message)
      .filter(message => message.type === 'tab-affinity').at(-1).state
    expect(state()).toMatchObject({ status: 'background', controlled: { tabId: 1 }, active: { tabId: 3 } })
    third.onMessage.emit({ type: 'tab-affinity.response', revision: state().revision,
      decision: 'show-controlled', sessionId: 'first-session' })
    await vi.waitFor(() => { expect(chromeMock.update).toHaveBeenCalledWith(1, { active: true }) })
    expect(chromeMock.update).not.toHaveBeenCalledWith(2, { active: true })

    // Even if another page is globally active, follow means this panel's page.
    chromeMock.query.mockResolvedValue([tab(2)])
    third.onMessage.emit({ type: 'tab-affinity.response', revision: state().revision,
      decision: 'follow', sessionId: 'first-session' })
    await vi.waitFor(() => {
      expect(state()).toMatchObject({ status: 'following', controlled: { tabId: 3 }, active: { tabId: 3 } })
    })
    second.onMessage.emit({ type: 'request-status' })
    expect(second.postMessage.mock.calls.map(([message]) => message)
      .filter(message => message.type === 'tab-affinity').at(-1).state)
      .toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('acknowledges only after control has moved to the freshly queried active tab', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    query.mockResolvedValue([tab(2)])

    onMessage.emit({ type: 'tab-affinity.rebind', id: 'rebind-1' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'rebind-1', ok: true })
    })
    const messages = postMessage.mock.calls.map(([message]) => message as { type?: string; state?: unknown })
    const resultIndex = messages.findIndex((message) => message.type === 'tab-affinity.rebind.result')
    const affinityIndex = messages.map((message) => message.type).lastIndexOf('tab-affinity', resultIndex)
    expect(affinityIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(affinityIndex)
    expect(messages[affinityIndex]?.state).toMatchObject({
      status: 'following',
      controlled: { tabId: 2 },
      active: { tabId: 2 },
    })
  })

  it('reports an active-tab query failure and leaves the existing binding unchanged', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()
    query.mockRejectedValue(new Error('query failed'))

    onMessage.emit({ type: 'tab-affinity.rebind', id: 'failed-rebind' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tab-affinity.rebind.result',
        id: 'failed-rebind',
        ok: false,
        error: expect.objectContaining({ code: 'no-active-tab' }),
      }))
    })
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))

    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
    }))
  })

  it('owns the deadline in the background and ignores a query that resolves after timeout', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    let finishQuery!: (tabs: chrome.tabs.Tab[]) => void
    query.mockImplementationOnce(async () => await new Promise<chrome.tabs.Tab[]>((resolve) => {
      finishQuery = resolve
    }))
    vi.useFakeTimers()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'slow-rebind' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity.rebind.result',
      id: 'slow-rebind',
      ok: false,
      error: expect.objectContaining({ code: 'timeout' }),
    }))
    postMessage.mockClear()

    finishQuery([tab(2)])
    await Promise.resolve()
    await Promise.resolve()
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))

    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
    }))
  })

  it('cancels an in-flight rebind when its panel disconnects', async () => {
    const { onDisconnect, onMessage, postMessage, query } = await connectPanelForTest()
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    let finishQuery!: (tabs: chrome.tabs.Tab[]) => void
    query.mockImplementationOnce(async () => await new Promise<chrome.tabs.Tab[]>((resolve) => {
      finishQuery = resolve
    }))
    onMessage.emit({ type: 'tab-affinity.rebind', id: 'disconnected-rebind' })
    await vi.waitFor(() => { expect(finishQuery).toBeTypeOf('function') })
    onDisconnect.emit()
    finishQuery([tab(2)])
    await Promise.resolve()
    await Promise.resolve()

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
    onMessage.emit({ type: 'request-status' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab-affinity',
      state: expect.objectContaining({ status: 'following', controlled: expect.objectContaining({ tabId: 1 }) }),
    }))
  })
})
