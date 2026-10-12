/** TraceForge's versioned, JSON-serializable browser recording contract. */

export const RECORDING_SCHEMA_VERSION = 'traceforge.recording/v1' as const
export const REDACTED_VALUE = '{{secret}}' as const

export type RecordingStatus = 'recording' | 'stopped'
export type RecordingEventKind =
  | 'click'
  | 'input'
  | 'change'
  | 'select'
  | 'submit'
  | 'keydown'
  | 'navigation'
  | 'tab'
  | 'network'
  | 'network-response'
  | 'download'

export interface RecordingTarget {
  tag: string
  selector: string
  role?: string
  name?: string
  text?: string
  control?: 'button' | 'link' | 'input' | 'select' | 'custom' | 'other'
  href?: string
  hrefHasHiddenQuery?: boolean
  download?: boolean
}

export type RecordedValue =
  | { kind: 'literal'; value: string }
  | { kind: 'secret'; parameter: string; placeholder: typeof REDACTED_VALUE }

export interface TabDescriptor {
  id: number
  windowId: number
  title: string
  url: string
}

export interface FrameDescriptor {
  id: number
  url: string
}

export type NetworkScalar = string | number | boolean | null

export interface NetworkValueEvidence {
  /** Fixed values may be reused; input/redacted values never expose the observed value. */
  kind: 'fixed' | 'input' | 'redacted'
  valueType: 'string' | 'number' | 'boolean' | 'null'
  value?: Exclude<NetworkScalar, null>
  placeholder?: '{{input}}' | '{{secret}}'
  format?: 'date' | 'date-time' | 'iso-8601' | 'unix-seconds' | 'unix-milliseconds'
  source?: { name?: string; text?: string; control?: RecordingTarget['control']; selectedLabels?: string[] }
}

export interface NetworkRequestEvidence {
  query?: Record<string, NetworkValueEvidence>
  body?: Record<string, NetworkValueEvidence>
  bodyEncoding?: 'json' | 'form'
  auth: { kind: 'none' | 'cookie' | 'bearer' | 'cookie-and-bearer' | 'header-token' | 'unknown' }
}

export interface JsonFieldEvidence {
  path: string
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
}

export interface NetworkResponseEvidence {
  fields: JsonFieldEvidence[]
  listPaths: string[]
}

interface EventBase {
  id: string
  recordingId: string
  sequence: number
  capturedAt: number
  tab: TabDescriptor
  frame: FrameDescriptor
}

export type RecordingEvent = EventBase & (
  | { kind: 'click'; target: RecordingTarget; button: number }
  | { kind: 'input' | 'change'; target: RecordingTarget; value: RecordedValue }
  | { kind: 'select'; target: RecordingTarget; value: RecordedValue; selectedLabels: string[] }
  | { kind: 'submit'; target: RecordingTarget }
  | { kind: 'keydown'; target: RecordingTarget; key: string; code: string; modifiers: string[] }
  | { kind: 'navigation'; url: string; transitionType?: string; transitionQualifiers?: string[] }
  | { kind: 'tab'; action: 'initial' | 'activated' | 'updated' | 'closed'; previousTabId?: number }
  | { kind: 'network'; url: string; method: string; statusCode?: number; durationMs: number; failed?: boolean; request: NetworkRequestEvidence; trigger?: { kind: 'click' | 'input' | 'change' | 'select' | 'submit' | 'keydown'; target: RecordingTarget } }
  | { kind: 'network-response'; url: string; method: string; statusCode: number; response: NetworkResponseEvidence }
  | { kind: 'download'; downloadId: number; url: string; finalUrl?: string; urlHasHiddenQuery?: boolean; filename?: string; state: 'started' | 'complete' | 'interrupted'; association: 'link' | 'recent-click'; trigger: RecordingTarget }
)

type StripEventMetadata<T> = T extends unknown ? Omit<T, 'id' | 'recordingId' | 'sequence'> : never
export type RecordingEventInput = StripEventMetadata<RecordingEvent>

export interface RecordingSummary {
  eventCount: number
  eventTypes: Partial<Record<RecordingEventKind, number>>
  tabCount: number
  navigationCount: number
  sensitiveEventCount: number
  durationMs: number
}

export interface RecordingMetadata {
  schemaVersion: typeof RECORDING_SCHEMA_VERSION
  id: string
  /** Display brand is intentionally not schema-locked so older TraceForge recordings remain readable. */
  product: { name: string; tagline: string }
  status: RecordingStatus
  title: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  windowId: number
  tabIds: number[]
  startPage: { title: string; url: string }
  summary: RecordingSummary
}

export interface BrowserRecording extends RecordingMetadata {
  events: RecordingEvent[]
}

/** Page-side payload. It is parsed again by the service worker before storage. */
export type DomCaptureEvent =
  | { kind: 'click'; capturedAt: number; target: RecordingTarget; button: number }
  | { kind: 'input' | 'change'; capturedAt: number; target: RecordingTarget; value: RecordedValue }
  | { kind: 'select'; capturedAt: number; target: RecordingTarget; value: RecordedValue; selectedLabels: string[] }
  | { kind: 'submit'; capturedAt: number; target: RecordingTarget }
  | { kind: 'keydown'; capturedAt: number; target: RecordingTarget; key: string; code: string; modifiers: string[] }

export interface NetworkResponseCapture {
  recordingId: string
  capturedAt: number
  url: string
  method: string
  statusCode: number
  fields: JsonFieldEvidence[]
  listPaths: string[]
}

const MAX_TEXT = 2_000
const MAX_SHORT_TEXT = 240
const MAX_SELECTOR = 1_000

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, max = MAX_SHORT_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** Keep a useful address without persisting credentials or signed parameters. */
export function sanitizeRecordedUrl(value: string): { url: string; hadHiddenQuery: boolean } {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { url: '', hadHiddenQuery: false }
    const hadHiddenQuery = parsed.search !== ''
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return { url: parsed.toString().slice(0, MAX_SELECTOR), hadHiddenQuery }
  } catch {
    return { url: '', hadHiddenQuery: false }
  }
}

function parseTarget(value: unknown): RecordingTarget | null {
  const candidate = record(value)
  if (candidate === null) return null
  const tag = text(candidate.tag, 40).toLowerCase()
  const selector = text(candidate.selector, MAX_SELECTOR)
  if (tag === '' || selector === '') return null
  const role = text(candidate.role)
  const name = text(candidate.name)
  const targetText = text(candidate.text)
  const control = candidate.control === 'button' || candidate.control === 'link'
    || candidate.control === 'input' || candidate.control === 'select'
    || candidate.control === 'custom' || candidate.control === 'other'
    ? candidate.control : undefined
  const href = sanitizeRecordedUrl(text(candidate.href, MAX_SELECTOR)).url
  return {
    tag,
    selector,
    ...(role === '' ? {} : { role }),
    ...(name === '' ? {} : { name }),
    ...(targetText === '' ? {} : { text: targetText }),
    ...(control === undefined ? {} : { control }),
    ...(href === '' ? {} : { href }),
    ...(candidate.hrefHasHiddenQuery === true ? { hrefHasHiddenQuery: true } : {}),
    ...(candidate.download === true ? { download: true } : {}),
  }
}

function parseValue(value: unknown): RecordedValue | null {
  const candidate = record(value)
  if (candidate?.kind === 'secret') {
    return {
      kind: 'secret',
      parameter: text(candidate.parameter, 80) || 'secret',
      placeholder: REDACTED_VALUE,
    }
  }
  if (candidate?.kind !== 'literal' || typeof candidate.value !== 'string') return null
  return { kind: 'literal', value: candidate.value.slice(0, MAX_TEXT) }
}

/** Validate and bound page-authored recording data at the extension boundary. */
export function parseDomCaptureEvent(value: unknown): DomCaptureEvent | null {
  const candidate = record(value)
  if (candidate === null || typeof candidate.kind !== 'string') return null
  const target = parseTarget(candidate.target)
  if (target === null) return null
  const capturedAt = typeof candidate.capturedAt === 'number' && Number.isFinite(candidate.capturedAt)
    ? candidate.capturedAt
    : Date.now()
  switch (candidate.kind) {
    case 'click':
      return { kind: 'click', capturedAt, target, button: Number.isInteger(candidate.button) ? Number(candidate.button) : 0 }
    case 'input':
    case 'change': {
      const parsed = parseValue(candidate.value)
      return parsed === null ? null : { kind: candidate.kind, capturedAt, target, value: parsed }
    }
    case 'select': {
      const parsed = parseValue(candidate.value)
      if (parsed === null) return null
      const selectedLabels = Array.isArray(candidate.selectedLabels)
        ? candidate.selectedLabels.map((label) => text(label)).filter(Boolean).slice(0, 20)
        : []
      return { kind: 'select', capturedAt, target, value: parsed, selectedLabels }
    }
    case 'submit':
      return { kind: 'submit', capturedAt, target }
    case 'keydown': {
      const modifiers = Array.isArray(candidate.modifiers)
        ? candidate.modifiers.map((modifier) => text(modifier, 20)).filter(Boolean).slice(0, 4)
        : []
      return {
        kind: 'keydown',
        capturedAt,
        target,
        key: text(candidate.key, 80),
        code: text(candidate.code, 80),
        modifiers,
      }
    }
    default:
      return null
  }
}

/** Validate the value-free JSON shape emitted by the main-world response probe. */
export function parseNetworkResponseCapture(value: unknown): NetworkResponseCapture | null {
  const candidate = record(value)
  if (candidate === null) return null
  const recordingId = text(candidate.recordingId, 100)
  const url = text(candidate.url, MAX_SELECTOR)
  const method = text(candidate.method, 12).toUpperCase()
  const capturedAt = typeof candidate.capturedAt === 'number' && Number.isFinite(candidate.capturedAt)
    ? candidate.capturedAt : Date.now()
  const statusCode = Number(candidate.statusCode)
  if (recordingId === '' || url === '' || method === '' || !Number.isInteger(statusCode)) return null
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'boolean', 'null'])
  const fields: JsonFieldEvidence[] = []
  for (const item of Array.isArray(candidate.fields) ? candidate.fields.slice(0, 200) : []) {
    const entry = record(item)
    const path = text(entry?.path, 500)
    const type = text(entry?.type, 20)
    if (path === '' || !allowedTypes.has(type)) continue
    fields.push({ path, type: type as JsonFieldEvidence['type'] })
  }
  const listPaths = Array.isArray(candidate.listPaths)
    ? candidate.listPaths.map((path) => text(path, 500)).filter(Boolean).slice(0, 50)
    : []
  if (fields.length === 0) return null
  return { recordingId, capturedAt, url, method, statusCode, fields, listPaths }
}

export function emptyRecordingSummary(): RecordingSummary {
  return { eventCount: 0, eventTypes: {}, tabCount: 0, navigationCount: 0, sensitiveEventCount: 0, durationMs: 0 }
}

export function summarizeEvent(metadata: RecordingMetadata, event: RecordingEvent): RecordingSummary {
  const eventTypes = { ...metadata.summary.eventTypes }
  eventTypes[event.kind] = (eventTypes[event.kind] ?? 0) + 1
  return {
    eventCount: metadata.summary.eventCount + 1,
    eventTypes,
    tabCount: new Set([...metadata.tabIds, event.tab.id]).size,
    navigationCount: metadata.summary.navigationCount + (event.kind === 'navigation' ? 1 : 0),
    sensitiveEventCount: metadata.summary.sensitiveEventCount
      + (('value' in event && event.value.kind === 'secret') ? 1 : 0),
    durationMs: Math.max(0, event.capturedAt - metadata.startedAt),
  }
}
