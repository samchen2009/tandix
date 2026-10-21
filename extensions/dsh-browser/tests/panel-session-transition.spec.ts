// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'
import type { RecordingEventInput } from '../src/recording/schema.ts'
import type { TeachState } from '../src/recording/state-machine.ts'
import { BRIDGE_SESSION_PURGE_METHOD, type ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/panel/api.ts')>(),
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

describe('panel session transitions', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null, backend: 'codex' | 'cursor' | 'workbuddy' | 'dsh') => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onEvent: ((frame: ServerFrame) => void) | undefined
  let onRecordingState: ((state: TeachState) => void) | undefined
  let onRecordingEvent: ((recordingId: string, event: RecordingEventInput) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    const localStore: Record<string, unknown> = { dshSettings: { autoResumeSession: false } }
    vi.stubGlobal('chrome', {
      runtime: { getManifest: vi.fn(() => ({ version: '0.1.4' })), getURL: vi.fn(path => `chrome-extension://test/${path}`) },
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
            if (typeof keys === 'string') return { [keys]: localStore[keys] }
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, localStore[key]]))
            return { ...localStore }
          }),
          set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(localStore, values) }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of typeof keys === 'string' ? [keys] : keys) delete localStore[key]
          }),
        },
      },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })

    rpc = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.prompt') return {}
      if (method === 'session.list') {
        return {
          items: [
            { sessionId: 'session-current', updatedAt: 2, running: false, blank: false },
            { sessionId: 'session-saved', updatedAt: 1, running: false, blank: false },
          ],
        }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> =>
        await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback; return unsubscribe }),
      onEvent: vi.fn((callback) => { onEvent = callback; return unsubscribe }),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('runtime port unavailable')),
      updateSettings: vi.fn(async () => {}),
    requestStatus: vi.fn(async () => {}),
    onRecordingState: vi.fn((callback) => { onRecordingState = callback; return () => {} }),
    onRecordingEvent: vi.fn((callback) => { onRecordingEvent = callback; return () => {} }),
    getRecordingState: vi.fn(async () => ({ phase: 'idle' as const })),
    startRecording: vi.fn(async () => ({ phase: 'recording' as const })),
    stopRecording: vi.fn(async () => ({ phase: 'recorded' as const })),
    exportRecording: vi.fn(async () => ({ filename: 'trace.json', mimeType: 'application/json' as const, content: '{}' })),
    }

    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function renderConnected(hint: string | null, backend: 'codex' | 'cursor' | 'workbuddy' | 'dsh' = 'dsh'): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null, backend)
      onResumeHint?.(hint)
    })
  }

  it('opens model settings from the model menu and applies the chosen configuration', async () => {
    const original = rpc.getMockImplementation()!
    let model = 'model-a'
    rpc.mockImplementation(async (method, payload) => {
      if (method === 'agent.configuration') return { backend: 'codex', sessionId: 'session-current', source: 'session', modelId: model, modelLabel: model }
      if (method === 'agent.models') return { models: ['model-a', 'model-b'].map(id => ({ id, label: id, efforts: ['low', 'high'], defaultEffort: 'low' })) }
      if (method === 'agent.configuration.set') {
        model = (payload as { model: string }).model
        return { saved: true, backend: 'codex', sessionId: 'session-current', source: 'next-turn', modelId: model, modelLabel: model, reasoningEffort: 'high' }
      }
      return original(method, payload)
    })
    await renderConnected(null, 'codex')
    await act(async () => document.querySelector<HTMLButtonElement>('.model-trigger')!.click())
    const configure = document.querySelector<HTMLButtonElement>('.configure-model-button')!
    expect(configure.textContent).toBe('设置模型')
    await act(async () => configure.click())
    expect(document.querySelector('.settings')).not.toBeNull()
    expect(document.querySelector('.model-settings-panel')?.textContent).toContain('模型设置')
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="设置模型"]')!
      select.value = JSON.stringify(['', 'model-b']); select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="设置推理强度"]')!
      select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('.model-settings-save')!.click())
    expect(rpc).toHaveBeenCalledWith('agent.configuration.set', { sessionId: 'session-current', model: 'model-b', reasoningEffort: 'high' })
    expect(document.querySelector('.model-save-success')?.textContent).toContain('下一条消息')
  })

  it.each([['workbuddy', 'WorkBuddy'], ['cursor', 'Cursor']] as const)('selects %s, preserves its status, and shows only supported settings', async (backend, label) => {
    await renderConnected(null)
    await act(async () => { (document.querySelector('.connection') as HTMLButtonElement).click() })
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === label)!
    expect(choice).toBeDefined()
    await act(async () => { choice.click() })
    expect(panelApi.updateSettings).toHaveBeenCalledWith({ agentBackend: backend }, true)
    await act(async () => { onStatus?.('connected', null, backend) })
    expect(document.querySelector('.connection')?.textContent).toContain(label)
    expect(document.querySelector('.task-goal')).toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('.more-trigger')!.click() })
    await act(async () => { (document.querySelector('.settings-trigger') as HTMLButtonElement).click() })
    expect(document.querySelector(`[aria-label="${label}"]`)?.textContent).toContain('ACP')
  })

  it('keeps the reconnect stream suffix when history resolves late, then shows only the durable settlement', async () => {
    let finishHistory: ((history: unknown) => void) | undefined
    const historyPromise = new Promise((resolve) => { finishHistory = resolve })
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.history' ? historyPromise : original(method, payload))
    const baseline = { revision: 2, activeAttempt: {
      attemptId: 'attempt-1', turn: 0, step: 0, startedAfterSeq: 4, nextIndex: 1,
      stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [], texts: ['Hello'] }],
    } }
    await renderConnected(null)
    const emit = (method: string, payload: unknown): void => {
      onEvent?.({ t: 'event', frame: { rpcId: 'event-1', method, payload } })
    }
    await act(async () => {
      emit('session/assistant-stream', { sessionId: 'session-current', snapshotId: 'snapshot-1', frame: { type: 'snapshot', baseline } })
      emit('session/assistant-stream', { sessionId: 'session-current', frame: {
        type: 'chunk', attemptId: 'attempt-1', revision: 3, index: 1, time: 2,
        chunk: { type: 'text-delta', index: 0, text: ' world' },
      } })
    })
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Hello world')
    await act(async () => {
      emit('session/event', { sessionId: 'session-current', event: {
        type: 'assistant/message', seq: 5, surfaceOp: 'append', data: {
          turn: 0, step: 0, message: { content: [{ type: 'text', text: 'Hello world!' }] },
        },
      } })
      emit('session/assistant-stream', { sessionId: 'session-current', frame: {
        type: 'end', attemptId: 'attempt-1', revision: 4, index: 2,
        outcome: { kind: 'committed', seq: 5, eventType: 'assistant/message' },
      } })
    })
    expect(document.querySelectorAll('.row.assistant')).toHaveLength(1)
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Hello world!')
    await act(async () => { finishHistory?.({ events: [], snapshotId: 'snapshot-1', assistantStream: baseline }) })
    expect(document.querySelectorAll('.row.assistant')).toHaveLength(1)
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Hello world!')
  })

  it.each([
    { state: 'omits assistantStream', assistantStream: undefined, activeText: undefined },
    { state: 'has no active attempt', assistantStream: { revision: 4 }, activeText: undefined },
    { state: 'has a new active attempt', assistantStream: {
      revision: 6,
      activeAttempt: {
        attemptId: 'attempt-new', turn: 1, step: 0, startedAfterSeq: 5, nextIndex: 1,
        stream: [{ type: 'text-chunks', index: 0, time0: 3, dt: [], texts: ['New response in progress'] }],
      },
    }, activeText: 'New response in progress' },
  ])('replaces a cached partial response on revisit when history $state', async ({ assistantStream, activeText }) => {
    panelApi.setActiveSession = vi.fn(async () => {})
    let currentHistoryReads = 0
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => {
      if (method === 'session.history' && (payload as { sessionId: string }).sessionId === 'session-current') {
        currentHistoryReads += 1
        if (currentHistoryReads > 1) {
          return {
            events: [{ event: { type: 'assistant/message', seq: 5, surfaceOp: 'append', data: {
              turn: 0, step: 0, message: { content: [{ type: 'text', text: 'Settled while away' }] },
            } } }],
            ...(assistantStream === undefined ? {} : { assistantStream }),
          }
        }
      }
      return original(method, payload)
    })
    await renderConnected(null)
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'opening', method: 'session/assistant-stream', payload: {
        sessionId: 'session-current', snapshotId: 'old-follower',
        frame: { type: 'snapshot', baseline: { revision: 2, activeAttempt: {
          attemptId: 'attempt-old', turn: 0, step: 0, startedAfterSeq: 4, nextIndex: 1,
          stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [], texts: ['Stale partial response'] }],
        } } },
      } } })
    })
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Stale partial response')

    const selectSession = async (index: number): Promise<void> => {
      await act(async () => { document.querySelector<HTMLButtonElement>('.session-menu-trigger')!.click() })
      const sessions = document.querySelectorAll<HTMLButtonElement>('.session-list li > button:not(.session-delete)')
      expect(sessions).toHaveLength(2)
      await act(async () => { sessions[index]!.click() })
    }
    await selectSession(1)
    expect(panelApi.setActiveSession).toHaveBeenLastCalledWith('session-saved')
    expect(document.querySelector('.row.assistant')).toBeNull()

    // The old follower stops on switch; only the next history RPC reports what
    // settled while this session was inactive, before any fresh stream opening.
    await selectSession(0)
    expect(panelApi.setActiveSession).toHaveBeenLastCalledWith('session-current')
    expect(currentHistoryReads).toBe(2)
    const assistantTexts = [...document.querySelectorAll('.row.assistant')].map(row => row.textContent?.trim())
    expect(assistantTexts).toEqual([
      'Settled while away',
      ...(activeText === undefined ? [] : [activeText]),
    ])
  })

  it('keeps a session in the picker when the Host storage lock refuses deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => {
      if (method === BRIDGE_SESSION_PURGE_METHOD) throw new Error('session storage is locked')
      return original(method, payload)
    })
    await renderConnected(null)
    const menu = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    await act(async () => { menu.click() })
    const buttons = document.querySelectorAll<HTMLButtonElement>('.session-delete')
    expect(buttons).toHaveLength(2)
    await act(async () => { buttons[1]!.click() })
    expect(rpc).toHaveBeenCalledWith(BRIDGE_SESSION_PURGE_METHOD, { sessionId: 'session-saved' })
    expect(rpc.mock.calls.some(([method]) => method === 'workspace.archiveSession')).toBe(false)
    expect(document.querySelectorAll('.session-delete')).toHaveLength(2)
    expect(document.querySelector('.error')?.textContent).toContain('session storage is locked')
  })

  it('waits for the matching stream baseline when a replacement history RPC arrives first', async () => {
    await renderConnected(null)
    const emit = (snapshotId: string, baseline: unknown): void => {
      onEvent?.({ t: 'event', frame: { rpcId: 'stream', method: 'session/assistant-stream',
        payload: { sessionId: 'session-current', snapshotId, frame: { type: 'snapshot', baseline } },
      } })
    }
    await act(async () => { emit('opening', { revision: 0 }) })
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.history' ? {
      snapshotId: 'replacement', assistantStream: { revision: 4 },
      events: [{ event: { type: 'assistant/message', seq: 5, data: {
        message: { content: [{ type: 'text', text: 'Recovered response' }] },
      } } }],
    } : original(method, payload))
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'gap', method: 'session/assistant-stream', payload: {
        sessionId: 'session-current', frame: {
          type: 'chunk', attemptId: 'missing', revision: 3, index: 1,
          chunk: { type: 'text-delta', index: 0, text: 'suffix without prefix' },
        },
      } } })
    })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.history')).toHaveLength(2)
    expect(document.querySelector('.row.assistant')).toBeNull()
    await act(async () => { emit('replacement', { revision: 4 }) })
    expect(document.querySelector('.row.assistant')?.textContent?.trim()).toBe('Recovered response')
  })

  it('automatically restores only a valid contextual hint', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'session.list') {
        return { items: [
          { sessionId: 'session-page', updatedAt: 2, running: true, blank: true },
          { sessionId: 'session-global', updatedAt: 1, running: false, blank: false },
        ] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: [] }
      if (method === 'session.history') return { events: [], sessionId: (payload as { sessionId?: string }).sessionId }
      if (method === 'session.create') return { sessionId: 'session-new' }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected('session-page')

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-page') })
    expect(rpc).not.toHaveBeenCalledWith('session.create', {})
  })

  it('creates a new session for a stale hint without falling back to global history', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-global', updatedAt: 9, running: false, blank: false }] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: [] }
      if (method === 'session.create') return { sessionId: 'session-new' }
      if (method === 'session.history') return { events: [] }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected('session-missing')

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-new', true) })
    expect(panelApi.setActiveSession).not.toHaveBeenCalledWith('session-global')
  })

  it.each([
    ['archived', true, false],
    ['unreadable', false, true],
  ])('creates a new session when the contextual hint is %s', async (_case, archived, historyFails) => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-page', updatedAt: 1, running: false, blank: false }] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: archived ? ['session-page'] : [] }
      if (method === 'session.create') return { sessionId: 'session-new' }
      if (method === 'session.history') {
        if ((payload as { sessionId?: string }).sessionId === 'session-page' && historyFails) throw new Error('missing history')
        return { events: [] }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected('session-page')

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-new', true) })
    expect(panelApi.setActiveSession).not.toHaveBeenCalledWith('session-page')
  })

  it('does not scan global history when the current page has no hint', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    panelApi.setActiveSession = vi.fn(async () => {})

    await renderConnected(null)

    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true) })
    expect(rpc).not.toHaveBeenCalledWith('session.list', {})
  })

  it('waits for a fresh contextual hint after a bridge restart', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-page', updatedAt: 1, running: false, blank: false }] }
      }
      if (method === 'workspace.list') return { archivedSessionIds: [] }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.create') return { sessionId: 'session-after-restart' }
      throw new Error(`unexpected RPC: ${method}`)
    })
    panelApi.setActiveSession = vi.fn(async () => {})
    await renderConnected('session-page')
    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-page') })

    await act(async () => { onStatus?.('stopped', null, 'dsh') })
    await act(async () => { onStatus?.('connected', null, 'dsh') })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(panelApi.setActiveSession).toHaveBeenCalledTimes(1)

    await act(async () => { onResumeHint?.(null) })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-after-restart', true)
    })
  })

  it('releases the controls and surfaces an activation failure', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null, 'dsh')
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true)
    })

    const sessionMenu = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    const originalSessionTitle = sessionMenu.textContent
    await act(async () => { sessionMenu.click() })
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-list li > button:not(.session-delete)')).toHaveLength(2)
    })

    const savedSession = document.querySelectorAll<HTMLButtonElement>('.session-list li > button:not(.session-delete)')[1]
    await act(async () => { savedSession.click() })
    await vi.waitFor(() => {
      expect(document.querySelector('.error')?.textContent).toBe('runtime port unavailable')
    })

    expect(sessionMenu.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.new-session-trigger')?.disabled).toBe(false)
    expect(savedSession.disabled).toBe(false)
    expect(sessionMenu.textContent).toBe(originalSessionTitle)
  })

  it('allows starting a new session while current session is working', async () => {
    let onEventCallback: ((frame: any) => void) | undefined
    panelApi.onEvent = vi.fn((callback) => { onEventCallback = callback; return () => {} })
    panelApi.setActiveSession = vi.fn().mockResolvedValue(undefined)

    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null, 'dsh')
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true)
    })

    await act(async () => {
      onEventCallback?.({
        t: 'event',
        frame: {
          type: 'event',
          payload: {
            sessionId: 'session-current',
            event: { type: 'turn/start', seq: 1 },
          },
        },
      })
    })

    const newSessionButton = document.querySelector<HTMLButtonElement>('.new-session-trigger')!
    expect(newSessionButton.disabled).toBe(false)

    await act(async () => { newSessionButton.click() })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledTimes(2)
    })
    expect(panelApi.rebindTabAffinity).not.toHaveBeenCalled()
  })


  it('keeps the skill entry visible when not recording and reports insufficient evidence without starting extraction', async () => {
    panelApi.setActiveSession = vi.fn(async () => undefined)
    await renderConnected(null)
    await vi.waitFor(() => expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true))
    const capture = document.querySelector<HTMLButtonElement>('.skill-capture-trigger')!
    expect(capture.dataset.state).toBe('idle')
    expect(capture.querySelector('.capture-live-dot')).toBeNull()
    await act(async () => capture.click())
    expect(document.querySelector('.error')?.textContent).toContain('没有可提炼的页面操作')
    expect(capture.dataset.state).toBe('idle')
    expect(capture.getAttribute('aria-busy')).toBe('false')
    expect(rpc.mock.calls.some(([method]) => method === 'session.prompt')).toBe(false)
    await act(async () => onRecordingState?.({ phase: 'recording', recordingId: 'active' }))
    expect(capture.dataset.state).toBe('recording')
    await act(async () => onRecordingState?.({ phase: 'idle' }))
    expect(capture.dataset.state).toBe('idle')
  })

  it('does not let an older initial recorder snapshot replace a live recording update', async () => {
    let finishInitial: ((state: TeachState) => void) | undefined
    panelApi.getRecordingState = vi.fn(() => new Promise<TeachState>(resolve => { finishInitial = resolve }))
    await renderConnected(null)
    await act(async () => onRecordingState?.({ phase: 'recording', recordingId: 'live' }))
    await act(async () => finishInitial?.({ phase: 'idle' }))
    expect(document.querySelector<HTMLButtonElement>('.skill-capture-trigger')?.dataset.state).toBe('recording')
  })

  it('clears the skill processing state after a rejected prompt and allows retrying recorded actions', async () => {
    panelApi.setActiveSession = vi.fn(async () => undefined)
    await renderConnected(null)
    await vi.waitFor(() => expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true))
    await act(async () => {
      onRecordingState?.({ phase: 'recording', recordingId: 'retry' })
      onRecordingEvent?.('retry', { kind: 'click', capturedAt: Date.now(), button: 0,
        target: { tag: 'button', selector: '#query', name: '查询', control: 'button' },
        tab: { id: 1, windowId: 1, title: '业务后台', url: 'https://example.com/' }, frame: { id: 0, url: 'https://example.com/' } })
    })
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => { if (method === 'session.prompt') throw new Error('connection failed'); return original(method, payload) })
    const capture = document.querySelector<HTMLButtonElement>('.skill-capture-trigger')!
    await act(async () => capture.click())
    expect(capture.dataset.state).toBe('recording')
    expect(capture.disabled).toBe(false)
    expect(document.querySelector('.error')?.textContent).toContain('提炼请求未发送')
    await act(async () => capture.click())
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(2)
  })

  it('saves a reviewed browser-only skill after clarification and explicit UI confirmation', async () => {
    panelApi.setActiveSession = vi.fn(async () => undefined)
    await renderConnected(null)
    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true) })

    const capturedAt = Date.now()
    await act(async () => {
      onRecordingState?.({ phase: 'recording', recordingId: 'recording-1' })
      onRecordingEvent?.('recording-1', {
        kind: 'click', capturedAt, button: 0,
        target: { tag: 'button', selector: '#query', name: '查询', control: 'button' },
        tab: { id: 1, windowId: 1, title: '业务后台', url: 'https://example.com/' },
        frame: { id: 0, url: 'https://example.com/' },
      })
    })
    const capture = document.querySelector<HTMLButtonElement>('.skill-capture-trigger')!
    expect(capture.dataset.state).toBe('recording')
    expect(capture.getAttribute('aria-label')).toContain('正在记录')
    await act(async () => { capture.click(); capture.click() })
    expect(capture.dataset.state).toBe('processing')
    expect(capture.getAttribute('aria-busy')).toBe('true')
    expect(capture.disabled).toBe(true)
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(1)

    const browserSkill = {
      goal: '查询目标业务数据',
      steps: ['填写关键词', '点击查询按钮'],
      success: '页面显示查询结果',
      parameters: [{ name: 'keyword', label: '关键词', type: 'string', required: false, defaultValue: '投屏' }],
      allowedOrigins: ['https://example.com'],
      startUrl: 'https://example.com/feedback',
    }
    const emitAssistant = (seq: number, value: unknown): void => {
      onEvent?.({
        t: 'event', frame: { rpcId: `skill-${seq}`, method: 'session/event', payload: {
          sessionId: 'session-current', event: { type: 'assistant/message', seq, data: {
            message: { content: [{ type: 'text', text: `<tandix-skill-pair-json>${JSON.stringify(value)}</tandix-skill-pair-json>` }] },
          } },
        } },
      })
    }
    await act(async () => {
      emitAssistant(10, {
        schemaVersion: 'tandix.skill-pair/v1', name: '查询业务数据', browserSkill,
        desktopSkill: null, questions: ['查询结果出现是否足以判定完成？'],
      })
    })
    await vi.waitFor(() => {
      expect(capture.dataset.state).toBe('recording')
      expect(capture.getAttribute('aria-busy')).toBe('false')
      expect(document.querySelector('.chat-skill-review')?.textContent).toContain('查询结果出现是否足以判定完成？')
      expect(document.querySelector('.chat-skill-review')?.textContent).toContain('可保存、运行和下载浏览器版')
    })
    expect(document.querySelector('.skills-tab-count')?.textContent).toBe('0')
    expect(document.querySelector('.chat-skill-review')?.textContent).not.toContain('确认保存')

    const answer = document.querySelector<HTMLInputElement>('.chat-skill-question-answer')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(answer, '是')
      answer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('.skill-clarification-submit')!.click() })
    expect(JSON.stringify(rpc.mock.calls.filter(([method]) => method === 'session.prompt').at(-1)?.[1])).toContain('tandix-skill-pair-json')

    await act(async () => {
      emitAssistant(11, {
        schemaVersion: 'tandix.skill-pair/v1', name: '查询业务数据', browserSkill,
        desktopSkill: null,
        questions: [],
      })
    })
    await vi.waitFor(() => {
      expect(document.querySelector('.chat-skill-review')?.textContent).toContain('可保存、运行和下载浏览器版')
      expect(document.querySelector('.chat-skill-review')?.textContent).toContain('确认保存')
    })
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({
      'tandix.chat-skills.v1': expect.anything(),
    }))

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.chat-skill-actions-footer button')]
      .find((button) => button.textContent === '确认保存')!
    await act(async () => { confirm.click() })
    await vi.waitFor(() => {
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        'tandix.chat-skills.v1': expect.anything(),
      }))
      expect(document.querySelector('.skills-tab-count')?.textContent).toBe('1')
      expect(document.querySelector('.run-skills-workspace')?.textContent).toContain('查询业务数据')
      expect(document.querySelector<HTMLButtonElement>('.download-desktop-skill')?.disabled).toBe(false)
      expect(document.querySelector<HTMLButtonElement>('.download-desktop-skill')?.title).toContain('浏览器版技能包')
    })
  })

  it('shows recently updated chats first and backfills titles from their messages', async () => {
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => {
      if (method === 'session.list') return { items: [
        { sessionId: 'session-current', updatedAt: 2, running: false, blank: false },
        { sessionId: 'session-saved', updatedAt: 5, running: false, blank: false },
      ] }
      if (method === 'session.history' && (payload as { sessionId: string }).sessionId === 'session-saved') {
        return { events: [{ event: { type: 'user/message', data: { message: {
          source: { kind: 'user' }, content: [{ type: 'text', text: '核对飞书周报的商店数据' }],
        } } } }] }
      }
      return original(method, payload)
    })
    await renderConnected(null)
    await act(async () => { document.querySelector<HTMLButtonElement>('.session-menu-trigger')!.click() })
    const labels = [...document.querySelectorAll<HTMLButtonElement>('.session-list li > button:not(.session-delete)')]
      .map((button) => button.textContent?.trim())
    expect(labels[0]).toContain('核对飞书周报的商店数据')
    expect(labels[1]).toContain('Chat · -current')
  })

  it('retries an explicit save-skill request once, then reports that it was not saved', async () => {
    panelApi.setActiveSession = vi.fn(async () => {})
    await renderConnected(null)
    const composer = document.querySelector<HTMLTextAreaElement>('footer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(composer, '总结成技能保存下来')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('footer button[aria-label="发送消息"]')?.click() })
    expect(rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({
      sessionId: 'session-current', tandixSkillSaveIntent: true,
    }))
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'ending', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 1 } },
      } } })
    })
    expect(rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({
      sessionId: 'session-current', tandixSkillSaveIntent: true,
      content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('tandix_skill_save') })]),
    }))
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(2)
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'retry-ending', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 2 } },
      } } })
    })
    expect(document.querySelector('.error')?.textContent).toContain('重试后仍未收到')
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(2)
  })

  it('saves a valid structured skill response even when the agent did not call the tool', async () => {
    panelApi.setActiveSession = vi.fn(async () => {})
    await renderConnected(null, 'codex')
    const composer = document.querySelector<HTMLTextAreaElement>('footer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(composer, '总结成技能保存下来')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('footer button[aria-label="发送消息"]')?.click() })
    const draft = { name: '鸿蒙周报', description: '写鸿蒙周报时使用', instructions: '对照两期数据并核对差值。' }
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'answer', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'assistant/message', data: { message: { content: [
          { type: 'text', text: `<tandix-skill-save-json>${JSON.stringify(draft)}</tandix-skill-save-json>` },
        ] } } },
      } } })
      onEvent?.({ t: 'event', frame: { rpcId: 'ending', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 1 } },
      } } })
    })
    const stored = await chrome.storage.local.get('tandix.managed-skills.v1')
    expect((stored['tandix.managed-skills.v1'] as { name: string }[])[0]?.name).toBe('鸿蒙周报')
    expect(document.querySelector('.run-skills-list[aria-label="技能列表"]')?.textContent).toContain('鸿蒙周报')
    expect(document.querySelector('.skills-tab-count')?.textContent).toBe('1')
    expect(document.querySelector('.error')?.textContent ?? '').not.toContain('尚未保存')
  })

  it('saves a structured skill returned by the one-time recovery turn', async () => {
    panelApi.setActiveSession = vi.fn(async () => {})
    await renderConnected(null)
    const composer = document.querySelector<HTMLTextAreaElement>('footer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(composer, '总结成技能保存下来')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('footer button[aria-label="发送消息"]')?.click() })
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'ending', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 1 } },
      } } })
    })
    const draft = { name: '鸿蒙周报', description: '写鸿蒙周报时使用', instructions: '对照两期数据并核对差值。' }
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'recovered-answer', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'assistant/message', data: { message: { content: [
          { type: 'text', text: `<tandix-skill-save-json>${JSON.stringify(draft)}</tandix-skill-save-json>` },
        ] } } },
      } } })
      onEvent?.({ t: 'event', frame: { rpcId: 'retry-ending', method: 'session/event', payload: {
        sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 2 } },
      } } })
    })
    const stored = await chrome.storage.local.get('tandix.managed-skills.v1')
    expect((stored['tandix.managed-skills.v1'] as { name: string }[])[0]?.name).toBe('鸿蒙周报')
    expect(document.querySelector('.error')?.textContent ?? '').not.toContain('尚未保存')
  })
})
