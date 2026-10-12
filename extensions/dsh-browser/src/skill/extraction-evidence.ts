import type { RecordedValue, RecordingEventInput, RecordingTarget } from '../recording/schema.ts'
import { sanitizeUrlForModel } from '../security/url-privacy.ts'

export const SKILL_EXTRACTION_EVIDENCE_VERSION = 'tandix.skill-extraction-evidence/v1' as const

export interface SkillTimelineTarget {
  tag: string
  selector: string
  role?: string
  name?: string
  text?: string
  control?: RecordingTarget['control']
  href?: string
  download?: boolean
}

export interface SkillTimelineEvent {
  id: string
  sequence: number
  kind: RecordingEventInput['kind']
  capturedAt: number
  capturedAtIso: string
  offsetMs: number
  intervalFromPreviousMs: number
  tab: { id: number; title: string; url: string }
  frame: { id: number; url: string }
  target?: SkillTimelineTarget
  details: Record<string, unknown>
}

export interface SkillExtractionEvidence {
  schemaVersion: typeof SKILL_EXTRACTION_EVIDENCE_VERSION
  intentHint: string
  window: {
    startedAt: number
    endedAt: number
    durationMs: number
    eventCount: number
    origins: string[]
    eventKinds: Partial<Record<RecordingEventInput['kind'], number>>
  }
  timeline: SkillTimelineEvent[]
}

function safeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch { return null }
}

function safeTarget(target: RecordingTarget): SkillTimelineTarget {
  return {
    tag: target.tag,
    selector: target.selector,
    ...(target.role === undefined ? {} : { role: target.role }),
    ...(target.name === undefined ? {} : { name: target.name }),
    ...(target.text === undefined ? {} : { text: target.text }),
    ...(target.control === undefined ? {} : { control: target.control }),
    ...(target.href === undefined ? {} : { href: sanitizeUrlForModel(target.href) }),
    ...(target.download === undefined ? {} : { download: target.download }),
  }
}

function redactedValue(value: RecordedValue): Record<string, unknown> {
  if (value.kind === 'secret') {
    return { kind: 'secret', placeholder: value.placeholder, parameterHint: value.parameter }
  }
  return {
    kind: 'literal-redacted',
    placeholder: '{{input}}',
    characterCount: value.value.length,
    isEmpty: value.value.length === 0,
  }
}

function eventDetails(event: RecordingEventInput): Record<string, unknown> {
  switch (event.kind) {
    case 'click':
      return { button: event.button }
    case 'input':
    case 'change':
      return { value: redactedValue(event.value) }
    case 'select':
      return {
        value: redactedValue(event.value),
        selectedOptionCount: event.selectedLabels.length,
        selectedLabels: event.selectedLabels.map(() => '{{selection}}'),
      }
    case 'submit':
      return {}
    case 'keydown':
      return { key: event.key, code: event.code, modifiers: event.modifiers }
    case 'navigation':
      return {
        url: sanitizeUrlForModel(event.url),
        ...(event.transitionType === undefined ? {} : { transitionType: event.transitionType }),
        ...(event.transitionQualifiers === undefined ? {} : { transitionQualifiers: event.transitionQualifiers }),
      }
    case 'tab':
      return {
        action: event.action,
        ...(event.previousTabId === undefined ? {} : { previousTabId: event.previousTabId }),
      }
    case 'network':
      return {
        url: sanitizeUrlForModel(event.url),
        method: event.method,
        durationMs: event.durationMs,
        requestContract: event.request,
        ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
        ...(event.failed === undefined ? {} : { failed: event.failed }),
        ...(event.trigger === undefined ? {} : {
          observedTrigger: { kind: event.trigger.kind, target: safeTarget(event.trigger.target) },
        }),
      }
    case 'network-response':
      return {
        url: sanitizeUrlForModel(event.url),
        method: event.method,
        statusCode: event.statusCode,
        responseJsonSchema: event.response.fields,
        responseListPaths: event.response.listPaths,
      }
    case 'download':
      return {
        downloadId: event.downloadId,
        url: sanitizeUrlForModel(event.url),
        ...(event.finalUrl === undefined ? {} : { finalUrl: sanitizeUrlForModel(event.finalUrl) }),
        ...(event.filename === undefined ? {} : { filename: event.filename.slice(0, 240) }),
        state: event.state,
        association: event.association,
        observedTrigger: safeTarget(event.trigger),
      }
  }
}

function eventTarget(event: RecordingEventInput): SkillTimelineTarget | undefined {
  switch (event.kind) {
    case 'click':
    case 'input':
    case 'change':
    case 'select':
    case 'submit':
    case 'keydown':
      return safeTarget(event.target)
    default:
      return undefined
  }
}

/**
 * Preserve the complete bounded trace for model judgment. Deterministic work is
 * limited to ordering, timing metadata, URL/value redaction and shape validation.
 */
export function buildSkillExtractionEvidence(
  events: RecordingEventInput[],
  intentHint = '',
): SkillExtractionEvidence {
  const ordered = [...events].sort((left, right) => left.capturedAt - right.capturedAt)
  const startedAt = ordered[0]?.capturedAt ?? 0
  const endedAt = ordered.at(-1)?.capturedAt ?? startedAt
  const eventKinds: Partial<Record<RecordingEventInput['kind'], number>> = {}
  const origins = new Set<string>()
  const timeline = ordered.map((event, index): SkillTimelineEvent => {
    eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1
    for (const raw of [event.tab.url, event.frame.url]) {
      const origin = safeOrigin(raw)
      if (origin !== null) origins.add(origin)
    }
    if (event.kind === 'navigation' || event.kind === 'network' || event.kind === 'network-response') {
      const origin = safeOrigin(event.url)
      if (origin !== null) origins.add(origin)
    } else if (event.kind === 'download') {
      const origin = safeOrigin(event.finalUrl ?? event.url)
      if (origin !== null) origins.add(origin)
    }
    const target = eventTarget(event)
    return {
      id: `event-${index + 1}`,
      sequence: index + 1,
      kind: event.kind,
      capturedAt: event.capturedAt,
      capturedAtIso: new Date(event.capturedAt).toISOString(),
      offsetMs: Math.max(0, event.capturedAt - startedAt),
      intervalFromPreviousMs: index === 0 ? 0 : Math.max(0, event.capturedAt - ordered[index - 1]!.capturedAt),
      tab: { id: event.tab.id, title: event.tab.title.slice(0, 300), url: sanitizeUrlForModel(event.tab.url) },
      frame: { id: event.frame.id, url: sanitizeUrlForModel(event.frame.url) },
      ...(target === undefined ? {} : { target }),
      details: eventDetails(event),
    }
  })

  return {
    schemaVersion: SKILL_EXTRACTION_EVIDENCE_VERSION,
    intentHint: intentHint.replace(/\s+/gu, ' ').trim().slice(0, 500),
    window: {
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      eventCount: ordered.length,
      origins: [...origins].slice(0, 20),
      eventKinds,
    },
    timeline,
  }
}

export function hasSkillExtractionCandidates(evidence: SkillExtractionEvidence): boolean {
  return evidence.timeline.some((event) => event.kind === 'click' || event.kind === 'input'
    || event.kind === 'change' || event.kind === 'select' || event.kind === 'submit' || event.kind === 'keydown')
}
