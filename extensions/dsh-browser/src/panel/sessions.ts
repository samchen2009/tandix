import { rowFromEvent, type PendingQuestion, type ResolvedQuestion, type SessionEventView } from './events.ts'
import { removePendingQuestion, upsertPendingQuestion } from './pending-questions.ts'

/** Minimal session.list row needed by the side-panel picker. */
export interface SessionPickerEntry {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  origin?: 'subagent'
  contentTitle?: string
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

/** Only ordinary, started conversations can be resumed through session.prompt. */
export function resumableSessions(items: readonly SessionPickerEntry[]): SessionPickerEntry[] {
  return items.filter((entry) => !entry.blank && entry.origin !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
}

/** Match dsh's display-title fallback without loading a session's history. */
export function sessionDisplayTitle(entry: SessionPickerEntry): string {
  const projectedTitle = projectedSessionTitle(entry)
  if (projectedTitle !== undefined) return projectedTitle

  if (entry.contentTitle !== undefined) return entry.contentTitle

  const normalizedCwd = entry.cwd?.replace(/[\\/]+$/u, '')
  const directoryName = normalizedCwd?.split(/[\\/]/u).at(-1)
  return `${directoryName || 'Chat'} · ${entry.sessionId.slice(-8)}`
}

/** Read the durable title column carried by dsh's session.list projection. */
export function projectedSessionTitle(entry: SessionPickerEntry): string | undefined {
  const title = normalizeSessionTitle(entry.projections?.values.title)
  const directoryName = entry.cwd?.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1)
  return title === 'Codex' || title === 'Tandix' || title === '网页助手' || title === directoryName || title === entry.sessionId
    ? undefined : title
}

/** Use actual user messages, never injected plugin context, for an untitled conversation. */
export function latestSessionContentTitle(events: readonly SessionEventView[]): string | undefined {
  let genericFallback: string | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = rowFromEvent(events[index]!)
    if (row?.kind !== 'user') continue
    const blocks = events[index]?.data?.message?.content
    const texts = Array.isArray(blocks)
      ? blocks.flatMap((block) => typeof block === 'object' && block !== null
        && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
        ? [block.text] : []).reverse()
      : [row.text]
    for (const text of texts) {
      const title = conciseUserTitle(text)
      if (title === undefined) continue
      if (isGenericUserPrompt(title)) genericFallback ??= title
      else return title
    }
  }
  return genericFallback
}

function conciseUserTitle(text: string): string | undefined {
  if (text.startsWith('Browser context after tab handoff (untrusted):')
    || text.startsWith('<USER_ATTACHMENT')) return undefined
  const line = text.split(/\r?\n/u).map((part) => part.replace(/\s+/gu, ' ').trim()).find(Boolean)
  if (line === undefined) return undefined
  const points = [...line]
  return points.length > 56 ? `${points.slice(0, 56).join('').trimEnd()}…` : line
}

function isGenericUserPrompt(title: string): boolean {
  return /^(请先概览当前页面|First give me an overview of the current page)/iu.test(title)
    || /^(好(?:的)?|可以|继续|确认|收到|谢谢|ok|yes|go ahead)[.!。！\s]*$/iu.test(title)
}

/** Read one durable title update from the ordinary session event stream. */
export function sessionTitleFromEvent(event: SessionEventView): string | undefined {
  return event.type === 'session/title' ? normalizeSessionTitle(event.data?.title) : undefined
}

/** Recover the newest valid title while replaying session.history. */
export function latestSessionTitle(events: readonly SessionEventView[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const title = sessionTitleFromEvent(events[index])
    if (title !== undefined) return title
  }
  return undefined
}

function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  return title === '' ? undefined : title
}

/** A prompt target exists only after the current session transition settles. */
export function sessionAcceptsPrompts(
  connected: boolean,
  changing: boolean,
  sessionId: string | null,
): boolean {
  return connected && !changing && sessionId !== null
}

export interface SessionRuntimeSnapshot {
  running: boolean
  questions: PendingQuestion[]
}

interface StoredSessionRuntime {
  running?: boolean
  questions: PendingQuestion[]
}

/** Live, per-session state that session.history cannot reconstruct. */
export class SessionRuntimeCache {
  private readonly sessions = new Map<string, StoredSessionRuntime>()

  rememberQuestion(question: PendingQuestion): void {
    const current = this.sessions.get(question.sessionId) ?? { questions: [] }
    this.sessions.set(question.sessionId, {
      ...current,
      questions: upsertPendingQuestion(current.questions, question),
    })
  }

  resolveQuestion(question: ResolvedQuestion): void {
    const current = this.sessions.get(question.sessionId)
    if (current === undefined) return
    this.sessions.set(question.sessionId, {
      ...current,
      questions: removePendingQuestion(current.questions, question),
    })
  }

  seedRunning(sessionId: string, running: boolean): void {
    const current = this.sessions.get(sessionId) ?? { questions: [] }
    if (current.running !== undefined) return
    this.sessions.set(sessionId, { ...current, running })
  }

  startTurn(sessionId: string): void {
    const current = this.sessions.get(sessionId) ?? { questions: [] }
    this.sessions.set(sessionId, { ...current, running: true })
  }

  finishTurn(sessionId: string): void {
    this.sessions.set(sessionId, { running: false, questions: [] })
  }

  snapshot(sessionId: string, fallbackRunning = false): SessionRuntimeSnapshot {
    const current = this.sessions.get(sessionId)
    return {
      running: current?.running ?? fallbackRunning,
      questions: current?.questions.slice() ?? [],
    }
  }

  clear(): void {
    this.sessions.clear()
  }
}
