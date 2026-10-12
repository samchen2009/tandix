/**
 * Pure conversation-rendering logic: maps session events (live and history)
 * to display rows. Kept framework-free so the wire shapes are unit-tested
 * against the REAL SessionEvent contract: `{ type, seq, time, data }` — the
 * payload always lives in `data`, never on the event root.
 *
 * @module
 */

import { getUiLocale, type UiLocale } from '../i18n.ts'
import { imageRefsFromBlocks, type ImageAttachmentRef } from './attachments.ts'
import { PANEL_COPY } from './strings.ts'

/** One rendered conversation row. */
export interface Row {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'info'
  text: string
  images?: ImageAttachmentRef[]
  status?: 'running' | 'complete' | 'failed' | 'interrupted'
  tools?: ToolDetail[]
}

export interface ToolDetail {
  name: string
  callId?: string
  input: string
  output?: string
  status: 'running' | 'complete' | 'failed' | 'interrupted'
}

/** Minimal view of a SessionEvent (payload in `data`). */
export interface SessionEventView {
  type: string
  seq?: number
  surfaceOp?: unknown
  data?: {
    content?: unknown
    source?: { kind?: string }
    message?: { content?: unknown; source?: { kind?: string; callId?: string } }
    turn?: number
    step?: number
    name?: string
    arguments?: string
    callId?: string
    error?: unknown
    title?: unknown
  }
}

/** One user-selectable answer exposed by ask_user_question. */
export interface QuestionOption {
  label: string
  description?: string
}

/** One item in a question batch. */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
  secret?: boolean
  optional?: boolean
}

/** Pending interaction belonging to one dsh session. */
export interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: QuestionItem[]
}

/** Identity carried by question/resolved; both fields must match before clearing UI. */
export interface ResolvedQuestion {
  rpcId: string
  sessionId: string
}

export interface AgentApproval {
  rpcId: string
  sessionId: string
  backend: 'dsh' | 'codex' | 'workbuddy'
  kind: 'command' | 'file-change' | 'permissions'
  toolName: string
  reason: string
  command: string
  cwd: string
  details: string
}

export function agentApprovalFromFrame(frame: EventFrameView): AgentApproval | null {
  if (frame.method !== 'agent-approval/requested' || !isRecord(frame.payload)
    || typeof frame.rpcId !== 'string' || typeof frame.payload.sessionId !== 'string'
    || (frame.payload.backend !== 'dsh' && frame.payload.backend !== 'codex' && frame.payload.backend !== 'workbuddy')) return null
  const payload = frame.payload as Record<string, unknown> & { sessionId: string; backend: 'dsh' | 'codex' | 'workbuddy' }
  return {
    rpcId: frame.rpcId, sessionId: payload.sessionId, backend: payload.backend,
    kind: payload.kind === 'file-change' || payload.kind === 'permissions' ? payload.kind : 'command',
    toolName: typeof payload.toolName === 'string' ? payload.toolName : 'command',
    reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 2_000) : '',
    command: typeof payload.command === 'string' ? payload.command.slice(0, 8_000) : '',
    cwd: typeof payload.cwd === 'string' ? payload.cwd.slice(0, 1_000) : '',
    details: payload.permissions !== undefined && payload.permissions !== null
      ? JSON.stringify(payload.permissions).slice(0, 4_000)
      : Array.isArray(payload.changes) && payload.changes.length > 0
        ? summarizeChanges(payload.changes)
        : typeof payload.grantRoot === 'string' ? payload.grantRoot.slice(0, 1_000) : '',
  }
}

function summarizeChanges(changes: unknown[]): string {
  const text = JSON.stringify(changes)
  return text.length > 8_000 ? `${text.slice(0, 8_000)}\n… preview truncated; inspect the full diff before allowing.` : text
}

export function agentApprovalResolvedFromFrame(frame: EventFrameView): string | null {
  return frame.method === 'agent-approval/resolved' && isRecord(frame.payload)
    && typeof frame.payload.approvalRpcId === 'string' ? frame.payload.approvalRpcId : null
}

/** The gateway mux envelope shape carried inside a bridge event frame. */
export interface EventFrameView {
  rpcId: string
  method: string
  payload: unknown
}

export function pendingQuestionFromFrame(frame: EventFrameView): PendingQuestion | null {
  if (typeof frame.rpcId !== 'string' || frame.method !== 'question/requested' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rawQuestions = frame.payload.questions
  if (typeof sessionId !== 'string' || !Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: QuestionItem[] = []
  for (const value of rawQuestions) {
    const question = parseQuestionItem(value)
    if (question === null) return null
    questions.push(question)
  }
  return { rpcId: frame.rpcId, sessionId, questions }
}

export function resolvedQuestionFromFrame(frame: EventFrameView): ResolvedQuestion | null {
  if (frame.method !== 'question/resolved' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rpcId = frame.payload.questionRpcId
  return typeof sessionId === 'string' && typeof rpcId === 'string' ? { sessionId, rpcId } : null
}

function parseQuestionItem(value: unknown): QuestionItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') return null
  if (value.header !== undefined && typeof value.header !== 'string') return null
  if (value.detail !== undefined && typeof value.detail !== 'string') return null
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') return null
  if (value.secret !== undefined && typeof value.secret !== 'boolean') return null
  if (value.optional !== undefined && typeof value.optional !== 'boolean') return null
  let options: QuestionOption[] | undefined
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) return null
    options = []
    for (const rawOption of value.options) {
      if (!isRecord(rawOption) || typeof rawOption.label !== 'string') return null
      if (rawOption.description !== undefined && typeof rawOption.description !== 'string') return null
      options.push({
        label: rawOption.label,
        ...(rawOption.description === undefined ? {} : { description: rawOption.description }),
      })
    }
  }
  return {
    id: value.id,
    question: value.question,
    ...(value.header === undefined ? {} : { header: value.header }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(options === undefined ? {} : { options }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
    ...(value.secret === undefined ? {} : { secret: value.secret }),
    ...(value.optional === undefined ? {} : { optional: value.optional }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract model-visible text from content blocks (defensive: unknown block shapes degrade to markers). */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Map one session event to a row (user/assistant only; tools handled separately). */
export function rowFromEvent(event: SessionEventView): Row | null {
  switch (event.type) {
    case 'user/message': {
      // dsh 每轮把运行时常量上下文作为 source.kind='plugin' 的 user/message
      // 记入日志（如 <system-reminder> 注入内容）——它们不是用户消息，
      // 渲染会污染对话流，必须跳过。
      const message = event.data?.message ?? event.data
      const source = message?.source
      if (source?.kind !== 'user') return null
      const blocks = message?.content
      const text = textFromBlocks(blocks)
      const images = imageRefsFromBlocks(blocks)
      return text.trim() === '' && images.length === 0
        ? null
        : { seq: 0, kind: 'user', text, ...(images.length === 0 ? {} : { images }) }
    }
    case 'assistant/message': {
      // 工具调用也会产生 assistant/message，但其 content 可能只有 tool_use
      // 等非文本块。不要为这种中间事件渲染一个空的 AI 气泡。
      const blocks = event.data?.message?.content
      const text = textFromBlocks(blocks)
      const images = imageRefsFromBlocks(blocks)
      return text.trim() === '' && images.length === 0
        ? null
        : { seq: 0, kind: 'assistant', text, ...(images.length === 0 ? {} : { images }) }
    }
    default:
      return null
  }
}

/** 工具调用的友好展示名：带 index 参数时附上（如「点击元素 #7」）。 */
export function toolSummary(name: string, argsJson: unknown, locale: UiLocale = getUiLocale()): string {
  let summary = PANEL_COPY[locale].tool.labels[name] ?? name
  try {
    const args = JSON.parse(String(argsJson ?? '{}')) as unknown
    if (typeof args === 'object' && args !== null) {
      if (name === 'bash' && 'description' in args && typeof args.description === 'string') {
        summary = args.description
      } else if ('index' in args) {
        summary += ` #${String((args as { index?: unknown }).index)}`
      }
    }
  } catch {
    // 模型参数不可解析：只显示工具名。
  }
  return summary
}

function redactSecrets(value: string): string {
  return value
    .replace(/((?:--)?(?:api[-_]?key|token|password|secret|authorization)\s*(?:=|\s+)\s*)[^\s]+/giu, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, '$1[redacted]')
}

/** Display tool inputs without revealing typed page values or obvious credentials. */
export function toolInput(name: string, argsJson: unknown): string {
  try {
    const args = JSON.parse(String(argsJson ?? '{}')) as unknown
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return String(argsJson ?? '{}')
    if (name === 'bash' && typeof (args as { command?: unknown }).command === 'string') {
      const bashArgs = args as { command: string; workdir?: unknown; timeoutMs?: unknown; run_in_background?: unknown }
      const context = [
        typeof bashArgs.workdir === 'string' ? `workdir: ${bashArgs.workdir}` : undefined,
        typeof bashArgs.timeoutMs === 'number' ? `timeout: ${bashArgs.timeoutMs} ms` : undefined,
        bashArgs.run_in_background === true ? 'background: true' : undefined,
      ].filter((line): line is string => line !== undefined)
      return redactSecrets(`$ ${bashArgs.command}${context.length === 0 ? '' : `\n${context.join('\n')}`}`)
    }
    const safe = Object.fromEntries(Object.entries(args).map(([key, value]) => [key,
      key === 'text' && name === 'browser_type' && typeof value === 'string'
        ? `[hidden: ${value.length} characters]`
        : /token|password|secret|api.?key|authorization|cookie/iu.test(key) ? '[redacted]' : value]))
    return redactSecrets(JSON.stringify(safe, null, 2))
  } catch {
    return name === 'browser_type' ? '[input unavailable]' : redactSecrets(String(argsJson ?? '{}'))
  }
}

function resultInfo(event: SessionEventView): { status: ToolDetail['status']; output?: string } {
  const message = event.data?.message
  const blocks = Array.isArray(message?.content) ? message.content : []
  const result = blocks.find((block): block is { type: string; isError?: boolean; content?: unknown } =>
    typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
  const content = result?.content
  const rawOutput = textFromBlocks(content)
  const rawError = event.data?.error
  const errorText = typeof rawError === 'object' && rawError !== null && 'message' in rawError
    ? String((rawError as { message?: unknown }).message ?? '') : ''
  const output = redactSecrets((rawOutput || errorText).slice(0, 3000))
  const interrupted = /abort|cancel|interrupt/iu.test(`${errorText} ${typeof rawError === 'object' && rawError !== null && 'code' in rawError ? String(rawError.code) : ''}`)
  const failed = result?.isError === true || event.data?.error !== undefined
    || /\[(?:timed out after|exit code: [1-9])/u.test(rawOutput)
  return { status: interrupted ? 'interrupted' : failed ? 'failed' : 'complete', ...(output === '' ? {} : { output }) }
}

export function appendToolCall(rows: Row[], event: SessionEventView, seq: number, locale: UiLocale = getUiLocale()): Row[] {
  const name = event.data?.name ?? 'tool'
  const text = toolSummary(name, event.data?.arguments, locale)
  const detail: ToolDetail = {
    name,
    ...(typeof event.data?.callId === 'string' ? { callId: event.data.callId } : {}),
    input: toolInput(name, event.data?.arguments),
    status: 'running',
  }
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    return [...rows.slice(0, -1), { ...last, seq, text: `${last.text} → ${text}`, status: 'running', tools: [...(last.tools ?? []), detail] }]
  }
  return [...rows, { seq, kind: 'tool', text, status: 'running', tools: [detail] }]
}

export function completeToolCall(rows: Row[], event: SessionEventView, seq: number): Row[] {
  const callId = event.data?.message?.source?.callId
  const info = resultInfo(event)
  let rowIndex = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const tools = rows[index]?.tools
    if (tools?.some((tool) => callId === undefined ? tool.status === 'running' : tool.callId === callId)) {
      rowIndex = index
      break
    }
  }
  if (rowIndex < 0) return completeLastTool(rows, seq)
  const row = rows[rowIndex]!
  let toolIndex = -1
  for (let index = row.tools!.length - 1; index >= 0; index -= 1) {
    const tool = row.tools![index]!
    if (callId === undefined ? tool.status === 'running' : tool.callId === callId) {
      toolIndex = index
      break
    }
  }
  if (toolIndex < 0) return rows
  const tools = row.tools!.map((tool, index) => index === toolIndex ? { ...tool, ...info } : tool)
  const status = tools.some((tool) => tool.status === 'running') ? 'running'
    : tools.some((tool) => tool.status === 'failed') ? 'failed'
    : tools.some((tool) => tool.status === 'interrupted') ? 'interrupted' : 'complete'
  return rows.map((candidate, index) => index === rowIndex ? { ...candidate, seq, status, tools } : candidate)
}

export function interruptRunningTools(rows: Row[]): Row[] {
  return rows.map((row) => {
    if (row.kind !== 'tool' || row.status !== 'running') return row
    return { ...row, status: 'interrupted', tools: row.tools?.map((tool) =>
      tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool) }
  })
}

/** live 合并：若最后一行是工具行则并入（连续工具调用不刷屏），否则新增一行。 */
export function appendLiveRow(
  rows: Row[],
  kind: Row['kind'],
  text: string,
  seq: number,
  images?: ImageAttachmentRef[],
): Row[] {
  if (kind === 'tool') {
    const last = rows[rows.length - 1]
    if (last?.kind === 'tool') {
      return [...rows.slice(0, -1), { seq, kind: 'tool', text: `${last.text} → ${text}`, status: 'running' }]
    }
    return [...rows, { seq, kind, text, status: 'running' }]
  }
  return [...rows, { seq, kind, text, ...(images === undefined || images.length === 0 ? {} : { images }) }]
}

/** 标记最后一行工具调用已完成（并入，不新增行）。 */
export function completeLastTool(rows: Row[], seq: number): Row[] {
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    return [...rows.slice(0, -1), { ...last, seq, status: 'complete' }]
  }
  return rows
}

/** 历史渲染：连续工具调用归并成一行（tool/call..result 不逐条刷屏；超 3 个折叠计数）。 */
export function mergeHistoryRows(
  events: SessionEventView[],
  nextSeq: () => number,
  locale: UiLocale = getUiLocale(),
): Row[] {
  const rows: Row[] = []
  let pendingTool: { items: string[]; details: ToolDetail[]; total: number } | null = null
  const flushTool = (): void => {
    if (pendingTool === null) return
    const shown = pendingTool.items.slice(0, 3)
    const label = pendingTool.total > shown.length
      ? PANEL_COPY[locale].tool.overflow(shown, pendingTool.total)
      : shown.join(' → ')
    const status = pendingTool.details.some((tool) => tool.status === 'running') ? 'running'
      : pendingTool.details.some((tool) => tool.status === 'failed') ? 'failed'
      : pendingTool.details.some((tool) => tool.status === 'interrupted') ? 'interrupted' : 'complete'
    rows.push({ seq: nextSeq(), kind: 'tool', text: label, status, tools: pendingTool.details })
    pendingTool = null
  }
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const name = ev.data?.name ?? 'tool'
      const summary = toolSummary(name, ev.data?.arguments, locale)
      const detail: ToolDetail = { name, input: toolInput(name, ev.data?.arguments), status: 'running',
        ...(typeof ev.data?.callId === 'string' ? { callId: ev.data.callId } : {}) }
      if (pendingTool === null) pendingTool = { items: [summary], details: [detail], total: 1 }
      else {
        pendingTool.items.push(summary)
        pendingTool.details.push(detail)
        pendingTool.total += 1
      }
      continue
    }
    if (ev.type === 'tool/result') {
      const callId = ev.data?.message?.source?.callId
      if (pendingTool !== null) {
        let index = -1
        for (let candidate = pendingTool.details.length - 1; candidate >= 0; candidate -= 1) {
          const detail = pendingTool.details[candidate]!
          if (callId === undefined ? detail.status === 'running' : detail.callId === callId) {
            index = candidate
            break
          }
        }
        if (index >= 0) pendingTool.details[index] = { ...pendingTool.details[index]!, ...resultInfo(ev) }
      }
      continue
    }
    if (ev.type === 'turn/end' && pendingTool !== null) {
      pendingTool.details = pendingTool.details.map((detail) =>
        detail.status === 'running' ? { ...detail, status: 'interrupted' } : detail)
    }
    flushTool()
    if (ev.type === 'turn/end') rows.splice(0, rows.length, ...interruptRunningTools(rows))
    const row = rowFromEvent(ev)
    if (row !== null) rows.push({ ...row, seq: nextSeq() })
  }
  flushTool()
  return rows
}
