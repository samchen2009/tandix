/**
 * Optional macOS Chrome companion. The extension never starts a process by
 * itself: Chrome launches only the explicitly installed, allowlisted Native
 * Messaging host when a panel needs a local bridge that is not yet running.
 */

import type { AgentPreference } from '../agent-backend.ts'

const HOST_NAME = 'io.traceforge.bridge'
const IDLE_STOP_MS = 10 * 60_000
const START_TIMEOUT_MS = 60_000
const UNAVAILABLE_RETRY_MS = 5 * 60_000

let port: chrome.runtime.Port | null = null
let pending: Promise<string | undefined> | null = null
let pendingBackend: AgentPreference | null = null
let pendingSandboxDirectory: string | null = null
let finishPending: ((url: string | undefined) => void) | null = null
let idleTimer: ReturnType<typeof setTimeout> | undefined
let unavailableUntil = 0
let hostWasReady = false

function validLocalBridgeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.pathname === '/ext/bridge'
  } catch {
    return false
  }
}

function settle(url: string | undefined): void {
  finishPending?.(url)
  finishPending = null
  pending = null
  pendingBackend = null
  pendingSandboxDirectory = null
}

function dropPort(current: chrome.runtime.Port, suppressRetry = false): void {
  if (port !== current) return
  // Reading lastError prevents Chrome from logging an unhandled native-host
  // failure when the companion has not been installed yet.
  const error = chrome.runtime.lastError?.message
  if (error !== undefined) console.warn(`Tandix native companion: ${error}`)
  port = null
  settle(undefined)
  if (!suppressRetry) unavailableUntil = hostWasReady ? 0 : Date.now() + UNAVAILABLE_RETRY_MS
}

/** Cancel an idle shutdown when any side panel opens. */
export function nativePanelOpened(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer)
  idleTimer = undefined
  if (port === null) unavailableUntil = 0
}

/** Stop only a host-owned dsh after every side panel has been closed. */
export function nativePanelsClosed(): void {
  if (port === null || idleTimer !== undefined) return
  idleTimer = setTimeout(() => {
    idleTimer = undefined
    const current = port
    if (current === null) return
    port = null
    settle(undefined)
    current.disconnect()
  }, IDLE_STOP_MS)
}

/** Prefer a signed-in local Codex agent; otherwise reuse or start dsh. */
export function ensureNativeBridge(backend: AgentPreference = 'auto', sandboxDirectory = ''): Promise<string | undefined> {
  // An explicit user choice should retry immediately after a prior automatic
  // probe failed, rather than inheriting its five-minute cooldown.
  if (backend !== 'auto') unavailableUntil = 0
  if (import.meta.env.EXT_TARGET === 'firefox' || Date.now() < unavailableUntil) {
    return Promise.resolve(undefined)
  }
  if (pending !== null) {
    return pendingBackend === backend && pendingSandboxDirectory === sandboxDirectory
      ? pending : pending.then(() => ensureNativeBridge(backend, sandboxDirectory))
  }
  let current = port
  if (current === null) {
    try {
      current = chrome.runtime.connectNative(HOST_NAME)
    } catch (error: unknown) {
      console.warn('Tandix native companion is unavailable', error)
      unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS
      return Promise.resolve(undefined)
    }
    port = current
    current.onDisconnect.addListener(() => dropPort(current!))
  }
  pending = new Promise(resolve => { finishPending = resolve })
  pendingBackend = backend
  pendingSandboxDirectory = sandboxDirectory
  const request = pending
  const active = current
  const timeout = setTimeout(() => {
    if (port !== active || pending === null) return
    console.warn('Tandix native companion: timed out waiting for the local host response (60 seconds).')
    active.onMessage.removeListener(onMessage)
    port = null
    settle(undefined)
    unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS
    active.disconnect()
  }, START_TIMEOUT_MS)
  const onMessage = (message: unknown): void => {
    if (port !== active || typeof message !== 'object' || message === null) return
    const frame = message as { type?: unknown; wsUrl?: unknown; message?: unknown; sandboxConfigured?: unknown }
    if (frame.type === 'ready' && validLocalBridgeUrl(frame.wsUrl)) {
      clearTimeout(timeout)
      active.onMessage.removeListener(onMessage)
      hostWasReady = true
      if (sandboxDirectory !== '' && frame.sandboxConfigured !== true) {
        console.warn('Tandix native companion is outdated; reinstall it to apply the sandbox directory.')
        settle(undefined)
      } else {
        settle(frame.wsUrl)
      }
    } else if (frame.type === 'error') {
      clearTimeout(timeout)
      active.onMessage.removeListener(onMessage)
      console.warn('Tandix native companion:', frame.message)
      port = null
      settle(undefined)
      unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS
      active.disconnect()
    }
  }
  active.onMessage.addListener(onMessage)
  try {
    active.postMessage({ type: 'ensure', backend, sandboxDirectory })
  } catch (error: unknown) {
    clearTimeout(timeout)
    active.onMessage.removeListener(onMessage)
    console.warn('Tandix native companion:', error)
    port = null
    settle(undefined)
    unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS
    active.disconnect()
  }
  return request
}
