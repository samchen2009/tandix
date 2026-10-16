/** Read-only evidence retrieval for an Agent investigating long user histories. */
const MAX_EVENTS = 100_000
const MAX_OBSERVATION = 2_000
const CONFIDENCE = new Set(['likely', 'possible', 'insufficient'])
const OUTCOMES = new Set(['observed', 'failed', 'unknown'])

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function string(value, label, max = 500) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be text of at most ${max} characters`)
  return value
}
function optionalText(value, label, max = 500) { return value === undefined ? undefined : string(value, label, max) }

function safeUrl(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    url.pathname = url.pathname.split('/').map(part => /^\d{5,}$|^[a-f0-9]{12,}$/iu.test(part)
      || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(part) ? ':id' : part).join('/')
    return url.toString()
  } catch { return undefined }
}

/** Accept browser recording exports, redacted extraction evidence, or activity-trace/v1. */
export function normalizeHistory(input) {
  const raw = Array.isArray(input) ? input : input?.events ?? input?.timeline
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS) {
    throw new Error(`History must contain 1–${MAX_EVENTS} events; no events are silently discarded`)
  }
  const ids = new Set()
  const events = raw.map((event, index) => {
    if (!record(event)) throw new Error(`Event ${index + 1} must be an object`)
    const id = event.id === undefined ? `event-${index + 1}` : string(event.id, 'Event ID', 120)
    if (!/^[\p{L}\p{N}_.:-]+$/u.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate event ID: ${id}`)
    ids.add(id)
    const timestamp = event.at ?? event.capturedAt ?? event.capturedAtIso
    const at = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
    if (!Number.isFinite(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) throw new Error(`Invalid time on ${id}`)
    const context = event.context ?? event.tab ?? {}
    if (!record(context)) throw new Error(`Invalid context on ${id}`)
    const target = event.target ?? {}
    if (!record(target)) throw new Error(`Invalid target on ${id}`)
    const details = record(event.details) ? event.details : {}
    const facts = {}
    for (const key of ['action', 'state', 'method', 'transitionType', 'association', 'key']) {
      const value = event[key] ?? details[key]
      if (typeof value === 'string') facts[key] = string(value, key)
    }
    for (const key of ['downloadId', 'statusCode', 'durationMs', 'button', 'previousTabId', 'selectedOptionCount']) {
      const value = event[key] ?? details[key]
      if (typeof value === 'number' && Number.isFinite(value)) facts[key] = value
    }
    if (typeof (event.failed ?? details.failed) === 'boolean') facts.failed = event.failed ?? details.failed
    if (Array.isArray(event.selectedLabels ?? details.selectedLabels)) {
      facts.selectedOptionCount = (event.selectedLabels ?? details.selectedLabels).length
    }
    const filename = event.filename ?? details.filename
    if (typeof filename === 'string') facts.filename = string(filename.split(/[\\/]/u).at(-1), 'Filename')
    for (const key of ['url', 'finalUrl']) {
      const value = safeUrl(event[key] ?? details[key])
      if (value !== undefined) facts[key] = value
    }
    const value = event.value ?? details.value
    if (record(value)) {
      facts.value = value.kind === 'secret'
        ? { kind: 'secret', redacted: true }
        : { kind: 'redacted', characterCount: typeof value.value === 'string' ? value.value.length : value.characterCount }
    }
    return {
      id, at: new Date(at).toISOString(), kind: string(event.kind, 'Event kind', 80),
      context: {
        title: optionalText(context.title, 'Page title'), url: safeUrl(context.url),
        ...(Number.isInteger(context.id ?? context.tabId) ? { tabId: context.id ?? context.tabId } : {}),
      },
      ...(Object.keys(target).length === 0 ? {} : { target: {
        name: optionalText(target.name ?? target.text, 'Target name'), role: optionalText(target.role, 'Target role'),
        control: optionalText(target.control, 'Target control'),
      } }),
      ...(event.observation === undefined ? {} : { observation: string(event.observation, 'Redacted observation', MAX_OBSERVATION) }),
      ...(Object.keys(facts).length === 0 ? {} : { facts }),
    }
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const declaredCount = input?.summary?.eventCount ?? input?.window?.eventCount
  return {
    schemaVersion: 'tandix.activity-evidence/v1',
    synthetic: input?.synthetic === true,
    events,
    coverage: {
      eventCount: events.length, startedAt: events[0].at, endedAt: events.at(-1).at,
      limitations: [
        'Evidence is a metadata projection: typed values and selected labels are hidden; unprojected source fields are unavailable to this investigation.',
        ...(Array.isArray(input?.captureLimitations) ? input.captureLimitations.map(item => string(item, 'Capture limitation', 2_000)) : []),
        ...(Number.isSafeInteger(declaredCount) && declaredCount > events.length
          ? [`Source reports ${declaredCount} events but exports only ${events.length}; earlier events may be missing.`] : []),
      ],
    },
  }
}

function page(items, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Offset must be nonnegative and limit must be 1–200')
  }
  return { total: items.length, offset, nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit) }
}

/** Storage pagination only: no idle-gap segmentation and no task classification. */
export function indexHistory(history, offset = 0, limit = 40) {
  const entries = history.events.map(event => {
    const fullSummary = [event.context.title, event.target?.name, event.observation,
      JSON.stringify(event.facts ?? {})].filter(Boolean).join(' | ')
    return { id: event.id, at: event.at, kind: event.kind, url: event.context.url,
      summary: fullSummary.slice(0, 360), summaryTruncated: fullSummary.length > 360 }
  })
  return { coverage: history.coverage, synthetic: history.synthetic, ...page(entries, offset, limit) }
}

/** Searches the whole available history; results are evidence candidates, not associations. */
export function searchHistory(history, query, offset = 0, limit = 40) {
  const terms = string(query, 'Search query', 500).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) throw new Error('Search query cannot be empty')
  const found = history.events.filter(event => {
    const text = JSON.stringify(event).toLocaleLowerCase()
    return terms.some(term => text.includes(term))
  })
  return { query, matching: 'any literal term; not semantic classification', ...page(found, offset, limit) }
}

export function retrieveEvents(history, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) throw new Error('Retrieve 1–200 event IDs')
  const lookup = new Map(history.events.map(event => [event.id, event]))
  return ids.map(id => {
    const event = lookup.get(id)
    if (event === undefined) throw new Error(`Unknown event ID: ${id}`)
    return event
  })
}

/** Checks evidence references and coverage, NEVER the truth of an inferred task. */
export function validateInference(history, report) {
  if (!record(report) || report.schemaVersion !== 'tandix.activity-inference/v1') throw new Error('Invalid inference report schema')
  string(report.answer, 'Answer', 20_000)
  const known = new Set(history.events.map(event => event.id))
  const refs = (items, label, nonempty = false) => {
    if (!Array.isArray(items) || (nonempty && items.length === 0)) throw new Error(`${label} must be an event-ID array`)
    const seen = new Set()
    for (const id of items) {
      if (!known.has(id)) throw new Error(`${label}: unknown event ID ${id}`)
      if (seen.has(id)) throw new Error(`${label}: duplicate event ID ${id}`)
      seen.add(id)
    }
    return seen
  }
  const reviewed = refs(report.reviewedEventIds, 'Reviewed events', true)
  const assigned = refs(report.unassignedEventIds, 'Unassigned events')
  const listText = (items, label) => {
    if (!Array.isArray(items)) throw new Error(`${label} must be a text array`)
    items.forEach(item => string(item, label, 5_000))
  }
  if (!Array.isArray(report.tasks)) throw new Error('Tasks must be an array')
  const taskIds = new Set()
  for (const task of report.tasks) {
    if (!record(task)) throw new Error('Invalid task')
    string(task.id, 'Task ID', 120)
    if (taskIds.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`)
    taskIds.add(task.id)
    string(task.title, 'Task title', 500); string(task.interpretation, 'Interpretation', 10_000)
    if (!CONFIDENCE.has(task.confidence)) throw new Error('Invalid task confidence')
    const support = refs(task.eventIds, 'Supporting events', true)
    const counters = refs(task.counterEvidenceIds, 'Counter evidence')
    const taskEvents = new Set([...support, ...counters])
    for (const id of taskEvents) assigned.add(id)
    const taskRefs = (ids, label, nonempty = true) => {
      for (const id of refs(ids, label, nonempty)) if (!taskEvents.has(id)) throw new Error(`${label}: ${id} is outside this task's evidence`)
    }
    if (!Array.isArray(task.segments) || task.segments.length === 0) throw new Error('Task needs evidence segments')
    for (const segment of task.segments) {
      if (!record(segment)) throw new Error('Invalid segment')
      string(segment.summary, 'Segment summary', 5_000); taskRefs(segment.eventIds, 'Segment events')
    }
    if (!Array.isArray(task.links)) throw new Error('Links must be an array')
    for (const link of task.links) {
      if (!record(link)) throw new Error('Invalid inferred link')
      taskRefs([link.fromEventId, link.toEventId], 'Link endpoints')
      taskRefs(link.basisEventIds, 'Link basis')
      string(link.claim, 'Link claim', 5_000)
      if (!CONFIDENCE.has(link.confidence)) throw new Error('Invalid link confidence')
      listText(link.alternatives, 'Link alternatives')
      if (link.alternatives.length === 0) throw new Error('Inferred link needs alternatives or a missing observation')
    }
    if (!record(task.outcome) || !OUTCOMES.has(task.outcome.status)) throw new Error('Invalid outcome')
    string(task.outcome.description, 'Outcome description', 5_000)
    taskRefs(task.outcome.eventIds, 'Outcome evidence', task.outcome.status !== 'unknown')
    listText(task.uncertainties, 'Task uncertainties')
  }
  for (const id of assigned) if (!reviewed.has(id)) throw new Error(`Referenced event ${id} was not declared reviewed`)
  for (const id of reviewed) if (!assigned.has(id)) throw new Error(`Reviewed event ${id} is neither assigned nor unassigned`)
  for (const id of report.unassignedEventIds) {
    if (report.tasks.some(task => task.eventIds.includes(id) || task.counterEvidenceIds.includes(id))) throw new Error(`Event ${id} is both assigned and unassigned`)
  }
  listText(report.limitations, 'Limitations')
  if ((reviewed.size < known.size || history.coverage.limitations.length > 0) && report.limitations.length === 0) {
    throw new Error('Incomplete review or capture gaps must be disclosed in limitations')
  }
  return { valid: true, semanticCorrectnessChecked: false, synthetic: history.synthetic,
    taskCount: report.tasks.length, reviewedEventCount: reviewed.size, availableEventCount: known.size,
    unreviewedEventCount: known.size - reviewed.size, captureLimitations: history.coverage.limitations }
}
