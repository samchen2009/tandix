// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { PanelApi } from '../src/panel/api.ts'
import type { PageSelection } from '../src/selection.ts'
import { selectionPromptText } from '../src/panel/selection.ts'

let panelApi: PanelApi

// Keep the real module's exports: the panel's error mapping uses PanelRpcError.
vi.mock('../src/panel/api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/panel/api.ts')>(),
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

const selection: PageSelection = {
  text: 'dsh plugin: Chrome sidebar extension',
  truncated: false,
  title: 'Lum1104/dsh-browser',
  url: 'https://github.com/Lum1104/dsh-browser',
  capturedAt: 1_000,
}

describe('attaching a page selection in the composer', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null, backend?: 'dsh' | 'codex') => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onSelection: ((selection: PageSelection | null) => void) | undefined
  let onEvent: ((frame: ServerFrame) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>
  let currentGoal: Record<string, unknown> | null
  let failGoalStart: boolean

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    currentGoal = null
    failGoalStart = false
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })

    rpc = vi.fn(async (method: string, payload?: unknown) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.prompt') {
        const text = (payload as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? ''
        if (failGoalStart && text.includes('Begin working on it now')) throw new Error('bridge unavailable')
        return {}
      }
      if (method === 'session.cancel') return { cancelled: true }
      if (method === 'goal.get') return { goal: currentGoal }
      if (method === 'goal.create') {
        const request = payload as { objective: string; budgetLimit: number }
        currentGoal = { status: 'active', objective: request.objective,
          budgetKind: request.budgetLimit === 30000 ? 'tokens' : 'rounds',
          budgetLimit: request.budgetLimit, budgetUsed: 0 }
        return { goal: currentGoal }
      }
      if (method === 'goal.pause') {
        currentGoal = { ...currentGoal, status: 'paused' }
        return { goal: currentGoal }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> => await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback; return unsubscribe }),
      onEvent: vi.fn((callback) => { onEvent = callback; return unsubscribe }),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn((callback) => { onSelection = callback; return unsubscribe }),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn(async () => {}),
      updateSettings: vi.fn(async () => {}),
    requestStatus: vi.fn(async () => {}),
    onRecordingState: vi.fn(() => () => {}),
    onRecordingEvent: vi.fn(() => () => {}),
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

  async function startPanel(backend: 'dsh' | 'codex' = 'dsh'): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null, backend)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => { expect(rpc).toHaveBeenCalledWith('session.create', {}) })
  }

  async function typeInto(selector: string, text: string): Promise<void> {
    const textarea = document.querySelector<HTMLTextAreaElement>(selector)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function showUserMessage(text: string, images: unknown[] = []): Promise<void> {
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'user/message', data: {
        message: { source: { kind: 'user' }, content: [{ type: 'text', text }, ...images] },
      } },
    } } } as ServerFrame) })
  }

  it('unlocks after stopping an unresolved send and isolates a resend from its late response', async () => {
    await startPanel('codex')
    const original = rpc.getMockImplementation()!
    let rejectOld: ((cause: Error) => void) | undefined
    let acceptResend: (() => void) | undefined
    let prompts = 0
    rpc.mockImplementation(async (method, payload) => {
      if (method === 'session.prompt') {
        prompts += 1
        if (prompts === 1) return new Promise((_resolve, reject) => { rejectOld = reject })
        if (prompts === 2) return new Promise<void>((resolve) => { acceptResend = resolve })
        return {}
      }
      return original(method, payload)
    })
    await typeInto('.composer textarea', 'Original request')
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions-end > button')!.click() })
    await showUserMessage('Original request')
    expect(document.querySelector<HTMLButtonElement>('.message-edit-button')?.disabled).toBe(true)
    await act(async () => { document.querySelector<HTMLButtonElement>('.stop-button')!.click() })

    expect(document.querySelector<HTMLTextAreaElement>('.composer textarea')?.disabled).toBe(false)
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-edit-button')!.click() })
    await typeInto('.message-editor textarea', 'Revised request')
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')!.click() })
    expect(prompts).toBe(2)
    await act(async () => { rejectOld?.(new Error('late cancellation')) })
    expect(document.querySelector<HTMLTextAreaElement>('.composer textarea')?.disabled).toBe(true)
    expect(document.querySelector('.error')).toBeNull()

    // Cancelling a resend also releases its editor, even if its RPC never ends.
    await act(async () => { document.querySelector<HTMLButtonElement>('.stop-button')!.click() })
    expect(document.querySelector<HTMLTextAreaElement>('.message-editor textarea')?.value).toBe('Revised request')
    expect(document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')?.disabled).toBe(false)
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')!.click() })
    expect(prompts).toBe(3)
    expect(document.querySelector('.message-editor')).toBeNull()
    await act(async () => { acceptResend?.() })
    expect(document.querySelector('.error')).toBeNull()
  })

  it('resends the edited text with its original quote and image, preserving the current composer draft', async () => {
    await startPanel()
    const image = { attachmentId: 'image-original', mediaType: 'image/png', bytes: 3, width: 10, height: 10, name: 'table.png' }
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.attachment'
      ? { attachment: image, data: 'AQID' } : original(method, payload))
    await showUserMessage(selectionPromptText(selection, 'Original question'), [{ type: 'image', attachment: image }])
    const newer = { ...selection, text: 'New highlight', capturedAt: 3_000 }
    await act(async () => { onSelection?.(newer) })
    await typeInto('.composer textarea', 'Unsent draft')
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-edit-button')!.click() })
    expect(document.querySelector<HTMLTextAreaElement>('.message-editor textarea')?.value).toBe('Original question')
    await typeInto('.message-editor textarea', 'Revised question')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')!.click()
      document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')!.click()
    })

    const calls = rpc.mock.calls.filter(([method]) => method === 'session.prompt')
    expect(calls).toHaveLength(1)
    const content = (calls[0]![1] as { content: Array<Record<string, unknown>> }).content
    expect(content[0]?.text).toContain(selection.text)
    expect(content[0]?.text).toContain('<UNTRUSTED_PAGE_CONTENT nonce="')
    expect((content[0]?.text as string).endsWith('Revised question')).toBe(true)
    expect(content[0]?.text).not.toContain('New highlight')
    expect(content[1]).toEqual({ type: 'image', mediaType: 'image/png', data: 'AQID', name: 'table.png' })
    expect(document.querySelector('.message-editor')).toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('.composer textarea')?.value).toBe('Unsent draft')
    expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(newer.text)
    expect(panelApi.clearSelection).not.toHaveBeenCalled()
    expect(document.querySelector('.row.user')?.textContent).toContain('Original question')
  })

  it('retains failed edits for retry and lets Escape discard an edit without changing history', async () => {
    await startPanel()
    await showUserMessage('Original request')
    const original = rpc.getMockImplementation()!
    let rejectPrompt = true
    rpc.mockImplementation(async (method, payload) => {
      if (method === 'session.prompt' && rejectPrompt) throw new Error('bridge unavailable')
      return original(method, payload)
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-edit-button')!.click() })
    await typeInto('.message-editor textarea', 'Keep this revision')
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')!.click() })
    expect(document.querySelector<HTMLTextAreaElement>('.message-editor textarea')?.value).toBe('Keep this revision')
    expect(document.querySelector('.error')?.textContent).toContain('bridge unavailable')
    rejectPrompt = false
    await act(async () => { document.querySelector<HTMLTextAreaElement>('.message-editor textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(document.querySelector('.message-editor')).toBeNull()
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(2)
    await act(async () => { document.querySelector<HTMLButtonElement>('.stop-button')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-edit-button')!.click() })
    await typeInto('.message-editor textarea', 'Discard this revision')
    await act(async () => { document.querySelector<HTMLTextAreaElement>('.message-editor textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('.message-editor')).toBeNull()
    expect(document.querySelector('.row.user')?.textContent).toContain('Original request')
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(2)
  })

  it('keeps an image edit intact when the original attachment cannot be loaded', async () => {
    await startPanel()
    const image = { attachmentId: 'unavailable', mediaType: 'image/png', bytes: 3, width: 10, height: 10 }
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.attachment' ? {} : original(method, payload))
    await showUserMessage('Look at this image', [{ type: 'image', attachment: image }])
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-edit-button')!.click() })
    await typeInto('.message-editor textarea', 'Revised image question')
    await act(async () => { document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')!.click() })
    expect(document.querySelector<HTMLTextAreaElement>('.message-editor textarea')?.value).toBe('Revised image question')
    expect(document.querySelector('.error')).not.toBeNull()
    expect(rpc.mock.calls.filter(([method]) => method === 'session.prompt')).toHaveLength(0)
    expect(document.querySelector<HTMLButtonElement>('.message-editor button[type="submit"]')?.disabled).toBe(false)
  })

  it.each(['codex', 'dsh'] as const)('asks %s for a draft, then starts a goal only after review', async (backend) => {
    await startPanel(backend)
    await act(async () => { document.querySelector<HTMLButtonElement>('.attachment-button')!.click() })
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.attachment-menu button')].find(button => /设定任务目标|Set task goal/u.test(button.textContent ?? ''))!.click() })
    const task = document.querySelector<HTMLTextAreaElement>('.task-goal-form textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(task, 'Edit the report')
      task.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('.task-goal-form > button')!.click() })
    const prompt = rpc.mock.calls.find(([method]) => method === 'session.prompt')?.[1] as {
      content: { type: string; text: string }[]
    }
    expect(prompt.content[0]?.text).toContain('Edit the report')
    expect(prompt.content[0]?.text).toContain('planning-only turn')
    expect(rpc.mock.calls.some(([method]) => method === 'goal.create')).toBe(false)

    const budgetLimit = backend === 'codex' ? 30000 : 12
    const draft = JSON.stringify({ kind: 'tandix.goal-draft/v2', outcome: 'Edit the report',
      verification: 'Reread the document', constraints: '', boundaries: 'Only edit this report',
      iterationPolicy: 'Check after each change', blockedStop: 'Ask if access fails', budgetLimit })
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: draft }] } } },
    } } } as ServerFrame) })
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 1 } },
    } } } as ServerFrame) })
    expect(document.querySelectorAll('.task-goal-form textarea')).toHaveLength(7)
    expect(document.querySelector('.task-goal-review-note')?.textContent).toMatch(/Agent|agent/u)
    expect(rpc.mock.calls.some(([method]) => method === 'goal.create')).toBe(false)

    await act(async () => { document.querySelector<HTMLButtonElement>('.task-goal-form > button.primary')!.click() })
    expect(rpc).toHaveBeenCalledWith('goal.create', expect.objectContaining({
      sessionId: 'session-current', budgetLimit,
      objective: expect.stringContaining('Completion evidence: Reread the document'),
    }))
    const createIndex = rpc.mock.calls.findIndex(([method]) => method === 'goal.create')
    const firstTurnIndex = rpc.mock.calls.findIndex(([method, payload]) => method === 'session.prompt'
      && (payload as { content: Array<{ text: string }> }).content[0]?.text.includes('Begin working on it now'))
    expect(firstTurnIndex).toBeGreaterThan(createIndex)
    expect((rpc.mock.calls[firstTurnIndex]?.[1] as { content: Array<{ text: string }> }).content[0]?.text)
      .toContain('Edit the report')
    expect(document.querySelector('.task-goal')?.textContent).toContain('Edit the report')
    expect(document.querySelector('.task-goal [role="status"]')?.textContent).toMatch(/正在执行|Working/u)
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 2 } },
    } } } as ServerFrame) })
    expect(document.querySelector('.task-goal [role="status"]')?.textContent).toMatch(/本轮已结束|Turn ended/u)
    const continueButton = [...document.querySelectorAll<HTMLButtonElement>('.task-goal-actions button')]
      .find((button) => /继续|Resume/u.test(button.textContent ?? ''))
    expect(continueButton).toBeDefined()
    await act(async () => { continueButton!.click() })
    expect(rpc.mock.calls.some(([method, payload]) => method === 'session.prompt'
      && (payload as { content: Array<{ text: string }> }).content[0]?.text.includes('latest evidence'))).toBe(true)
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'turn/start', data: { turn: 1 } },
    } } } as ServerFrame) })
    await act(async () => { document.querySelector<HTMLButtonElement>('.stop-button')!.click() })
    const pauseIndex = rpc.mock.calls.findIndex(([method]) => method === 'goal.pause')
    const cancelIndex = rpc.mock.calls.findIndex(([method]) => method === 'session.cancel')
    expect(pauseIndex).toBeGreaterThan(-1)
    expect(cancelIndex).toBeGreaterThan(pauseIndex)
  })

  it('keeps an activated Goal and offers a deliberate retry when its first prompt fails', async () => {
    await startPanel('codex')
    await act(async () => { document.querySelector<HTMLButtonElement>('.attachment-button')!.click() })
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.attachment-menu button')].find(button => /设定任务目标|Set task goal/u.test(button.textContent ?? ''))!.click() })
    const task = document.querySelector<HTMLTextAreaElement>('.task-goal-form textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(task, 'Edit the report')
      task.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('.task-goal-form > button')!.click() })
    const draft = JSON.stringify({ kind: 'tandix.goal-draft/v2', outcome: 'Edit the report',
      verification: 'Reread the document', constraints: '', boundaries: 'Only edit this report',
      iterationPolicy: 'Check after each change', blockedStop: 'Ask if access fails', budgetLimit: 30000 })
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: draft }] } } },
    } } } as ServerFrame) })
    await act(async () => { onEvent?.({ t: 'event', frame: { rpcId: '', method: 'session/event', payload: {
      sessionId: 'session-current', event: { type: 'turn/end', data: { turn: 1 } },
    } } } as ServerFrame) })
    failGoalStart = true
    await act(async () => { document.querySelector<HTMLButtonElement>('.task-goal-form > button.primary')!.click() })
    expect(document.querySelector('.task-goal [role="status"]')?.textContent).toMatch(/首轮未启动|did not start/u)
    expect(document.querySelector('.task-goal [role="alert"]')?.textContent).toContain('bridge unavailable')
    expect(rpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
    failGoalStart = false
    await act(async () => { document.querySelector<HTMLButtonElement>('.task-goal-actions button')!.click() })
    expect(rpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
    expect(document.querySelector('.task-goal [role="alert"]')).toBeNull()
  })

  it('shows the captured quote and sends it with the typed message', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(selection.text)
    expect(document.querySelector('.composer-box .page-selection-source')?.textContent).toBe(selection.title)

    const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(composer, 'summarize this')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions-end > button')!.click() })

    const prompt = rpc.mock.calls.find(([method]) => method === 'session.prompt')?.[1] as {
      content: { type: string; text: string }[]
    }
    expect(prompt.content[0]?.text).toContain('<UNTRUSTED_PAGE_CONTENT nonce="')
    expect(prompt.content[0]?.text).toContain(selection.text)
    expect(prompt.content[0]?.text.endsWith('summarize this')).toBe(true)

    // Sending consumes the quote here and in every other open panel.
    await vi.waitFor(() => { expect(document.querySelector('.composer-box .page-selection')).toBeNull() })
    expect(panelApi.clearSelection).toHaveBeenCalledWith(selection)
  })

  it('sends a selection that carries no typed message', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    const send = document.querySelector<HTMLButtonElement>('.composer-actions-end > button')!
    expect(send.disabled).toBe(false)
    await act(async () => { send.click() })

    expect(rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-current' }))
  })

  it('drops the quote when the user dismisses it', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    const remove = document.querySelector<HTMLButtonElement>('.page-selection-chip button')!
    await act(async () => { remove.click() })

    expect(document.querySelector('.composer-box .page-selection')).toBeNull()
    expect(panelApi.clearSelection).toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('.composer-actions-end > button')?.disabled).toBe(true)
  })

  it('restores the quote when the prompt is rejected', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.prompt') throw new Error('bridge unavailable')
      return {}
    })

    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions-end > button')!.click() })

    await vi.waitFor(() => {
      expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(selection.text)
    })
    expect(document.querySelector('.error')?.textContent).toContain('bridge unavailable')
    expect(panelApi.clearSelection).not.toHaveBeenCalled()
  })

  it('does not consume a newer highlight when an earlier send succeeds', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })
    let acceptPrompt: (() => void) | undefined
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.prompt') {
        await new Promise<void>((resolve) => { acceptPrompt = resolve })
        return {}
      }
      return {}
    })

    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions-end > button')!.click() })
    await vi.waitFor(() => { expect(acceptPrompt).toBeDefined() })
    const newer = { ...selection, text: 'newer highlight', capturedAt: 2_000 }
    await act(async () => { onSelection?.(newer) })
    await act(async () => { acceptPrompt?.() })

    await vi.waitFor(() => { expect(panelApi.clearSelection).toHaveBeenCalledWith(selection) })
    expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(newer.text)
  })

  it('preserves a highlight captured while automatic restoration loads history', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    let finishHistory: ((value: { events: never[] }) => void) | undefined
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-saved', updatedAt: 1, running: false, blank: false }] }
      }
      if (method === 'session.history') {
        return await new Promise<{ events: never[] }>((resolve) => { finishHistory = resolve })
      }
      return {}
    })

    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.('session-saved')
    })
    await vi.waitFor(() => { expect(finishHistory).toBeDefined() })
    await act(async () => { onSelection?.(selection) })
    await act(async () => { finishHistory?.({ events: [] }) })

    await vi.waitFor(() => {
      expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(selection.text)
    })
    expect(panelApi.clearSelection).not.toHaveBeenCalled()
  })

  it('clears the attachment when the user explicitly starts a new session', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    await act(async () => { document.querySelector<HTMLButtonElement>('.new-session-trigger')!.click() })

    await vi.waitFor(() => { expect(panelApi.clearSelection).toHaveBeenCalledWith() })
    expect(document.querySelector('.composer-box .page-selection')).toBeNull()
  })
})
