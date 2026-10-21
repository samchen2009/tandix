/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, controlled-tab tool dispatch, and the panel port service.
 *
 * MV3 survival: after the user opens the panel, its port plus a half-minute
 * `alarms` keepalive re-arm the reconnect loop. Merely loading the extension
 * never probes or claims the single-connection bridge.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', id, settings: Partial<Settings> }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'panel.window', windowId }
 *   panel → bg: { type: 'selection.clear', selection? }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'settings.result', id, ok, error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'selection', selection }
 *   bg → panel: { type: 'tab-affinity', state }
 *   bg → panel: { type: 'tab-affinity.rebind.result', id, ok, error? }
 *
 * @module
 */

import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  isRespondResult,
  type BridgeCaps,
  type RespondResult,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { ensureNativeBridge, nativeBridgeError, nativePanelOpened, nativePanelsClosed } from './native-host.ts'
import { createRpc } from './rpc.ts'
import { agentBackend, agentPreference, type AgentBackend, type AgentPreference } from '../agent-backend.ts'
import {
  dispatchOpenTab,
  dispatchToolCall,
  isNavigationCandidateTool,
  isTabManagementTool,
  resetTabSnapshot,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { getUiLocale, loadUiLocale, UI_LOCALE_STORAGE_KEY } from '../i18n.ts'
import { InteractionResponseRouter } from './responses.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
} from '../security/trusted-origins.ts'
import { TransientEventCache } from './transient-events.ts'
import {
  TabAffinityController,
  isTabAffinityDecision,
  type AffinityTab,
  type TabAffinityDecision,
  type TabAffinityState,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { SelectionTracker, type SelectionSource } from './selection.ts'
import { parsePageSelection, parseSelectionCapture } from '../selection.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  LEGACY_RECENT_SESSION_STORAGE_KEY,
  PAGE_SESSION_CONTEXT_STORAGE_KEY,
  PageSessionContextTracker,
} from './session-continuity.ts'
import { RecordingService } from './recording-service.ts'
import { InMemoryRecentRecordingStore } from '../recording/store.ts'
import type { TeachState } from '../recording/state-machine.ts'
import type { RecordingEventInput } from '../recording/schema.ts'
import { SkillToolService } from './skill-tools.ts'
import { WebApiServer } from './web-api.ts'
import { WebAccess } from './web-access.ts'
import { WebApiError, webRecord } from '../web-api/protocol.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  agentBackend: AgentPreference
  /** Additional local writable directory for Codex, session workspace for dsh. */
  sandboxDirectory: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Allow every browser operation without an approval prompt. */
  unrestrictedBrowserAccess: boolean
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /** Restore the current tab and page path's conversation when the panel reopens. */
  autoResumeSession: boolean
  /** Follow the user's active HTTP(S) tab without a handoff prompt. */
  autoFollowTabs: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  agentBackend: 'auto',
  sandboxDirectory: '',
  sharePageContent: 'auto',
  unrestrictedBrowserAccess: false,
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
  autoFollowTabs: import.meta.env.EXT_TARGET === 'firefox',
}

/**
 * 自动探测的候选端口：
 * - dsh web（CLI）默认 3080，端口被占时依次回退 3081 / 3090；
 * - DSH Desktop 默认由系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），
 *   用户指南推荐固定为 43189（见 deepseek-harness-desktop docs/user-guide）；
 * - 14389 为历史桌面应用端口，保留兼容旧版。
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch {
      // 该端口没有 dsh 或未挂桥：试下一个。
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshSettings'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'

type StoredTabAffinity =
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let unrestrictedAccessActive = SETTINGS_DEFAULTS.unrestrictedBrowserAccess
let unrestrictedAccessRevision = 0
let unrestrictedRevocation: Promise<void> | undefined
let settingsPersistence = Promise.resolve()
let caps: BridgeCaps | null = null
let activeBackend: AgentBackend = 'dsh'
let webTaskApiVersion: number | undefined
let bridge: BridgeClient | null = null
let connectionFailure: string | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
let webBridgeLeases = 0
let webBridgeStart: Promise<void> | undefined
function hasBridgeConsumers(): boolean { return panelPorts.size > 0 || webBridgeLeases > 0 }
function webBridgeReady(): boolean { return bridge?.state === 'connected' && bridge.connected }
const webAccess = new WebAccess((origin) => webApi.revoke(origin))
const webApi = new WebApiServer({
  allowed: origin => webAccess.allowed(origin),
  authorize: origin => webAccess.authorize(origin),
  acquire: async () => {
    webBridgeLeases++
    nativePanelOpened()
    armBridgeKeepalive()
    await settingsReady
    if (!webBridgeReady() && !webBridgeStart) {
      webBridgeStart = (async () => {
        const error = await startBridge()
        if (error) throw new Error(error)
        const deadline = Date.now() + 10_000
        while (!webBridgeReady() && Date.now() < deadline) {
          if (connectionFailure) throw new Error(connectionFailure)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!webBridgeReady()) throw new Error('Tandix agent connection timed out')
      })().finally(() => { webBridgeStart = undefined })
    }
    await webBridgeStart
    if (activeBackend === 'codex' && (webTaskApiVersion ?? 0) < 2) {
      throw new WebApiError('unsupported-companion', 'Update the Tandix native companion before using webpage file tasks')
    }
    return activeBackend
  },
  release: () => { webBridgeLeases = Math.max(0, webBridgeLeases - 1); scheduleBridgeIdle() },
  rpc: async (method, payload) => {
    const envelope = await gatewayRpc(method, payload)
    if (!webRecord(envelope) || !webRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new WebApiError('agent-error', 'Agent returned an invalid RPC response')
    }
    const result = envelope.result
    if (!result.ok) {
      const error = webRecord(result.error) ? result.error : {}
      throw new WebApiError(typeof error.code === 'string' ? error.code : 'agent-error',
        typeof error.message === 'string' ? error.message : 'Agent request failed')
    }
    return result.value
  },
})
webAccess.install()
chrome.runtime.onConnectExternal?.addListener(port => webApi.connect(port))
const recordingService = new RecordingService(new InMemoryRecentRecordingStore(), broadcastRecordingState, broadcastRecordingEvent)
/** Chrome records one user-active page at a time; events only belong to that tab's panel. */
let recordingOwnerTabId: number | undefined
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
/** Panel renderers reconnect after 150ms; navigation must not look like a real close. */
const PANEL_DISCONNECT_GRACE_MS = 500
let panelShutdownTimer: ReturnType<typeof setTimeout> | undefined
/** Invalidates an asynchronous discovery attempt when its panel lease ends. */
let bridgeStartRevision = 0
let nativeStartRevision: number | null = null
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
const tabAffinity = new TabAffinityController()
const focusedWindow = new FocusedWindowTracker()
const selections = new SelectionTracker()
const pageSessionContexts = new PageSessionContextTracker({
  read: async () => (await chrome.storage.session.get(PAGE_SESSION_CONTEXT_STORAGE_KEY))[PAGE_SESSION_CONTEXT_STORAGE_KEY],
  write: async (value) => {
    await chrome.storage.session.set({ [PAGE_SESSION_CONTEXT_STORAGE_KEY]: value })
  },
})
void chrome.storage.session.remove(LEGACY_RECENT_SESSION_STORAGE_KEY).catch(() => {})
void loadUiLocale()
chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[UI_LOCALE_STORAGE_KEY] !== undefined) void loadUiLocale()
})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Tool calls that are either withdrawable or completing an already-dispatched action. */
interface ActiveToolCall {
  controller: AbortController
  unrestrictedAccess: boolean
  committed: boolean
  revocationRequested: boolean
  settled: Promise<void>
  settle: () => void
}

const activeToolCalls = new Map<string, ActiveToolCall>()
const skillTools = new SkillToolService()
/** Disconnection drops result ownership, but dispatched operations must still settle before revocation. */
const unsettledToolCalls = new Set<ActiveToolCall>()
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()
/** Per-session snapshot refreshes preserve prompt ordering without cross-session cancellation. */
const sessionSnapshotRefreshes = new Map<string, Promise<void>>()
interface ActiveFollowRefresh {
  controller: AbortController
  unrestrictedAccess: boolean
  settled: Promise<void>
  settle: () => void
}

const activeFollowRefreshes = new Map<string, ActiveFollowRefresh>()
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000

class TabAffinityRebindError extends Error {
  constructor(readonly code: 'no-active-tab' | 'timeout' | 'cancelled', message: string) {
    super(message)
    this.name = 'TabAffinityRebindError'
  }
}

function rebindAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new TabAffinityRebindError('cancelled', getUiLocale() === 'zh' ? '标签页绑定已取消' : 'Tab binding was cancelled')
}

function throwIfRebindAborted(signal: AbortSignal): void {
  if (signal.aborted) throw rebindAbortReason(signal)
}

/** Reject promptly on cancellation while safely consuming a late Chrome promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rebindAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(rebindAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(rebindAbortReason(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) })
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    await chrome.storage.local.set({ [STORAGE_KEY]: loaded })
  }
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  const changesUnrestrictedAccess = typeof next.unrestrictedBrowserAccess === 'boolean'
  const accessRevision = changesUnrestrictedAccess ? ++unrestrictedAccessRevision : unrestrictedAccessRevision
  const updated = normalizeSettings({ ...settings, ...next })
  if (updated.sandboxDirectory !== '' && updated.bridgeUrl !== '') {
    throw new Error('Clear the bridge address to use a sandbox directory with the local companion.')
  }
  const revokesUnrestrictedAccess = settings.unrestrictedBrowserAccess && !updated.unrestrictedBrowserAccess
  settings = updated
  if (!updated.unrestrictedBrowserAccess) unrestrictedAccessActive = false
  syncSelectionWatch()
  let accessTransition: Promise<void> | undefined
  if (revokesUnrestrictedAccess) {
    let trackedRevocation!: Promise<void>
    trackedRevocation = revokeUnrestrictedAccess().finally(() => {
      if (unrestrictedRevocation !== trackedRevocation) return
      unrestrictedRevocation = undefined
      syncSelectionWatch()
    })
    unrestrictedRevocation = trackedRevocation
    accessTransition = trackedRevocation
  } else if (unrestrictedRevocation !== undefined) {
    accessTransition = unrestrictedRevocation
  }
  const persisted = updated
  const write = settingsPersistence.then(async () => {
    await accessTransition
    await chrome.storage.local.set({ [STORAGE_KEY]: persisted })
  })
  settingsPersistence = write.catch(() => {})
  await write
  if (changesUnrestrictedAccess
    && accessRevision === unrestrictedAccessRevision
    && settings.unrestrictedBrowserAccess
    && persisted.unrestrictedBrowserAccess
    && unrestrictedRevocation === undefined) {
    unrestrictedAccessActive = true
    syncSelectionWatch()
  }
}

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  return {
    ...candidate,
    agentBackend: agentPreference(candidate.agentBackend),
    sandboxDirectory: typeof candidate.sandboxDirectory === 'string' ? candidate.sandboxDirectory.trim() : '',
    sharePageContent,
    unrestrictedBrowserAccess: candidate.unrestrictedBrowserAccess === true,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
    autoFollowTabs: candidate.autoFollowTabs !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
let settingsLoaded = false
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
  unrestrictedAccessActive = loaded.unrestrictedBrowserAccess
  settingsLoaded = true
})

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

function disarmBridgeKeepalive(): void {
  void Promise.resolve(chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM)).catch(() => {})
}

function broadcastStatus(): void {
  const payload = bridgeStatus()
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function bridgeStatus() {
  return { type: 'status', state: currentBridgeState(), caps, backend: activeBackend,
    ...(connectionFailure === null ? {} : { error: connectionFailure }) }
}

function connectionFailed(message: string): string {
  connectionFailure = message
  broadcastStatus()
  return message
}

function currentBridgeState(): BridgeState {
  return nativeStartRevision === bridgeStartRevision ? 'connecting' : bridge?.state ?? 'stopped'
}

function broadcastRecordingState(state: TeachState): void {
  const payload = { type: 'recording.state', state }
  for (const port of panelPorts) {
    if (import.meta.env.EXT_TARGET !== 'firefox') {
      const ownedTabId = panelTabs.get(port)
      if (ownedTabId !== undefined && ownedTabId !== recordingOwnerTabId) continue
    }
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastRecordingEvent(recordingId: string, event: RecordingEventInput, windowId: number): void {
  const payload = { type: 'recording.event', recordingId, event }
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    if (import.meta.env.EXT_TARGET !== 'firefox') {
      const ownedTabId = panelTabs.get(port)
      if (ownedTabId !== undefined && ownedTabId !== event.tab.id) continue
    }
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function recordingStateForPanel(port: chrome.runtime.Port): TeachState {
  if (import.meta.env.EXT_TARGET === 'firefox') return recordingService.snapshot()
  const ownedTabId = panelTabs.get(port)
  return ownedTabId === undefined || ownedTabId === recordingOwnerTabId
    ? recordingService.snapshot()
    : { phase: 'idle' }
}

function tabAffinityForPanel(port: chrome.runtime.Port): TabAffinityState {
  const shared = tabAffinity.snapshot()
  if (import.meta.env.EXT_TARGET === 'firefox') return shared

  const ownedTabId = panelTabs.get(port)
  if (ownedTabId === undefined) return shared

  const sessionId = panelActiveSessions.get(port)
  const sessionTab = sessionId === undefined ? undefined : tabAffinity.getSessionTab(sessionId)
  const owned = panelOwnedTabs.get(port)
    ?? (shared.active?.tabId === ownedTabId ? shared.active : undefined)
    ?? (shared.controlled?.tabId === ownedTabId ? shared.controlled : undefined)
    ?? {
      tabId: ownedTabId,
      windowId: panelWindows.get(port) ?? 0,
      title: '',
      url: '',
    }

  // Chrome side panels are tab-specific. A switch to another browser tab must
  // not turn every open Tandix instance into one global handoff prompt. The
  // panel's active page is its owning tab, while the session map remains the
  // source of truth for browser tool routing.
  if (sessionTab === undefined) {
    return {
      revision: shared.revision,
      status: 'unbound',
      controlled: null,
      active: { ...owned },
      pinned: false,
    }
  }
  return {
    revision: shared.revision,
    status: sessionTab.tabId === ownedTabId ? 'following' : 'background',
    controlled: { ...sessionTab },
    active: { ...owned },
    pinned: false,
  }
}

function sendTabAffinity(port: chrome.runtime.Port): void {
  try { port.postMessage({ type: 'tab-affinity', state: tabAffinityForPanel(port) }) } catch { /* port already closed */ }
}

function broadcastTabAffinity(): void {
  for (const port of panelPorts) {
    sendTabAffinity(port)
  }
}

/** Which window each panel port belongs to, so a quote stays in its window. */
const panelWindows = new WeakMap<chrome.runtime.Port, number>()
/** Chrome's tab-specific panel URL identifies its owning tab even after a tab switch. */
const panelTabs = new WeakMap<chrome.runtime.Port, number>()
/** Live metadata for the tab that owns each Chrome side-panel instance. */
const panelOwnedTabs = new WeakMap<chrome.runtime.Port, AffinityTab>()
/** The conversation each live panel is displaying, used for close checkpoints. */
const panelActiveSessions = new WeakMap<chrome.runtime.Port, string>()

/**
 * Send one window's selection to that window's panels only.
 *
 * A panel must never be offered a quote from a page its own window is not
 * looking at, which also keeps an incognito window's highlight out of a
 * normal window's composer.
 */
function broadcastSelection(windowId: number): void {
  const selection = selections.current(windowId)
  const source = selections.source(windowId)
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    const ownedTabId = panelTabs.get(port)
    const payload = { type: 'selection', selection: ownedTabId === undefined || source?.tabId === ownedTabId ? selection : null }
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastSelections(windowIds: readonly number[]): void {
  for (const windowId of windowIds) broadcastSelection(windowId)
}

/** Whether a window currently has a panel that can display its selection. */
function hasPanelInWindow(windowId: number): boolean {
  for (const port of panelPorts) {
    if (panelWindows.get(port) === windowId) return true
  }
  return false
}

function hasPanelForTab(tabId: number, windowId: number): boolean {
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    if (import.meta.env.EXT_TARGET === 'firefox' || panelTabs.get(port) === tabId) return true
  }
  return false
}

let recordingFocus = Promise.resolve()

/** The passive trace follows only a tab whose own Tandix panel is open. */
function focusRecordingTab(tabId: number, windowId: number): void {
  recordingFocus = recordingFocus.catch(() => {}).then(async () => {
    if (!hasPanelForTab(tabId, windowId)) return
    if (recordingService.shouldRecordTab(tabId)) return
    if (recordingService.snapshot().phase === 'recording') await recordingService.stop()
    recordingOwnerTabId = tabId
    await recordingService.start(windowId)
  }).catch(() => { /* protected or non-HTTP pages cannot be recorded */ })
}

/**
 * Tell a frame its quote is gone so re-selecting the same passage reports it
 * again; the content script deduplicates against the last text it sent.
 */
function resetSelectionDedupe(sources: readonly SelectionSource[]): void {
  for (const { tabId, frameId } of sources) {
    void Promise.resolve(chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_SELECTION_RESET' },
      { frameId },
    ))
      .catch(() => { /* no content script in this tab */ })
  }
}

/** Whether saved privacy settings currently allow page-selection capture. */
function selectionSharingEnabled(): boolean {
  // Until storage answers, `settings` still holds the defaults. Reporting the
  // default here would arm watchers for a user whose saved choice is `off`.
  return settingsLoaded && (unrestrictedAccessEnabled() || settings.sharePageContent !== 'off')
}

/** Whether unrestricted access is enabled and no earlier grant is still being revoked. */
function unrestrictedAccessEnabled(): boolean {
  return unrestrictedAccessActive && unrestrictedRevocation === undefined
}

/** Page selections are captured only in a window with an open panel. */
function selectionWatchEnabled(windowId: number): boolean {
  return selectionSharingEnabled() && hasPanelInWindow(windowId)
}

let selectionWatchArmed = false
/** Distinguishes revisions issued by different MV3 worker lifetimes. */
const selectionWatchEpoch = crypto.randomUUID()
/** Orders arm/disarm commands so a slow delivery cannot undo a newer one. */
let selectionWatchRevision = 0

/**
 * Arm or disarm every content script. `selectionchange` fires on each drag in
 * each tab, so the watcher stays off until a panel can actually show a quote.
 *
 * Delivery is asynchronous, so each command carries a revision: a panel that
 * closes and reopens quickly must not leave watchers in the state of whichever
 * `tabs.query` happened to resolve last.
 */
function syncSelectionWatch(): void {
  const anyEnabled = selectionSharingEnabled()
    && [...panelPorts].some((port) => panelWindows.get(port) !== undefined)
  const wasArmed = selectionWatchArmed
  selectionWatchArmed = anyEnabled
  const revision = ++selectionWatchRevision
  if (wasArmed && !anyEnabled) {
    resetSelectionDedupe(selections.sourcesWithSelection())
    broadcastSelections(selections.clearAll())
  }
  void Promise.resolve(chrome.tabs.query({})).then((tabs) => {
    if (revision !== selectionWatchRevision) return
    for (const tab of tabs) {
      if (tab.id === undefined) continue
      const enabled = selectionWatchEnabled(tab.windowId)
      void Promise.resolve(chrome.tabs.sendMessage(tab.id, {
        type: 'DSH_SELECTION_WATCH',
        enabled,
        epoch: selectionWatchEpoch,
        revision,
      }))
        .catch(() => { /* no content script in this tab */ })
    }
  }).catch(() => {})
}

/**
 * Accept a capture from the page the user is actually looking at.
 *
 * `sender.tab` already carries the tab's window, active state, and incognito
 * flag, so admission needs no `chrome.tabs` call: a background page cannot
 * make the worker query Chrome by moving its own selection in a loop.
 */
function recordSelection(tab: chrome.tabs.Tab, frameId: number, value: unknown): void {
  if (!selectionWatchEnabled(tab.windowId)) return
  // Only the tab the user is looking at, in its own window, may set a quote.
  if (tab.id === undefined || tab.active !== true) return
  const capture = parseSelectionCapture(value)
  if (capture === null) return
  if (selections.capture({ windowId: tab.windowId, tabId: tab.id, frameId }, capture)) {
    broadcastSelection(tab.windowId)
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* port already closed */ }
  }
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'
const AGENT_APPROVAL_NOTIFICATION_PREFIX = 'tandix-agent-approval:'
const approvalNotificationTabs = new Map<string, number>()
const agentApprovalWindows = new Map<string, number>()
const agentApprovalPending = new Set<string>()

async function notifyAgentApproval(id: string): Promise<void> {
  if (!settings.approvalNotifications || panelPorts.size > 0) return
  agentApprovalPending.add(id)
  try {
    const window = await chrome.windows.getLastFocused()
    if (window.id === undefined || !agentApprovalPending.has(id) || panelPorts.size > 0) return
    agentApprovalWindows.set(id, window.id)
    await chrome.notifications.create(`${AGENT_APPROVAL_NOTIFICATION_PREFIX}${id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
      title: getUiLocale() === 'zh' ? '本地操作等待授权' : 'Local action awaiting approval',
      message: getUiLocale() === 'zh' ? '点击打开网页助手，查看具体操作并选择允许或拒绝。' : 'Open Tandix to review and allow or deny the action.',
      requireInteraction: true,
    })
  } catch { /* Notifications are best effort; the request remains pending. */ }
}

function clearAgentApprovalNotification(id: string): void {
  agentApprovalPending.delete(id)
  agentApprovalWindows.delete(id)
  void Promise.resolve(chrome.notifications.clear(`${AGENT_APPROVAL_NOTIFICATION_PREFIX}${id}`)).catch(() => {})
}

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function approvalBelongsToPanel(port: chrome.runtime.Port, request: ApprovalRequest): boolean {
  if (import.meta.env.EXT_TARGET === 'firefox') return true
  const ownedTabId = panelTabs.get(port)
  if (ownedTabId === undefined) return true // Older, window-wide panels.
  if (request.sessionId !== undefined) {
    if (panelActiveSessions.get(port) === request.sessionId) return true
    // A session may intentionally operate another tab. Its existing panel owns
    // the approval; the target tab's independent conversation must not switch.
    if ([...panelPorts].some(candidate => panelActiveSessions.get(candidate) === request.sessionId)) return false
    // Reopening the original panel may replay approvals before session restore.
    return tabAffinity.getSessionTab(request.sessionId)?.tabId === ownedTabId
  }
  return tabAffinity.snapshot().controlled?.tabId === ownedTabId
}

function deliverApprovalToPanel(port: chrome.runtime.Port, request: ApprovalRequest): boolean {
  if (!approvalBelongsToPanel(port, request)) return false
  try {
    port.postMessage({ type: 'approval.request', request })
    return true
  } catch { return false /* port already closed */ }
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    if (deliverApprovalToPanel(port, request)) delivered = true
  }
  return delivered
}

function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  const tab = request.sessionId === undefined
    ? tabAffinity.snapshot().controlled
    : tabAffinity.getSessionTab(request.sessionId)
  if (tab !== undefined && tab !== null) approvalNotificationTabs.set(request.id, tab.tabId)
  const copy = getUiLocale() === 'zh'
    ? {
        title: '浏览器操作等待确认',
        message: '点击通知打开网页助手，并在 60 秒内确认或拒绝。',
      }
    : {
        title: 'Browser action awaiting approval',
        message: 'Click to open Tandix, then allow or deny within 60 seconds.',
      }
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  approvalNotificationTabs.delete(id)
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: broadcastApprovalResolved,
})

function responseMessages(): { unavailable: string; timeout: string; duplicate: string; disconnected: string } {
  return getUiLocale() === 'zh'
    ? {
        unavailable: '未连接 dsh，无法提交回答',
        timeout: '提交回答超时，请重试',
        duplicate: '回答请求编号重复，请重试',
        disconnected: 'dsh 连接已断开，请重新连接后再试',
      }
    : {
        unavailable: 'dsh is not connected, so the answer could not be sent',
        timeout: 'Sending the answer timed out. Try again.',
        duplicate: 'The answer request ID was duplicated. Try again.',
        disconnected: 'The dsh connection was lost. Reconnect and try again.',
      }
}

function cancelPendingApprovals(sessionId?: string): void {
  approvals.cancelAll(sessionId)
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  const sessionTabs = tabAffinity.sessionMap()
  const hasSessionTabs = Object.keys(sessionTabs).length > 0
  const focusedSessionId = tabAffinity.focusedSession()
  const focus = focusedSessionId === null ? {} : { focusedSessionId }
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
      ...(state.pinned ? { pinned: true as const } : {}),
      ...(hasSessionTabs ? { sessionTabs } : {}),
      ...focus,
    }
  }
  return state.status === 'lost'
    ? { lost: true, ...(hasSessionTabs ? { sessionTabs } : {}), ...focus }
    : (hasSessionTabs ? { lost: true, sessionTabs, ...focus } : null)
}

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

function observeActiveSummary(summary: AffinityTab): void {
  const previousStatus = tabAffinity.snapshot().status
  if (!tabAffinity.observeActive(summary)) return
  const current = tabAffinity.snapshot()
  if (import.meta.env.EXT_TARGET === 'firefox' && settings.autoFollowTabs && !current.pinned && current.status === 'handoff'
    && /^https?:\/\//i.test(summary.url)) {
    const sid = tabAffinity.focusedSession() ?? undefined
    commitTabAffinityRebind(summary, sid)
    if (sid !== undefined) void refreshFollowedPage(sid, summary.tabId).catch(() => {})
    return
  }
  if (previousStatus !== 'handoff' && tabAffinity.snapshot().status === 'handoff') {
    const focused = tabAffinity.focusedSession()
    // Chrome's session-scoped tools keep their own tab when browser focus moves.
    // Only the window-wide Firefox flow requires a new handoff decision.
    if (focused !== null && import.meta.env.EXT_TARGET === 'firefox') {
      activeFollowRefreshes.get(focused)?.controller.abort()
      cancelPendingApprovals(focused)
    } else if (focused === null) {
      cancelPendingApprovals()
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const tabs = chrome.tabs.query(query)
    const [tab] = signal === undefined ? await tabs : await abortable(tabs, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    observeActiveTab(tab)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredTabAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const focusedSessionId = (candidate as { focusedSessionId?: unknown } | undefined)?.focusedSessionId
    const focus = typeof focusedSessionId === 'string' && focusedSessionId.trim() !== '' ? { focusedSessionId } : {}
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const keptActiveTabId = (candidate as { keptActiveTabId?: unknown }).keptActiveTabId
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        lost: true,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record?.sessionTabs !== undefined) {
    const restoredSessions: Record<string, AffinityTab> = {}
    for (const [sid, storedTab] of Object.entries(record.sessionTabs)) {
      if (typeof storedTab?.tabId !== 'number' || !Number.isInteger(storedTab.tabId) || storedTab.tabId < 0) continue
      try {
        const live = summarizeTab(await chrome.tabs.get(storedTab.tabId))
        if (live !== null) restoredSessions[sid] = live
      } catch {
        // Closed tabs are deliberately pruned so the session fails closed.
      }
    }
    tabAffinity.restoreSessionTabs(restoredSessions)
  }
  tabAffinity.restoreFocusedSession(record?.focusedSessionId ?? null)

  if (record !== null && 'controlledTabId' in record) {
    try {
      const controlled = summarizeTab(await chrome.tabs.get(record.controlledTabId))
      if (controlled === null) tabAffinity.restoreLost()
      else tabAffinity.restoreControlled(controlled)
    } catch {
      tabAffinity.restoreLost()
    }
  } else if (record?.lost === true) {
    tabAffinity.restoreLost()
  }

  // Restore the pin before syncing the active tab: otherwise the sync would
  // surface a handoff prompt for a switch the user already said not to ask about.
  if (record !== null && 'pinned' in record && record.pinned === true) tabAffinity.restorePinned()
  // A saved manual-follow preference must win over the default during worker
  // restart, before the first active-tab observation can auto-rebind.
  await settingsReady
  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = tabAffinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      tabAffinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Refresh one session's recovery checkpoint from its actual controlled tab. */
async function checkpointSessionPage(sessionValue: unknown): Promise<void> {
  const sessionId = validSessionId(sessionValue)
  if (sessionId === undefined) return
  await Promise.all([affinityReady, pageSessionContexts.ready])
  const bound = tabAffinity.getSessionTab(sessionId)
  if (bound === undefined) return
  try {
    const tab = await chrome.tabs.get(bound.tabId)
    if (tabAffinity.getSessionTab(sessionId)?.tabId !== bound.tabId) return
    pageSessionContexts.bind(sessionId, tab)
  } catch {
    // A concurrently closed tab is cleaned by tabs.onRemoved.
  }
}

/** Resolve the contextual hint only after the panel has identified its window. */
async function tabForPanel(port: chrome.runtime.Port, windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const boundTabId = panelTabs.get(port)
  if (boundTabId === undefined) {
    const [active] = await chrome.tabs.query({ active: true, windowId })
    const summary = active === undefined ? null : summarizeTab(active)
    if (summary !== null) panelOwnedTabs.set(port, summary)
    return active
  }
  const tab = await chrome.tabs.get(boundTabId)
  if (tab.windowId !== windowId) return undefined
  const summary = summarizeTab(tab)
  if (summary !== null) panelOwnedTabs.set(port, summary)
  return tab
}

async function postResumeHint(port: chrome.runtime.Port, windowId: number): Promise<void> {
  await pageSessionContexts.ready
  let sessionId: string | null = null
  try {
    const tab = await tabForPanel(port, windowId)
    if (tab !== undefined) sessionId = pageSessionContexts.candidate(tab)
  } catch {
    // Without an exact live page the panel must start a new conversation.
  }
  if (!panelPorts.has(port) || panelWindows.get(port) !== windowId) return
  try { port.postMessage({ type: 'session.resume-hint', sessionId }) } catch { /* port closed */ }
}

/** Re-checkpoint each open panel before issuing a bridge-epoch resume hint. */
function refreshPanelResumeHints(): void {
  for (const port of panelPorts) {
    const windowId = panelWindows.get(port)
    if (windowId === undefined) continue
    const sessionId = panelActiveSessions.get(port)
    const checkpoint = sessionId === undefined
      ? Promise.resolve()
      : checkpointSessionPage(sessionId)
    void checkpoint.then(() => postResumeHint(port, windowId), () => postResumeHint(port, windowId))
  }
}

/** Bind at prompt submission so a switch while the model is thinking is visible. */
async function ensureInitialTabBinding(sessionId?: string): Promise<boolean> {
  await affinityReady
  if (tabAffinity.resolveTarget(sessionId).kind !== 'initial') return true
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null) return false
    if (tabAffinity.bindInitial(summary, sessionId)) {
      persistTabAffinity()
      broadcastTabAffinity()
    }
    return true
  } catch {
    return false
  }
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing'): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. In the side panel, choose whether to keep the previous page or follow the current page.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Select the current page in the side panel before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget(sessionId)
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      if (!await ensureInitialTabBinding(sessionId)) return affinityFailure('missing')
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget(sessionId)
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      const affectedSessions = tabAffinity.sessionIdsForTab(resolution.tab.tabId)
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        for (const sid of affectedSessions) {
          activeFollowRefreshes.get(sid)?.controller.abort()
          cancelPendingApprovals(sid)
        }
        persistTabAffinity()
        broadcastTabAffinity()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

/**
 * Pick a window for browser_open_tab without requiring an already-controlled page.
 * Handoff still blocks: the user must finish the keep/follow choice first.
 */
async function resolveOpenTabWindow(sessionId?: string): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget(sessionId)
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // Fall through to the focused window when the prior controlled tab is gone.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch { /* no focused window */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(
  tab: chrome.tabs.Tab,
  sessionId?: string,
  options: { active?: boolean } = {},
): boolean {
  const summary = summarizeTab(tab)
  if (summary === null) return false
  const sid = sessionId?.trim()
  bindOpenedTabAffinity(tabAffinity, summary, {
    active: options.active,
    sessionId: sid,
  })
  if (sid !== undefined && sid !== '') {
    void pageSessionContexts.ready.then(() => {
      pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
    })
  }
  persistTabAffinity()
  broadcastTabAffinity()
  return true
}

async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
  unrestrictedAccess: boolean = unrestrictedAccessEnabled(),
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (unrestrictedAccess) return 'approved'
  if (actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return 'approved'
  }
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // Retain wire compatibility with panels from the previous build. The new UI
  // manages permanent trust explicitly in Settings instead of offering it in
  // the action dialog.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Capture the newly controlled tab and seed it into this session's next Agent step. */
async function refreshFollowedPage(sessionId: string, tabId: number): Promise<void> {
  activeFollowRefreshes.get(sessionId)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeRefresh: ActiveFollowRefresh = {
    controller,
    unrestrictedAccess,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeFollowRefreshes.set(sessionId, activeRefresh)
  try {
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      unrestrictedAccess ? 'auto' : settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, sessionId, unrestrictedAccess),
      controller.signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
      { unrestrictedAccess },
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId, sessionId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    activeRefresh.settle()
    if (activeFollowRefreshes.get(sessionId) === activeRefresh) activeFollowRefreshes.delete(sessionId)
  }
}

async function refreshSessionSnapshot(sessionId: string): Promise<void> {
  await affinityReady
  const target = await resolveToolTab(sessionId)
  if (!('ok' in target) && target.id !== undefined) {
    await refreshFollowedPage(sessionId, target.id)
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}, port: chrome.runtime.Port): Promise<void> {
  await affinityReady
  const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined

  if (response.decision === 'show-controlled') {
    const state = tabAffinityForPanel(port)
    if (response.revision !== state.revision || state.controlled === null) {
      broadcastTabAffinity()
      return
    }
    const controlled = state.controlled
    try {
      const tab = await chrome.tabs.get(controlled.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) throw new Error('The controlled tab is no longer available')
      await pageSessionContexts.ready
      // Update affinity before activating the tab. Chrome may deliver
      // onActivated before tabs.update() resolves; pre-committing avoids a
      // false handoff banner during this intentional switch.
      commitTabAffinityRebind(summary, sid, 'active')
      await chrome.tabs.update(summary.tabId, { active: true })
      await chrome.windows.update(summary.windowId, { focused: true })
    } catch {
      // Restore an accurate background relationship if activation failed.
      await syncActiveTab()
      commitTabAffinityRebind(controlled, sid, 'background')
      return
    }
    if (sid !== undefined) await refreshFollowedPage(sid, controlled.tabId).catch(() => {})
    return
  }

  if (import.meta.env.EXT_TARGET !== 'firefox' && panelTabs.has(port) && response.decision === 'follow') {
    if (response.revision !== tabAffinityForPanel(port).revision) {
      sendTabAffinity(port)
      return
    }
    await rebindTabAffinityToPanel(port, new AbortController().signal, sid)
    if (sid !== undefined) await refreshSessionSnapshot(sid)
    return
  }

  await syncActiveTab()
  const accepted = tabAffinity.decide(response.decision, response.revision, sid)
  const controlled = accepted && response.decision === 'follow'
    ? tabAffinity.snapshot().controlled
    : null
  if (controlled !== null) resetTabSnapshot(controlled.tabId)
  if (accepted) {
    persistTabAffinity()
    if (controlled !== null && sid !== undefined) {
      await pageSessionContexts.ready
      pageSessionContexts.bind(sid, { id: controlled.tabId, ...controlled })
    }
  }
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToPanel(
  port: chrome.runtime.Port,
  signal: AbortSignal,
  sessionId?: string,
): Promise<void> {
  await abortable(Promise.all([affinityReady, pageSessionContexts.ready]).then(() => undefined), signal)
  const windowId = panelWindows.get(port)
  const tab = windowId === undefined
    ? await syncActiveTab(undefined, signal)
    : await abortable(tabForPanel(port, windowId), signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  const globallyActive = tabAffinity.snapshot().active?.tabId === summary.tabId
  commitTabAffinityRebind(summary, sessionId, globallyActive ? 'active' : 'background')
}

/** A green page indicator requires a real read through the normal extension policy. */
async function verifyBoundPage(signal: AbortSignal, sessionId?: string): Promise<void> {
  const target = await resolveToolTab(sessionId)
  if ('ok' in target) throw new Error(target.error?.message ?? 'No controlled browser tab is available')
  const unrestrictedAccess = unrestrictedAccessEnabled()
  const answer = await dispatchToolCall(
    { id: crypto.randomUUID(), name: 'browser_snapshot', args: {}, ...(sessionId === undefined ? {} : { sessionId }) },
    unrestrictedAccess ? 'auto' : settings.sharePageContent,
    caps === null ? undefined : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars },
    (prompt) => authorizeToolCall(prompt, signal, target.windowId, sessionId, unrestrictedAccess),
    signal,
    target,
    () => target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
    { unrestrictedAccess },
  )
  if (!answer.ok) throw new Error(answer.error?.message ?? 'The current page could not be read')
}

/** Commit one explicit tab handoff and clear stale element references. */
function commitTabAffinityRebind(
  summary: AffinityTab,
  sessionId?: string,
  mode: 'active' | 'background' = 'active',
): void {
  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  if (sessionId !== undefined) {
    activeFollowRefreshes.get(sessionId)?.controller.abort()
    cancelPendingApprovals(sessionId)
  }
  if (mode === 'active') tabAffinity.rebindActive(summary, sessionId)
  else tabAffinity.rebindControlled(summary, sessionId)
  if (sessionId !== undefined) {
    pageSessionContexts.bind(sessionId, { id: summary.tabId, ...summary })
  }
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

async function followModelSelectedTab(tab: chrome.tabs.Tab, sessionId?: string, active = false): Promise<void> {
  const summary = summarizeTab(tab)
  if (summary === null) throw new Error('the selected tab has no usable identifier')
  await pageSessionContexts.ready
  commitTabAffinityRebind(summary, sessionId, active ? 'active' : 'background')
}

/** 把协商的快照预算下发到受控页（尚未绑定时使用活动页）。 */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/** Route one tool.call frame to the browser or Tandix-owned skill storage. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  // Web file jobs cannot inherit a panel's global tab, trusted origins or skill access.
  if (webApi.isWebSession(call.sessionId)) {
    bridge.send({ t: 'tool.result', id: call.id, ok: false,
      error: { code: 'action-failed', message: 'Web attachment tasks have no browser or Tandix skill access' } })
    return
  }
  activeToolCalls.get(call.id)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeCall: ActiveToolCall = {
    controller,
    unrestrictedAccess,
    committed: false,
    revocationRequested: false,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  unsettledToolCalls.add(activeCall)
  const commitAction = (): void => { activeCall.committed = true }
  const rollbackActionCommit = (): void => {
    activeCall.committed = false
    if (activeCall.revocationRequested) controller.abort()
  }
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => {
        if (!activeCall.committed) controller.abort()
      }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  const sharePageContent = unrestrictedAccess ? 'auto' : settings.sharePageContent
  const managementDispatch = async (): Promise<ToolAnswer> => {
    await affinityReady
    const affinity = tabAffinity.snapshot()
    const sessionTab = call.sessionId === undefined
      ? affinity.controlled
      : tabAffinity.getSessionTab(call.sessionId)
    let windowId = sessionTab?.windowId ?? affinity.active?.windowId
    if (windowId === undefined) {
      try {
        windowId = (await chrome.windows.getLastFocused()).id
      } catch { /* approvals can still report unavailable without a focused window */ }
    }
    const controlledTabId = sessionTab?.tabId
    return dispatchToolCall(
      call,
      sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, windowId ?? 0, call.sessionId, unrestrictedAccess),
      controller.signal,
      undefined,
      undefined,
      {
        unrestrictedAccess,
        ...(controlledTabId === undefined ? {} : { controlledTabId }),
        followTab: (tab, options) => followModelSelectedTab(tab, call.sessionId, options.active),
        commitAction,
        rollbackActionCommit,
      },
    )
  }
  void (call.name.startsWith('tandix_skill_')
    ? skillTools.dispatch(call, controller.signal, commitAction)
    : isTabManagementTool(call.name)
    ? managementDispatch()
    : call.name === 'browser_open_tab'
    ? resolveOpenTabWindow(call.sessionId).then((target) => 'ok' in target
      ? target
      : dispatchOpenTab(
          call,
          target.windowId,
          sharePageContent,
          budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId, unrestrictedAccess),
          controller.signal,
          (tab) => bindOpenedTab(tab, call.sessionId, { active: call.args.active !== false }),
          (tabId) => tabAffinity.allowsTarget(tabId, call.sessionId),
          commitAction,
        ))
    : resolveToolTab(call.sessionId).then((target) => 'ok' in target
      ? target
      : dispatchToolCall(
          call,
          sharePageContent,
          budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId, unrestrictedAccess),
          controller.signal,
          target,
          () => target.id !== undefined && tabAffinity.allowsTarget(target.id, call.sessionId),
          { unrestrictedAccess, commitAction, rollbackActionCommit },
        ))
  ).then(
    async (answer) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      // A committed browser_open_tab already rebound affinity; prefer that
      // factual success over a generic cancel that would leave the model wrong.
      if (controller.signal.aborted && !((call.name === 'browser_open_tab' || call.name === 'tandix_skill_save') && answer.ok && activeCall.committed)) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      if (answer.ok) {
        if (isNavigationCandidateTool(call.name)) await checkpointSessionPage(call.sessionId)
        if (activeToolCalls.get(call.id) !== activeCall) return
        const socket = bridge
        if (socket === null) return
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        const socket = bridge
        if (socket === null) return
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      bridge?.send({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    unsettledToolCalls.delete(activeCall)
    activeCall.settle()
    if (activeToolCalls.get(call.id) === activeCall) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  const call = activeToolCalls.get(id)
  if (call !== undefined && !call.committed) call.controller.abort()
}

async function revokeUnrestrictedAccess(): Promise<void> {
  const calls = [...unsettledToolCalls].filter((call) => call.unrestrictedAccess)
  const refreshes = [...activeFollowRefreshes.values()].filter((refresh) => refresh.unrestrictedAccess)
  for (const call of calls) {
    call.revocationRequested = true
    if (!call.committed) call.controller.abort()
  }
  for (const refresh of refreshes) refresh.controller.abort()
  await Promise.allSettled([
    ...calls.map(async (call) => { await call.settled }),
    ...refreshes.map(async (refresh) => { await refresh.settled }),
  ])
}

function cancelAllToolCalls(): void {
  for (const call of activeToolCalls.values()) {
    if (!call.committed) call.controller.abort()
  }
  activeToolCalls.clear()
}

/** (Re)start the bridge with the current settings. 零配置：地址留空时自动探测；回环连接无需 token。 */
async function startBridge(): Promise<string | undefined> {
  const revision = ++bridgeStartRevision
  connectionFailure = null
  if (!hasBridgeConsumers()) return
  // Retire the previous generation before the companion replaces its process.
  // Its old socket must not retry or publish errors during the new startup.
  const previous = bridge
  previous?.stop()
  bridge = null
  rpc = null
  caps = null
  nativeStartRevision = revision
  broadcastStatus()
  try {
    let url = settings.bridgeUrl
    const explicitLocalAgent = settings.agentBackend === 'codex' || settings.agentBackend === 'cursor' || settings.agentBackend === 'workbuddy'
    let autoLocal = url === '' || explicitLocalAgent
    if (!autoLocal) {
      try { autoLocal = new URL(url).hostname === '127.0.0.1' } catch { /* Preserve invalid manual URL for the existing error path. */ }
    }
    if (autoLocal) {
      if (explicitLocalAgent) url = ''
      url = await ensureNativeBridge(settings.agentBackend, settings.sandboxDirectory) ?? ''
      if (url === '' && settings.sandboxDirectory === '' && !explicitLocalAgent
        && revision === bridgeStartRevision && hasBridgeConsumers()) {
        url = settings.bridgeUrl || await discoverBridge(() => revision === bridgeStartRevision && hasBridgeConsumers()) || ''
      }
    }
    // Discovery is asynchronous. A panel may have closed or a newer settings
    // update may have started while its fetches were in flight.
    if (revision !== bridgeStartRevision || !hasBridgeConsumers()) return
    if (url === '') {
      bridge = null
      rpc = null
      if (settings.agentBackend === 'codex' || settings.agentBackend === 'cursor' || settings.agentBackend === 'workbuddy') activeBackend = settings.agentBackend
      broadcastStatus()
      if (settings.agentBackend !== 'auto') {
        const label = settings.agentBackend === 'cursor' ? 'Cursor' : settings.agentBackend === 'workbuddy' ? 'WorkBuddy' : settings.agentBackend === 'codex' ? 'Codex' : 'dsh'
        const detail = nativeBridgeError() ?? 'The native companion is unavailable.'
        return connectionFailed(getUiLocale() === 'zh'
          ? `${label} 连接失败。请重新运行 Tandix 安装向导完成依赖安装和本机连接检查，再重新加载扩展。详细原因：${detail}`
          : `${label} connection failed. Rerun the Tandix installer to finish runtime setup and connection checks, then reload the extension. Details: ${detail}`)
      }
      return
    }
    let detectedBackend: AgentBackend = 'dsh'
    let detectedWebTaskApiVersion: number | undefined
    let verifiedBackend = false
    let identityRead = false
    const identityDeadline = Date.now() + 30_000
    do {
      try {
        const target = new URL(url)
        target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
        target.pathname = BRIDGE_CONFIG_PATH
        const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
        if (!response.ok) throw new Error('Bridge is starting')
        const config = await response.json() as { backend?: unknown; webTaskApiVersion?: unknown }
        detectedBackend = agentBackend(config.backend)
        if (typeof config.webTaskApiVersion === 'number') detectedWebTaskApiVersion = config.webTaskApiVersion
        verifiedBackend = config.backend === settings.agentBackend
        identityRead = true
        break
      } catch {
        if (!explicitLocalAgent || Date.now() >= identityDeadline) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (revision !== bridgeStartRevision || !hasBridgeConsumers()) return
    } while (Date.now() < identityDeadline)
    if (revision !== bridgeStartRevision || !hasBridgeConsumers()) return
    if (explicitLocalAgent && !identityRead) return connectionFailed(getUiLocale() === 'zh'
      ? 'Agent 连接等待已超时，请重试连接；若持续失败，再查看安装向导的连接报告。'
      : 'Timed out waiting for the agent connection. Retry, then check the connection report if it keeps failing.')
    if ((explicitLocalAgent && !verifiedBackend) || (settings.agentBackend === 'dsh' && detectedBackend !== 'dsh')) {
      bridge = null
      rpc = null
      activeBackend = agentBackend(settings.agentBackend)
      broadcastStatus()
      return connectionFailed(getUiLocale() === 'zh'
        ? '本机伴随程序返回了其他 Agent，请更新伴随程序后重新连接。'
        : 'The native companion returned a different agent. Update the companion and reconnect.')
    }
    activeBackend = detectedBackend
    webTaskApiVersion = detectedWebTaskApiVersion
    // 手动填的地址常只有主机部分（如 ws://127.0.0.1:3080）；桥路径是协议
    // 常量，缺省时自动补全，避免连到根路径失败。
    try {
      const parsed = new URL(url)
      if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
      url = parsed.toString()
    } catch {
      // 非法 URL 原样交给 WebSocket 构造函数报错。
    }
    if (bridge === null) {
      const client = new BridgeClient({
        onError: (message) => {
          if (bridge !== client) return
          connectionFailed(getUiLocale() === 'zh' ? `Agent 连接失败，请查看安装向导的连接报告。详细原因：${message}` : message)
        },
        onStateChange: (state) => {
          if (bridge !== client) return
          if (state === 'connected') connectionFailure = null
          if (state !== 'connected') {
            webApi.failDisconnected()
            for (const id of agentApprovalPending) clearAgentApprovalNotification(id)
            cancelAllToolCalls()
            interactionResponses.failAll(responseMessages().disconnected)
            transientEvents.clear()
          }
          broadcastStatus()
          if (state === 'stopped') refreshPanelResumeHints()
          if (state === 'stopped' && !hasBridgeConsumers()) disarmBridgeKeepalive()
        },
        onFrame: (frame) => {
          if (bridge !== client) return
          webApi.ingest(frame)
          if (frame.t === 'event') {
            if (frame.frame.method === 'session/event') {
              const payload = frame.frame.payload as { sessionId?: unknown; event?: { type?: unknown } } | undefined
              if (payload?.event?.type === 'turn/end' && typeof payload.sessionId === 'string') {
                skillTools.revokeSave(payload.sessionId)
              }
            }
            transientEvents.ingest(frame)
            broadcastEvent(frame)
            if (frame.frame.method === 'agent-approval/requested' && panelPorts.size === 0) {
              void notifyAgentApproval(frame.frame.rpcId)
            } else if (frame.frame.method === 'agent-approval/resolved'
              && typeof (frame.frame.payload as { approvalRpcId?: unknown } | null)?.approvalRpcId === 'string') {
              clearAgentApprovalNotification((frame.frame.payload as { approvalRpcId: string }).approvalRpcId)
            }
          }
          else if (frame.t === 'tool.call') routeToolCall(frame)
          else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
          else if (frame.t === 'respond.result') interactionResponses.route(frame)
          // rpc.result is settled by the rpc facade (wrapped below).
        },
        onHelloOk: (negotiated) => {
          if (bridge !== client) return
          caps = negotiated
          broadcastStatus()
          void pushBudgetToControlledTab(negotiated)
        },
      }, probeBridge, hasBridgeConsumers)
      bridge = client
      rpc = createRpc(client)
    }
    if (nativeStartRevision === revision) nativeStartRevision = null
    bridge.start(url, settings.token)
  } finally {
    if (nativeStartRevision === revision) {
      nativeStartRevision = null
      broadcastStatus()
    }
  }
}

/** Gateway RPC with a helpful error when the bridge is down. */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

// ---- Content script messages ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  if (sender.tab?.id === undefined) return
  const type = (message as { type?: unknown }).type
  if (type === 'DSH_CONTENT_READY') {
    // navigation.ts also listens for this frame-ready announcement; only this
    // listener answers it, telling a fresh document whether to watch
    // selections. The revision lets a slow reply lose to a newer broadcast.
    sendResponse({
      selectionWatch: selectionWatchEnabled(sender.tab.windowId),
      selectionWatchEpoch: selectionWatchEpoch,
      selectionWatchRevision: selectionWatchRevision,
      ...(recordingService?.shouldRecordTab(sender.tab.id) === true
        ? { recording: { id: recordingService.snapshot().recordingId } }
        : {}),
    })
    void recordingService?.ensureNetworkProbe(sender.tab.id, sender.frameId ?? 0)
    return
  }
  if (type === 'TRACEFORGE_RECORDING_EVENT') {
    void recordingService?.captureDom((message as { event?: unknown }).event, sender)
    return
  }
  if (type === 'TRACEFORGE_NETWORK_RESPONSE_SHAPE') {
    void recordingService?.captureNetworkResponse((message as { response?: unknown }).response, sender)
    return
  }
  if (type !== 'DSH_SELECTION' || sender.tab === undefined) return
  recordSelection(sender.tab, sender.frameId ?? 0, (message as { selection?: unknown }).selection)
})

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  try {
    const senderUrl = new URL(port.sender?.url ?? '')
    const panelUrl = new URL(chrome.runtime.getURL(TAB_PANEL_PATH))
    if (senderUrl.origin === panelUrl.origin && senderUrl.pathname === panelUrl.pathname) {
      const rawTabId = senderUrl.searchParams.get('tandixTab')
      if (rawTabId !== null && /^\d+$/.test(rawTabId)) panelTabs.set(port, Number(rawTabId))
    }
  } catch { /* Firefox and older global panels have no tab-specific URL. */ }
  const wasIdle = panelPorts.size === 0
  if (panelShutdownTimer !== undefined) {
    clearTimeout(panelShutdownTimer)
    panelShutdownTimer = undefined
  }
  const tabAffinityRebinds = new Map<string, {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()
  panelPorts.add(port)
  if (wasIdle) {
    nativePanelOpened()
    armBridgeKeepalive()
  }
  void settingsReady.then(syncSelectionWatch)
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    if (bridge === null || bridge.state === 'stopped') return startBridge()
  })
  try { port.postMessage(bridgeStatus()) } catch { /* port closed */ }
  try { port.postMessage({ type: 'recording.state', state: recordingStateForPanel(port) }) } catch { /* port closed */ }
  void affinityReady.then(async () => {
    await syncActiveTab()
    sendTabAffinity(port)
  })
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        const rpcSessionId = typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null
          ? (rpcMsg.payload as { sessionId?: string }).sessionId
          : undefined
        const saveSkillIntent = rpcMsg.method === 'session.prompt'
          && typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null
          && (rpcMsg.payload as { tandixSkillSaveIntent?: unknown }).tandixSkillSaveIntent === true
        // turn/start may begin running tools before its RPC acknowledgement arrives.
        if (saveSkillIntent && typeof rpcSessionId === 'string') skillTools.authorizeSave(rpcSessionId)
        const gatewayPayload = saveSkillIntent
          ? Object.fromEntries(Object.entries(rpcMsg.payload as Record<string, unknown>)
            .filter(([key]) => key !== 'tandixSkillSaveIntent'))
          : rpcMsg.payload
        const refresh = rpcSessionId === undefined
          ? Promise.resolve()
          : sessionSnapshotRefreshes.get(rpcSessionId) ?? Promise.resolve()
        const prepare = rpcMsg.method === 'session.prompt'
          ? Promise.resolve().then(async () => {
              await refresh
              return rpcSessionId === undefined || tabAffinity.getSessionTab(rpcSessionId) !== undefined
            })
          : Promise.resolve(true)
        void prepare.then((ready) => {
          if (!ready) throw new Error('This session is not bound to a live browser tab')
          return gatewayRpc(rpcMsg.method, gatewayPayload)
        }).then(
          (result) => {
            try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            if (saveSkillIntent && typeof rpcSessionId === 'string') skillTools.revokeSave(rpcSessionId)
            try {
              port.postMessage({
                type: 'rpc.result',
                id: rpcMsg.id,
                ok: false,
                error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        const messages = responseMessages()
        interactionResponses.begin(
          port,
          response.id,
          () => bridge?.send({
            t: 'respond',
            id: response.id as string,
            rpcId: response.rpcId as string,
            result: response.result as RespondResult,
          }) === true,
          messages,
        )
        break
      }
      case 'settings': {
        const settingsMsg = message as { id?: unknown; settings: Partial<Settings>; forceReconnect?: unknown }
        const requestId = typeof settingsMsg.id === 'string' ? settingsMsg.id : undefined
        void settingsReady.then(async () => {
          try {
            const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token, agentBackend: settings.agentBackend, sandboxDirectory: settings.sandboxDirectory }
            await persistSettings(settingsMsg.settings)
            const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
              || settings.token !== previousConnection.token
              || settings.agentBackend !== previousConnection.agentBackend
              || settings.sandboxDirectory !== previousConnection.sandboxDirectory
              || settingsMsg.forceReconnect === true
            if (panelPorts.size > 0) {
              if (connectionChanged) {
                const failure = await startBridge()
                if (failure !== undefined) throw new Error(failure)
              }
              if (settings.sandboxDirectory !== '' && bridge === null) {
                throw new Error('Could not apply the sandbox directory. Reinstall the native companion, then reconnect.')
              }
              broadcastStatus()
            } else if (connectionChanged) {
              // The settings write outlived its originating panel. Do not keep a
              // healthy socket authenticated with stale connection settings: make
              // the next explicit panel lease start from the persisted values.
              bridgeStartRevision += 1
              bridge?.stop()
              bridge = null
              rpc = null
              caps = null
              broadcastStatus()
              disarmBridgeKeepalive()
            }
            if (requestId !== undefined) {
              try { port.postMessage({ type: 'settings.result', id: requestId, ok: true }) } catch { /* port closed */ }
            }
          } catch (error: unknown) {
            if (requestId === undefined) return
            try {
              port.postMessage({
                type: 'settings.result',
                id: requestId,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          }
        })
        break
      }
      case 'recording.start': {
        const request = message as { id?: unknown }
        if (typeof request.id !== 'string') break
        const id = request.id
        const ownedTabId = panelTabs.get(port)
        if (ownedTabId !== undefined) recordingOwnerTabId = ownedTabId
        void recordingService.start(panelWindows.get(port)).then(
          (result) => {
            try { port.postMessage({ type: 'recording.result', id, ok: true, result }) } catch { /* port closed */ }
          },
          (cause: unknown) => {
            try {
              port.postMessage({
                type: 'recording.result',
                id,
                ok: false,
                error: { message: cause instanceof Error ? cause.message : String(cause) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'recording.stop': {
        const request = message as { id?: unknown }
        if (typeof request.id !== 'string') break
        const id = request.id
        void recordingService.stop().then(
          (result) => {
            try { port.postMessage({ type: 'recording.result', id, ok: true, result }) } catch { /* port closed */ }
          },
          (cause: unknown) => {
            try {
              port.postMessage({
                type: 'recording.result',
                id,
                ok: false,
                error: { message: cause instanceof Error ? cause.message : String(cause) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'recording.get-state': {
        const request = message as { id?: unknown }
        if (typeof request.id !== 'string') break
        try {
          port.postMessage({
            type: 'recording.result',
            id: request.id,
            ok: true,
            result: recordingStateForPanel(port),
          })
        } catch { /* port closed */ }
        break
      }
      case 'recording.export': {
        const request = message as { id?: unknown; recordingId?: unknown; format?: unknown }
        if (typeof request.id !== 'string' || (request.format !== 'json' && request.format !== 'jsonl')) break
        const id = request.id
        void (recordingService === null
          ? Promise.reject(new Error('IndexedDB is unavailable'))
          : recordingService.export(
              typeof request.recordingId === 'string' ? request.recordingId : undefined,
              request.format,
            )).then(
          (result) => {
            try { port.postMessage({ type: 'recording.result', id, ok: true, result }) } catch { /* port closed */ }
          },
          (cause: unknown) => {
            try {
              port.postMessage({
                type: 'recording.result',
                id,
                ok: false,
                error: { message: cause instanceof Error ? cause.message : String(cause) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'panel.window': {
        // The panel reports its own window; a side panel has no sender.tab.
        const registration = message as { windowId?: unknown }
        if (typeof registration.windowId !== 'number'
          || !Number.isInteger(registration.windowId)
          || registration.windowId < 0) break
        panelWindows.set(port, registration.windowId)
        syncSelectionWatch()
        // Keep a recent operation trace while the side panel is open. The
        // user no longer has to arm a separate Teach recording.
        if (import.meta.env.EXT_TARGET === 'firefox') {
          if (recordingService.snapshot().phase !== 'recording') void recordingService.start(registration.windowId).catch(() => {})
        } else {
          void tabForPanel(port, registration.windowId).then((tab) => {
            if (tab?.id !== undefined && tab.active) focusRecordingTab(tab.id, tab.windowId)
          }).catch(() => {})
        }
        try {
          const source = selections.source(registration.windowId)
          const ownedTabId = panelTabs.get(port)
          port.postMessage({ type: 'selection', selection: ownedTabId === undefined || source?.tabId === ownedTabId
            ? selections.current(registration.windowId) : null })
        } catch { /* port closed */ }
        void postResumeHint(port, registration.windowId)
        break
      }
      case 'selection.clear': {
        // The user sent, dismissed, or explicitly abandoned this window's
        // quote. A send/dismiss names the value it acted on so a newer capture
        // that arrived while work was in flight cannot be cleared by mistake.
        const windowId = panelWindows.get(port)
        if (windowId === undefined) break
        const request = message as { selection?: unknown }
        const expected = request.selection === undefined ? undefined : parsePageSelection(request.selection)
        if (expected === null) break
        const source = selections.source(windowId)
        if (panelTabs.get(port) !== undefined && source?.tabId !== panelTabs.get(port)) break
        const cleared = expected === undefined
          ? selections.clear(windowId)
          : selections.clearIfCurrent(windowId, expected)
        if (cleared && source !== null) resetSelectionDedupe([source])
        // Also repairs a panel that acted on a stale attachment.
        broadcastSelection(windowId)
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown; isNew?: boolean }
        const sid = validSessionId(session.sessionId)
        if (sid === undefined) {
          panelActiveSessions.delete(port)
        } else {
          panelActiveSessions.set(port, sid)
          if (session.isNew === true) {
            const bind = Promise.all([affinityReady, pageSessionContexts.ready]).then(async () => {
              const windowId = panelWindows.get(port)
              const tab = windowId === undefined ? await syncActiveTab() : await tabForPanel(port, windowId)
              const summary = tab === undefined ? null : summarizeTab(tab)
              if (summary === null) throw new Error('No active tab is available to bind this session')
              if (tabAffinity.getSessionTab(sid) === undefined) tabAffinity.bindNewSession(sid, summary)
              pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
              resetTabSnapshot(summary.tabId)
              persistTabAffinity()
              broadcastTabAffinity()
              await refreshSessionSnapshot(sid)
            }).catch(() => {})
            sessionSnapshotRefreshes.set(sid, bind)
            void bind.finally(() => {
              if (sessionSnapshotRefreshes.get(sid) === bind) sessionSnapshotRefreshes.delete(sid)
            })
          } else if (tabAffinity.focusSession(sid)) {
            persistTabAffinity()
            broadcastTabAffinity()
          }
          approvals.replay(request => deliverApprovalToPanel(port, request))
        }
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number' || !isTabAffinityDecision(response.decision)) break
        const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        }, port).catch(() => {})
        if ((response.decision === 'follow' || response.decision === 'show-controlled') && sid !== undefined) {
          sessionSnapshotRefreshes.set(sid, decision)
          void decision.finally(() => {
            if (sessionSnapshotRefreshes.get(sid) === decision) sessionSnapshotRefreshes.delete(sid)
          })
        } else {
          void decision
        }
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        const rebindSessionId = validSessionId(request.sessionId) ?? panelActiveSessions.get(port)
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToPanel(port, controller.signal, rebindSessionId)
          .then(() => verifyBoundPage(controller.signal, rebindSessionId)).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.rebind.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityRebindError ? error.code : 'action-failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => {
          const current = tabAffinityRebinds.get(requestId)
          if (current?.controller !== controller) return
          clearTimeout(current.timer)
          tabAffinityRebinds.delete(requestId)
        })
        break
      }
      case 'request-status':
        try {
          port.postMessage(bridgeStatus())
          sendTabAffinity(port)
          port.postMessage({ type: 'recording.state', state: recordingStateForPanel(port) })
          const statusWindowId = panelWindows.get(port)
          if (statusWindowId !== undefined) {
            port.postMessage({ type: 'selection', selection: selections.current(statusWindowId) })
          }
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
          approvals.replay(request => deliverApprovalToPanel(port, request))
          const resumeWindowId = panelWindows.get(port)
          if (resumeWindowId !== undefined) void postResumeHint(port, resumeWindowId)
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    for (const operation of tabAffinityRebinds.values()) {
      clearTimeout(operation.timer)
      operation.controller.abort(new TabAffinityRebindError('cancelled', getUiLocale() === 'zh'
        ? '后台连接已断开，标签页绑定已取消'
        : 'The background connection was lost, so tab binding was cancelled'))
    }
    tabAffinityRebinds.clear()
    const panelWindowId = panelWindows.get(port)
    const panelSessionId = panelActiveSessions.get(port)
    panelActiveSessions.delete(port)
    panelPorts.delete(port)
    approvals.notifyPending(request => [...panelPorts].some(candidate => approvalBelongsToPanel(candidate, request)))
    if (panelSessionId !== undefined) void checkpointSessionPage(panelSessionId)
    interactionResponses.removePort(port)
    if (panelWindowId !== undefined && !hasPanelInWindow(panelWindowId)) {
      const source = selections.source(panelWindowId)
      if (selections.clear(panelWindowId) && source !== null) resetSelectionDedupe([source])
    }
    syncSelectionWatch()
    scheduleBridgeIdle()
  })
})

/** Release the native host only after both panel and webpage jobs stop using it. */
function scheduleBridgeIdle(): void {
  if (hasBridgeConsumers()) return
  if (panelShutdownTimer !== undefined) clearTimeout(panelShutdownTimer)
  panelShutdownTimer = setTimeout(() => {
    panelShutdownTimer = undefined
    if (hasBridgeConsumers()) return
    void recordingService.stop().catch(() => {})
    nativePanelsClosed()
    bridgeStartRevision += 1
    bridge?.suspendReconnect()
    sessionTrustedActionOrigins.clear()
    approvals.notifyPending()
    if (bridge?.state !== 'connected') disarmBridgeKeepalive()
  }, PANEL_DISCONNECT_GRACE_MS)
}

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith(AGENT_APPROVAL_NOTIFICATION_PREFIX)) {
    const id = notificationId.slice(AGENT_APPROVAL_NOTIFICATION_PREFIX.length)
    const windowId = agentApprovalWindows.get(id)
    if (windowId !== undefined) {
      clearAgentApprovalNotification(id)
      openAssistantPanel(windowId)
    }
    return
  }
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  const tabId = approvalNotificationTabs.get(id)
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  openAssistantPanel(windowId, tabId)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (import.meta.env.EXT_TARGET !== 'firefox') void configureTabPanel(tabId)
  if (hasPanelForTab(tabId, windowId)) focusRecordingTab(tabId, windowId)
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (focusedWindow.isCurrent(activationRevision)) observeActiveTab(tab)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.url?.startsWith('http') && hasPanelForTab(tabId, tab.windowId)
    && recordingService.snapshot().phase !== 'recording') {
    focusRecordingTab(tabId, tab.windowId)
  }
  if (hasPanelForTab(tabId, tab.windowId)) void recordingService?.observeTabUpdate(tabId, changeInfo, tab)
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.snapshot().active?.tabId === tabId
      && tabAffinity.snapshot().status === 'handoff' && import.meta.env.EXT_TARGET === 'firefox' && settings.autoFollowTabs) {
      observeActiveSummary(summary)
      return
    }
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  configuredPanelTabs.delete(removedTabId)
  if (import.meta.env.EXT_TARGET !== 'firefox') void configureTabPanel(addedTabId)
  // The old document is gone even though Chrome transfers the tab identity.
  broadcastSelections(selections.clearTab(removedTabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.replaceTab(removedTabId, addedTabId)
  })
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  configuredPanelTabs.delete(tabId)
  void recordingService?.observeTabClosed(tabId)
  broadcastSelections(selections.clearTab(tabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.removeTab(tabId)
  })
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

// A committed navigation replaces a document; a same-document history or
// fragment update does not, and must not drop a quote still on the screen.
// Matching the exact frame keeps an iframe's navigation from invalidating a
// quote taken from its parent page, and vice versa.
chrome.webNavigation.onCommitted.addListener((details) => {
  const { tabId, frameId } = details
  void recordingService?.observeNavigation(details)
  broadcastSelections(selections.clearTab(tabId, frameId))
})

// SPA history and fragment changes keep the same document alive, so retain
// selections but still include the user-visible navigation in the trace.
chrome.webNavigation.onHistoryStateUpdated?.addListener((details) => {
  void recordingService?.observeNavigation(details)
})
chrome.webNavigation.onReferenceFragmentUpdated?.addListener((details) => {
  void recordingService?.observeNavigation(details)
})

// Capture a redacted interface contract: request field names, safe fixed
// codes, input mappings and auth mechanism. Credential values are never kept.
const recordingRequestFilter = { urls: ['http://*/*', 'https://*/*'] }
chrome.webRequest?.onBeforeRequest.addListener((details) => {
  recordingService?.observeNetworkStart(details)
}, recordingRequestFilter, ['requestBody'])
const observeRecordingHeaders = (details: chrome.webRequest.WebRequestHeadersDetails): void => {
  recordingService?.observeNetworkHeaders(details)
}
try {
  chrome.webRequest?.onBeforeSendHeaders?.addListener(observeRecordingHeaders, recordingRequestFilter, ['requestHeaders', 'extraHeaders'])
} catch {
  chrome.webRequest?.onBeforeSendHeaders?.addListener(observeRecordingHeaders, recordingRequestFilter, ['requestHeaders'])
}
chrome.webRequest?.onCompleted.addListener((details) => {
  void recordingService?.observeNetworkEnd(details)
}, recordingRequestFilter)
chrome.webRequest?.onErrorOccurred.addListener((details) => {
  void recordingService?.observeNetworkEnd(details)
}, recordingRequestFilter)

// Download monitoring is passive and active only during an explicit recording.
chrome.downloads?.onCreated.addListener((item) => {
  void recordingService?.observeDownloadCreated(item)
})
chrome.downloads?.onChanged.addListener((delta) => {
  void recordingService?.observeDownloadChanged(delta)
})

// Ports are cleaned up by their own disconnect; only the window's quote is
// left behind when the whole window goes away.
chrome.windows.onRemoved.addListener((windowId) => {
  selections.clear(windowId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  if (!hasBridgeConsumers()) {
    if (bridge === null || bridge.state !== 'connected') disarmBridgeKeepalive()
    return
  }
  // `stopped` is intentionally terminal until an explicit panel reopen or
  // settings save. In particular, code 4000 means another browser owns the
  // single bridge slot and the keepalive must not reclaim it.
  if (bridge === null || bridge.state === 'reconnecting') {
    void settingsReady.then(() => startBridge())
  }
})

// ---- Boot ----

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function openAssistantPanel(windowId?: number, tabId?: number): void {
  if (import.meta.env.EXT_TARGET === 'firefox') {
    const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
    if (sidebar === undefined) return
    void Promise.resolve(sidebar.open()).catch(() => {})
    return
  }
  if (tabId !== undefined) {
    void chrome.sidePanel.open({ tabId }).catch(() => {})
    void chrome.tabs.update(tabId, { active: true }).catch(() => {})
    if (windowId !== undefined) void chrome.windows.update(windowId, { focused: true }).catch(() => {})
    return
  }
  const active = tabAffinity.snapshot().active
  if (active !== null && (windowId === undefined || active.windowId === windowId)) {
    void chrome.sidePanel.open({ tabId: active.tabId }).catch(() => {})
  }
}

const TAB_PANEL_PATH = 'panel/index.html'
const configuredPanelTabs = new Set<number>()

function configureTabPanel(tabId: number): Promise<void> {
  if (configuredPanelTabs.has(tabId)) return Promise.resolve()
  if (typeof chrome.sidePanel?.setOptions !== 'function') return Promise.resolve()
  return chrome.sidePanel.setOptions({
    tabId,
    path: `${TAB_PANEL_PATH}?tandixTab=${tabId}`,
    enabled: true,
  }).then(() => { configuredPanelTabs.add(tabId) }).catch(() => {})
}

// Open the side panel when the toolbar icon is clicked.
// Chrome 116+ uses chrome.sidePanel; Firefox has no sidePanel API, so the
// action click opens the sidebar via sidebarAction.open() (user gesture).
if (import.meta.env.EXT_TARGET === 'firefox') {
  chrome.action.onClicked.addListener(() => { openAssistantPanel() })
} else {
  // The global panel must be disabled. Each tab gets its own instance, which
  // Chrome opens only after the user clicks the extension action in that tab.
  void (async () => {
    if (typeof chrome.sidePanel?.setOptions === 'function') {
      await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {})
    }
    const tabs = await chrome.tabs.query({}).catch(() => [])
    await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [configureTabPanel(tab.id)]))
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  })().catch(() => {})
  chrome.tabs.onCreated?.addListener((tab) => {
    if (tab.id !== undefined) void configureTabPanel(tab.id)
  })
}

// Alarms survive some extension/service-worker restarts. Remove any stale
// schedule left by an older eager-connection build; onConnect re-arms it.
disarmBridgeKeepalive()

// `settingsReady` intentionally has no bridge-start continuation: opening a
// side panel is the first action allowed to claim the bridge connection.
