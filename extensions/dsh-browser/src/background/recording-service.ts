import { listTabFrames } from './frames.ts'
import {
  parseDomCaptureEvent,
  parseNetworkResponseCapture,
  sanitizeRecordedUrl,
  type BrowserRecording,
  type DomCaptureEvent,
  type RecordingEventInput,
  type RecordingMetadata,
  type RecordingTarget,
  type TabDescriptor,
} from '../recording/schema.ts'
import { authenticationEvidence, requestEvidence, type RecentFormValue } from '../recording/network-contract.ts'
import { installNetworkContractProbe } from '../content/network-contract-probe.ts'
import { newRecording, type RecordingStore } from '../recording/store.ts'
import {
  INITIAL_TEACH_STATE,
  reduceTeachState,
  type TeachState,
  type TeachTransition,
} from '../recording/state-machine.ts'

export interface RecordingExport {
  filename: string
  mimeType: 'application/json' | 'application/x-ndjson'
  content: string
}

type BrowserEventInput =
  | Omit<Extract<RecordingEventInput, { kind: 'tab' }>, 'tab' | 'frame'>
  | Omit<Extract<RecordingEventInput, { kind: 'navigation' }>, 'tab' | 'frame'>

function safeUrl(value: string | undefined): string {
  if (value === undefined) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

/** Never persist URL credentials, query parameters, or fragments from a request. */
function safeNetworkUrl(value: string): string {
  const safe = safeUrl(value)
  if (safe === '') return ''
  const url = new URL(safe)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

function httpOrigin(value: string): string {
  const safe = safeUrl(value)
  return safe === '' ? '' : new URL(safe).origin
}

function tabDescriptor(tab: chrome.tabs.Tab): TabDescriptor | null {
  if (tab.id === undefined) return null
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: (tab.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    url: safeUrl(tab.url),
  }
}

export class RecordingService {
  private state: TeachState = INITIAL_TEACH_STATE
  private active: RecordingMetadata | null = null
  private readonly lastAction = new Map<number, DomCaptureEvent>()
  private readonly recentFormValues = new Map<number, RecentFormValue[]>()
  private readonly recentClicks = new Map<number, {
    capturedAt: number; target: RecordingTarget; frameId: number; tab: TabDescriptor
  }>()
  private readonly activeDownloads = new Map<number, {
    tabId: number; trigger: RecordingTarget; association: 'link' | 'recent-click'; frameId: number
  }>()
  private readonly pendingRequests = new Map<string, {
    tabId: number; frameId: number; url: string; method: string; startedAt: number
    request: ReturnType<typeof requestEvidence> & { auth: ReturnType<typeof authenticationEvidence> }
  }>()
  readonly ready: Promise<void>

  constructor(
    private readonly store: RecordingStore,
    private readonly onState: (state: TeachState) => void,
    private readonly onEvent: (recordingId: string, event: RecordingEventInput, windowId: number) => void = () => {},
  ) {
    this.ready = this.restore()
  }

  snapshot(): TeachState {
    return this.state
  }

  shouldRecordTab(tabId: number): boolean {
    return this.state.phase === 'recording' && this.active?.status === 'recording' && this.active.tabIds.includes(tabId)
  }

  async start(windowId?: number): Promise<TeachState> {
    await this.ready
    if (this.active !== null) return this.state
    if (this.state.phase === 'arming') return this.state
    this.transition({ type: 'START_REQUESTED' })
    try {
      const tabs = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { lastFocusedWindow: true } : { windowId }) })
      const tab = tabs[0]
      if (tab === undefined || tab.id === undefined || safeUrl(tab.url) === '') {
        throw new Error('Open an HTTP(S) page before starting a Tandix recording')
      }
      const recording = newRecording(tab)
      this.lastAction.clear()
      this.recentFormValues.clear()
      this.recentClicks.clear()
      this.activeDownloads.clear()
      this.pendingRequests.clear()
      await this.store.create(recording)
      this.active = recording
      this.transition({ type: 'STARTED', recording })
      await this.appendBrowserEvent(tab, {
        kind: 'tab',
        action: 'initial',
        capturedAt: recording.startedAt,
      })
      await this.armTab(tab.id, recording.id, true)
      return this.state
    } catch (cause) {
      this.transition({ type: 'FAILED', message: cause instanceof Error ? cause.message : String(cause) })
      throw cause
    }
  }

  async stop(): Promise<TeachState> {
    await this.ready
    if (this.active === null) return this.state
    if (this.state.phase === 'stopping') return this.state
    this.transition({ type: 'STOP_REQUESTED' })
    const current = this.active
    try {
      await Promise.all(current.tabIds.map((tabId) => this.armTab(tabId, current.id, false)))
      const finished = await this.store.finish(current.id, Date.now())
      this.lastAction.clear()
      this.recentFormValues.clear()
      this.recentClicks.clear()
      this.activeDownloads.clear()
      this.pendingRequests.clear()
      this.active = null
      this.transition({ type: 'STOPPED', recording: finished })
      return this.state
    } catch (cause) {
      this.transition({ type: 'FAILED', message: cause instanceof Error ? cause.message : String(cause) })
      throw cause
    }
  }

  async captureDom(value: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
    await this.ready
    const recording = this.active
    const tab = sender.tab
    if (this.state.phase !== 'recording' || recording === null || tab?.id === undefined || !recording.tabIds.includes(tab.id)) return
    const capture = parseDomCaptureEvent(value)
    const descriptor = tabDescriptor(tab)
    if (capture === null || descriptor === null) return
    this.lastAction.set(tab.id, capture)
    if (capture.kind === 'input' || capture.kind === 'change' || capture.kind === 'select') {
      const values = this.recentFormValues.get(tab.id) ?? []
      values.push({ capturedAt: capture.capturedAt, event: capture })
      this.recentFormValues.set(tab.id, values.filter((entry) => capture.capturedAt - entry.capturedAt <= 10 * 60_000).slice(-100))
    }
    if (capture.kind === 'click' && capture.button === 0) {
      this.recentClicks.set(tab.id, {
        capturedAt: capture.capturedAt,
        target: capture.target,
        frameId: sender.frameId ?? 0,
        tab: descriptor,
      })
    }
    const input: RecordingEventInput = {
      ...capture,
      tab: descriptor,
      frame: { id: sender.frameId ?? 0, url: safeUrl(sender.url) || descriptor.url },
    }
    const next = await this.store.append(recording.id, input)
    if (this.state.phase !== 'recording' || this.active?.id !== recording.id) return
    this.active = next
    this.transition({ type: 'EVENT_APPENDED', recording: next })
    this.onEvent(recording.id, input, descriptor.windowId)
  }

  /** Capture a bounded, redacted request contract; credential values never cross the boundary. */
  observeNetworkStart(details: {
    requestId: string; tabId: number; frameId: number; url: string; method: string; timeStamp: number; type: string
    requestBody?: chrome.webRequest.WebRequestBodyDetails['requestBody']
  }): void {
    if (!this.shouldRecordTab(details.tabId) || details.type !== 'xmlhttprequest') return
    const url = safeNetworkUrl(details.url)
    if (url === '') return
    this.pendingRequests.set(details.requestId, {
      tabId: details.tabId,
      frameId: details.frameId,
      url,
      method: details.method.slice(0, 12),
      startedAt: details.timeStamp,
      request: {
        ...requestEvidence(details.url, details.requestBody, this.recentFormValues.get(details.tabId) ?? []),
        auth: { kind: 'unknown' },
      },
    })
  }

  /** Detect only the authentication mechanism; header names/values are never stored. */
  observeNetworkHeaders(details: { requestId: string; requestHeaders?: chrome.webRequest.HttpHeader[] }): void {
    const request = this.pendingRequests.get(details.requestId)
    if (request === undefined) return
    request.request.auth = authenticationEvidence(details.requestHeaders)
  }

  async observeNetworkEnd(details: {
    requestId: string; tabId: number; timeStamp: number; statusCode?: number; error?: string
  }): Promise<void> {
    const request = this.pendingRequests.get(details.requestId)
    if (request === undefined) return
    this.pendingRequests.delete(details.requestId)
    await this.ready
    const recording = this.active
    if (recording === null || !this.shouldRecordTab(request.tabId)) return
    const action = this.lastAction.get(request.tabId)
    const lag = action === undefined ? Infinity : request.startedAt - action.capturedAt
    if (lag < -1_000 || lag > 10_000) return
    try {
      const tab = await chrome.tabs.get(request.tabId)
      const descriptor = tabDescriptor(tab)
      if (descriptor === null) return
      const input: RecordingEventInput = {
        kind: 'network',
        capturedAt: details.timeStamp,
        tab: descriptor,
        frame: { id: request.frameId, url: descriptor.url },
        url: request.url,
        method: request.method,
        durationMs: Math.max(0, Math.round(details.timeStamp - request.startedAt)),
        request: request.request,
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
        ...(details.error === undefined ? {} : { failed: true }),
        ...(action === undefined ? {} : { trigger: { kind: action.kind, target: action.target } }),
      }
      const next = await this.store.append(recording.id, input)
      if (this.active?.id !== recording.id || this.state.phase !== 'recording') return
      this.active = next
      this.transition({ type: 'EVENT_APPENDED', recording: next })
      this.onEvent(recording.id, input, descriptor.windowId)
    } catch {
      // The request may finish after its tab closes or recording stops.
    }
  }

  /** Store a value-free response schema reported by the main-world fetch/XHR probe. */
  async captureNetworkResponse(value: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
    await this.ready
    const capture = parseNetworkResponseCapture(value)
    const recording = this.active
    const tab = sender.tab
    if (capture === null || recording === null || capture.recordingId !== recording.id
      || tab?.id === undefined || !this.shouldRecordTab(tab.id)) return
    const url = safeNetworkUrl(capture.url)
    const descriptor = tabDescriptor(tab)
    if (url === '' || descriptor === null) return
    const action = this.lastAction.get(tab.id)
    if (action === undefined || capture.capturedAt - action.capturedAt < -1_000
      || capture.capturedAt - action.capturedAt > 15_000) return
    const input: RecordingEventInput = {
      kind: 'network-response',
      capturedAt: capture.capturedAt,
      tab: descriptor,
      frame: { id: sender.frameId ?? 0, url: safeUrl(sender.url) || descriptor.url },
      url,
      method: capture.method,
      statusCode: capture.statusCode,
      response: { fields: capture.fields, listPaths: capture.listPaths },
    }
    const next = await this.store.append(recording.id, input)
    if (this.active?.id !== recording.id || this.state.phase !== 'recording') return
    this.active = next
    this.transition({ type: 'EVENT_APPENDED', recording: next })
    this.onEvent(recording.id, input, descriptor.windowId)
  }

  /** Downloads have no tab id; associate only a recent, in-scope user click. */
  async observeDownloadCreated(item: chrome.downloads.DownloadItem): Promise<void> {
    await this.ready
    const recording = this.active
    if (recording === null || this.state.phase !== 'recording') return
    const startedAt = Date.parse(item.startTime) || Date.now()
    const referrerOrigin = httpOrigin(item.referrer)
    const click = [...this.recentClicks.entries()]
      .filter(([tabId, recent]) => recording.tabIds.includes(tabId)
        && startedAt - recent.capturedAt >= -500 && startedAt - recent.capturedAt <= 5_000
        && (referrerOrigin === '' || httpOrigin(recent.tab.url) === referrerOrigin))
      .sort((left, right) => right[1].capturedAt - left[1].capturedAt)[0]
    if (click === undefined) return
    const [tabId, recent] = click
    const source = sanitizeRecordedUrl(item.url)
    const association = recent.target.href !== undefined && recent.target.href === source.url
      ? 'link' : 'recent-click'
    this.activeDownloads.set(item.id, { tabId, trigger: recent.target, association, frameId: recent.frameId })
    await this.appendDownloadEvent(item, 'started', tabId, recent.frameId, recent.target, association)
  }

  async observeDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    const tracked = this.activeDownloads.get(delta.id)
    if (tracked === undefined) return
    const state = delta.state?.current
    if (state !== 'complete' && state !== 'interrupted' && delta.filename?.current === undefined) return
    try {
      const [item] = await chrome.downloads.search({ id: delta.id })
      if (item === undefined) return
      await this.appendDownloadEvent(item, state === 'complete' || state === 'interrupted' ? state : 'started',
        tracked.tabId, tracked.frameId, tracked.trigger, tracked.association)
    } catch {
      // The browser can remove an item while its metadata is changing.
    }
    if (state === 'complete' || state === 'interrupted') this.activeDownloads.delete(delta.id)
  }

  private async appendDownloadEvent(
    item: chrome.downloads.DownloadItem,
    state: 'started' | 'complete' | 'interrupted',
    tabId: number,
    frameId: number,
    trigger: RecordingTarget,
    association: 'link' | 'recent-click',
  ): Promise<void> {
    const recording = this.active
    if (recording === null || !this.shouldRecordTab(tabId)) return
    let tab: chrome.tabs.Tab
    try { tab = await chrome.tabs.get(tabId) } catch { return }
    const descriptor = tabDescriptor(tab)
    if (descriptor === null) return
    const source = sanitizeRecordedUrl(item.url)
    const final = sanitizeRecordedUrl(item.finalUrl)
    const filename = item.filename.split(/[\\/]/).at(-1)?.slice(0, 240) || ''
    const input: RecordingEventInput = {
      kind: 'download',
      capturedAt: Date.now(),
      tab: descriptor,
      frame: { id: frameId, url: descriptor.url },
      downloadId: item.id,
      url: source.url,
      ...(final.url !== '' && final.url !== source.url ? { finalUrl: final.url } : {}),
      ...(source.hadHiddenQuery || final.hadHiddenQuery ? { urlHasHiddenQuery: true } : {}),
      ...(filename === '' ? {} : { filename }),
      state,
      association,
      trigger,
    }
    const next = await this.store.append(recording.id, input)
    if (this.active?.id !== recording.id || this.state.phase !== 'recording') return
    this.active = next
    this.transition({ type: 'EVENT_APPENDED', recording: next })
    this.onEvent(recording.id, input, descriptor.windowId)
  }

  async observeActivation(tabId: number, windowId: number, previousTabId?: number): Promise<void> {
    await this.ready
    const recording = this.active
    if (recording === null || recording.windowId !== windowId) return
    try {
      const tab = await chrome.tabs.get(tabId)
      if (safeUrl(tab.url) === '') return
      const wasTracked = recording.tabIds.includes(tabId)
      const next = await this.store.addTab(recording.id, tabId)
      if (this.state.phase !== 'recording' || this.active?.id !== recording.id) return
      this.active = next
      await this.appendBrowserEvent(tab, {
        kind: 'tab',
        action: 'activated',
        capturedAt: Date.now(),
        ...(previousTabId === undefined ? {} : { previousTabId }),
      })
      // The destination can finish loading before it becomes active; in that
      // ordering onCommitted ran before this tab joined the recording.
      if (!wasTracked) await this.appendBrowserEvent(tab, {
        kind: 'navigation',
        capturedAt: Date.now(),
        url: safeUrl(tab.url),
        transitionType: 'activated-tab',
      })
      await this.armTab(tabId, recording.id, true)
    } catch {
      // Tabs can disappear between activation and metadata lookup.
    }
  }

  async observeTabUpdate(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): Promise<void> {
    await this.ready
    if (this.active === null) return
    if (!this.active.tabIds.includes(tabId)) {
      // A newly opened tab often activates while still about:blank. Enroll it
      // once its first HTTP(S) URL arrives, so the first navigation is kept.
      if (changeInfo.url !== undefined && tab.active && tab.windowId === this.active.windowId) {
        await this.observeActivation(tabId, tab.windowId)
      }
      return
    }
    if (changeInfo.title === undefined && changeInfo.url === undefined && changeInfo.status === undefined) return
    await this.appendBrowserEvent(tab, { kind: 'tab', action: 'updated', capturedAt: Date.now() })
  }

  async observeTabClosed(tabId: number, tab?: chrome.tabs.Tab): Promise<void> {
    await this.ready
    if (this.active === null || !this.active.tabIds.includes(tabId)) return
    const descriptor: chrome.tabs.Tab = tab ?? {
      id: tabId,
      windowId: this.active.windowId,
      index: -1,
      pinned: false,
      highlighted: false,
      active: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      title: '',
      url: '',
    }
    await this.appendBrowserEvent(descriptor, { kind: 'tab', action: 'closed', capturedAt: Date.now() })
  }

  async observeNavigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): Promise<void> {
    await this.ready
    const destination = safeUrl(details.url)
    // Iframe redirects and protected/blank URLs are not user page changes.
    if (this.active === null || !this.active.tabIds.includes(details.tabId)
      || details.frameId !== 0 || destination === '') return
    try {
      const tab = await chrome.tabs.get(details.tabId)
      await this.appendBrowserEvent(tab, {
        kind: 'navigation',
        capturedAt: details.timeStamp,
        url: destination,
        transitionType: details.transitionType,
        transitionQualifiers: details.transitionQualifiers,
      }, details.frameId, details.url)
    } catch {
      // Navigation may race tab closure.
    }
  }

  async export(recordingId: string | undefined, format: 'json' | 'jsonl'): Promise<RecordingExport> {
    await this.ready
    const id = recordingId ?? this.state.recordingId
    if (id === undefined) throw new Error('No Tandix recording is available to export')
    const recording = await this.store.get(id)
    if (recording === null) throw new Error('Recording not found')
    return format === 'jsonl' ? exportJsonl(recording) : exportJson(recording)
  }

  private async restore(): Promise<void> {
    try {
      this.active = await this.store.active()
      const recording = this.active ?? await this.store.latest()
      this.transition({ type: 'RESTORED', recording })
      if (this.active !== null) {
        await Promise.all(this.active.tabIds.map((tabId) => this.armTab(tabId, this.active!.id, true)))
      }
    } catch (cause) {
      this.transition({ type: 'FAILED', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  private transition(transition: TeachTransition): void {
    this.state = reduceTeachState(this.state, transition)
    this.onState(this.state)
  }

  private async appendBrowserEvent(
    tab: chrome.tabs.Tab,
    event: BrowserEventInput,
    frameId = 0,
    frameUrl?: string,
  ): Promise<void> {
    const recording = this.active
    const descriptor = tabDescriptor(tab)
    if (this.state.phase !== 'recording' || recording === null || descriptor === null) return
    const next = await this.store.append(recording.id, {
      ...event,
      tab: descriptor,
      frame: { id: frameId, url: safeUrl(frameUrl) || descriptor.url },
    } as RecordingEventInput)
    if (this.state.phase !== 'recording' || this.active?.id !== recording.id) return
    this.active = next
    this.transition({ type: 'EVENT_APPENDED', recording: next })
    this.onEvent(recording.id, { ...event, tab: descriptor, frame: { id: frameId, url: safeUrl(frameUrl) || descriptor.url } } as RecordingEventInput, descriptor.windowId)
  }

  private async armTab(tabId: number, recordingId: string, enabled: boolean): Promise<void> {
    let tab: chrome.tabs.Tab
    try { tab = await chrome.tabs.get(tabId) } catch { return }
    const frames = await listTabFrames(tabId, tab.url)
    await Promise.all(frames.map(async (frame) => {
      await this.setNetworkProbe(tabId, frame.frameId, recordingId, enabled)
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'TRACEFORGE_RECORDING_CONTROL',
          enabled,
          recordingId,
        }, { frameId: frame.frameId })
      } catch {
        if (!enabled) return
        // Tabs opened before an extension reload may not have this build's
        // content script yet. Inject only the missing frame, then arm it.
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            files: ['content.js'],
          })
          await chrome.tabs.sendMessage(tabId, {
            type: 'TRACEFORGE_RECORDING_CONTROL',
            enabled: true,
            recordingId,
          }, { frameId: frame.frameId })
        } catch {
          // Protected and mid-navigation documents cannot be instrumented.
        }
      }
    }))
  }

  async ensureNetworkProbe(tabId: number, frameId: number): Promise<void> {
    const recording = this.active
    if (recording === null || !this.shouldRecordTab(tabId)) return
    await this.setNetworkProbe(tabId, frameId, recording.id, true)
  }

  private async setNetworkProbe(tabId: number, frameId: number, recordingId: string, enabled: boolean): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        func: installNetworkContractProbe,
        args: [recordingId, enabled],
      })
    } catch {
      // Unsupported/protected frames continue recording without response shape evidence.
    }
  }
}

function baseName(recording: BrowserRecording): string {
  const stamp = new Date(recording.startedAt).toISOString().replace(/[:.]/g, '-')
  return `traceforge-${stamp}`
}

function exportJson(recording: BrowserRecording): RecordingExport {
  return {
    filename: `${baseName(recording)}.json`,
    mimeType: 'application/json',
    content: `${JSON.stringify(recording, null, 2)}\n`,
  }
}

function exportJsonl(recording: BrowserRecording): RecordingExport {
  const header = { type: 'recording', ...recording, events: undefined }
  const lines = [JSON.stringify(header), ...recording.events.map((event) => JSON.stringify({ type: 'event', ...event }))]
  return {
    filename: `${baseName(recording)}.jsonl`,
    mimeType: 'application/x-ndjson',
    content: `${lines.join('\n')}\n`,
  }
}
