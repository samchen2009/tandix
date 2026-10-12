import { rowFromEvent, type SessionEventView } from '../panel/events.ts'
import type { UiLocale } from '../i18n.ts'
import chatInstructions from '../../../../prompts/agent-skill-chat.md?raw'
import runInstructions from '../../../../prompts/agent-skill-run.md?raw'
import type { SkillExtractionEvidence } from './extraction-evidence.ts'

export const CHAT_SKILLS_STORAGE_KEY = 'tandix.chat-skills.v1'
export const CHAT_SKILL_DRAFT_STORAGE_KEY = 'tandix.pending-skill-draft.v1'
export const AGENT_SKILL_SCHEMA_VERSION = 'tandix.agent-skill/v1' as const
export const SKILL_PAIR_DRAFT_SCHEMA_VERSION = 'tandix.skill-pair/v1' as const
export const AGENT_TASK_SCHEMA_VERSION = 'tandix.agent-task/v1' as const
const MAX_SKILLS = 100
const MAX_ACTIONS = 200

export interface ChatSkillParameter {
  name: string
  label: string
  type: 'string' | 'secret' | 'number' | 'boolean'
  required: boolean
  defaultValue?: string | number | boolean
}

export type DesktopHttpScalar = string | number | boolean

export interface DesktopHttpRequest {
  name: string
  method: 'GET' | 'POST'
  url: string
  query?: Record<string, DesktopHttpScalar>
  jsonBody?: Record<string, DesktopHttpScalar>
  /** Value-free response contract used to verify that the expected list exists. */
  response?: { listPath: string }
}

export interface DesktopHttpAdapter {
  kind: 'http'
  auth: { kind: 'none' } | { kind: 'bearer-env' | 'cookie-env'; env: string }
  requests: DesktopHttpRequest[]
}

export interface ChatSkill {
  schemaVersion: typeof AGENT_SKILL_SCHEMA_VERSION
  version: 1
  id: string
  name: string
  goal: string
  success: string
  steps: string[]
  parameters: ChatSkillParameter[]
  allowedOrigins: string[]
  /** Safe page entry used to recover when no suitable tab is already open. */
  startUrl?: string
  /** Reviewed non-browser adapter. Absence means the skill is browser-only. */
  desktopAdapter?: DesktopHttpAdapter
  sourceSessionId: string
  createdAt: number
}

export type ChatSkillDraft = Pick<ChatSkill, 'name' | 'goal' | 'steps' | 'success' | 'parameters' | 'allowedOrigins' | 'startUrl' | 'desktopAdapter'> & {
  questions: string[]
}

interface AiSkillPairDraft {
  schemaVersion: typeof SKILL_PAIR_DRAFT_SCHEMA_VERSION
  name: string
  browserSkill: Pick<ChatSkillDraft, 'goal' | 'steps' | 'success' | 'parameters' | 'allowedOrigins' | 'startUrl'>
  desktopSkill: DesktopHttpAdapter | null
  questions: string[]
}

interface StoredChatSkillDraft {
  sourceSessionId: string
  updatedAt: number
  draft: ChatSkillDraft
}

export interface ChatActionCandidate {
  id: string
  label: string
  suggestedStep: string
  requiresReview: boolean
  parameter?: ChatSkillParameter
}

type ParsedArgs = Record<string, unknown>

function argsFrom(event: SessionEventView): ParsedArgs {
  const raw = event.data?.arguments
  if (typeof raw !== 'string' || raw.length > 16_000) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as ParsedArgs : {}
  } catch { return {} }
}

function indexHint(args: ParsedArgs, zh: boolean): string {
  const value = args.index
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? (zh ? `（原快照 #${value}）` : ` (original snapshot #${value})`)
    : ''
}

function safeUrl(value: unknown): { url: string; stripped: boolean } | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const stripped = url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return { url: url.toString(), stripped }
  } catch { return null }
}

function recordedActions(text: string, prefix: string, locale: UiLocale, inputCounter: { value: number }): ChatActionCandidate[] {
  const marker = text.includes('【操作记录】') ? '【操作记录】'
    : text.includes('[Recorded actions]') ? '[Recorded actions]' : null
  if (marker === null) return []
  const zh = locale === 'zh'
  const lines = text.slice(text.indexOf(marker) + marker.length).split(/\r?\n/u)
  const actions: ChatActionCandidate[] = []
  for (const [index, rawLine] of lines.entries()) {
    const match = /^\s*•\s*(.+)$/u.exec(rawLine)
    if (match === null) {
      if (actions.length > 0) break
      continue
    }
    const line = match[1]!.trim()
    if (/^(?:网络概况|Network)\s*[：:]/u.test(line)) continue
    const action = line.split(/\s+→\s+/u, 1)[0]!.trim()
    let label = ''
    let suggestedStep = ''
    let requiresReview = false
    let parameter: ChatSkillParameter | undefined
    const input = /^(?:输入|Enter|选择|Select)\s+(.+?)[：:]\s*/u.exec(action)
    const click = /^(?:点击|Click)\s+(.+)$/u.exec(action)
    const navigation = /^(?:打开页面|Open page)\s*[：:]?\s*(.+)$/u.exec(action)
    const tab = /^(?:切换标签页|Switch tab)\s*[：:]?\s*(.+)$/u.exec(action)
    if (input !== null) {
      const target = input[1]!.trim().slice(0, 120)
      inputCounter.value += 1
      parameter = { name: `input${inputCounter.value}`, label: zh ? `${target}的输入值` : `Value for ${target}`, type: 'string', required: true }
      label = zh ? `输入 ${target}` : `Enter ${target}`
      suggestedStep = zh ? `在「${target}」输入 {{${parameter.name}}}` : `Enter {{${parameter.name}}} in "${target}"`
      requiresReview = target.length < 2
    } else if (click !== null) {
      const target = click[1]!.trim().slice(0, 120)
      label = zh ? `点击 ${target}` : `Click ${target}`
      const download = /(?:下载|download)/iu.test(line)
      suggestedStep = `${label}${download ? (zh ? '，确认触发下载' : ', verify a download starts') : ''}`
      requiresReview = target.length < 2
    } else if (navigation !== null) {
      const safe = safeUrl(navigation[1]!.trim())
      if (safe === null) continue
      label = zh ? '打开页面' : 'Open page'
      suggestedStep = `${label} ${safe.url}`
      requiresReview = safe.stripped
    } else if (tab !== null) {
      const target = tab[1]!.trim().slice(0, 120)
      label = zh ? `切换标签页 ${target}` : `Switch tab ${target}`
      suggestedStep = label
      requiresReview = true
    } else if (/^(?:提交表单|Submit form)(?:\s|$)/u.test(action)) {
      label = suggestedStep = action.slice(0, 160)
    } else if (/^(?:按键|Key)\s+(?:Enter|Escape)$/u.test(action)) {
      label = suggestedStep = action
    }
    if (label === '' || suggestedStep === '') continue
    actions.push({ id: `${prefix}:recording:${index}`, label, suggestedStep, requiresReview,
      ...(parameter === undefined ? {} : { parameter }) })
  }
  return actions
}

/**
 * Extract action candidates, never copying typed text, query strings, or page
 * snapshots into the reusable skill. Snapshot indices are shown only as review
 * hints and must never be replayed against a future page.
 */
export function chatActionCandidates(events: SessionEventView[], locale: UiLocale, draftText = ''): ChatActionCandidate[] {
  const zh = locale === 'zh'
  const candidates: ChatActionCandidate[] = []
  const inputCounter = { value: 0 }
  for (const [position, event] of events.entries()) {
    if (event.type === 'user/message') {
      const row = rowFromEvent(event)
      if (row?.kind === 'user') {
        candidates.push(...recordedActions(row.text, `${event.seq ?? position}:${position}`, locale, inputCounter))
      }
      continue
    }
    if (event.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name !== 'string' || !name.startsWith('browser_')) continue
    const args = argsFrom(event)
    const hint = indexHint(args, zh)
    let label = ''
    let suggestedStep = ''
    let requiresReview = false
    let parameter: ChatSkillParameter | undefined
    switch (name) {
      case 'browser_click':
        label = `${zh ? '点击控件' : 'Click control'}${hint}`
        suggestedStep = zh ? '点击目标控件（请写明名称）' : 'Click the target control (name it here)'
        requiresReview = true
        break
      case 'browser_type':
        inputCounter.value += 1
        parameter = { name: `input${inputCounter.value}`, label: zh ? `输入值 ${inputCounter.value}` : `Input ${inputCounter.value}`, type: 'string', required: true }
        label = `${zh ? '输入文字' : 'Type text'}${hint}`
        suggestedStep = zh
          ? `在目标输入框（请写明名称）输入 {{${parameter.name}}}`
          : `Enter {{${parameter.name}}} in the target field (name it here)`
        requiresReview = true
        break
      case 'browser_navigate':
      case 'browser_open_tab': {
        const safe = safeUrl(args.url)
        if (safe === null) break
        label = name === 'browser_open_tab' ? (zh ? '打开新标签页' : 'Open new tab') : (zh ? '打开页面' : 'Navigate')
        suggestedStep = `${label} ${safe.url}${safe.stripped ? (zh ? '（原链接参数已省略）' : ' (original URL parameters omitted)') : ''}`
        requiresReview = safe.stripped
        break
      }
      case 'browser_press':
        if (typeof args.key !== 'string' || args.key.length > 40) break
        label = zh ? '按键' : 'Press key'
        suggestedStep = `${label} ${args.key}`
        break
      case 'browser_scroll': {
        const direction = args.direction
        if (typeof direction !== 'string' || !['up', 'down', 'top', 'bottom'].includes(direction)) break
        label = zh ? '滚动页面' : 'Scroll page'
        suggestedStep = `${label} ${direction}`
        break
      }
      case 'browser_back':
        label = suggestedStep = zh ? '返回上一页' : 'Go back'
        break
      case 'browser_forward':
        label = suggestedStep = zh ? '前进到下一页' : 'Go forward'
        break
      case 'browser_reload':
        label = suggestedStep = zh ? '刷新页面' : 'Reload page'
        break
      default:
        continue
    }
    if (label === '' || suggestedStep === '') continue
    candidates.push({
      id: `${event.seq ?? position}:${position}`,
      label,
      suggestedStep,
      requiresReview,
      ...(parameter === undefined ? {} : { parameter }),
    })
  }
  candidates.push(...recordedActions(draftText, 'draft', locale, inputCounter))
  return candidates.slice(-MAX_ACTIONS)
}

/** Show a user-authored intent as an editable suggestion, not an inferred fact. */
export function suggestedGoal(events: SessionEventView[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = rowFromEvent(events[index]!)
    if (row?.kind !== 'user') continue
    const withoutRecording = row.text.split(/【操作记录】|\[Recorded actions\]/u, 1)[0]!.trim()
    if (withoutRecording !== '') return withoutRecording.replace(/\s+/g, ' ').slice(0, 240)
  }
  return ''
}

export function buildExtractSkillPrompt(
  recentActivity: string,
  locale: UiLocale,
  evidence?: SkillExtractionEvidence,
): string {
  // The compact recap may contain literal form values. Keep control names and
  // outcomes, but turn values into placeholders before sending it to an agent.
  const redacted = recentActivity.replace(
    /(^\s*•\s*(?:输入|Enter|选择|Select)\s+[^：:\n]+[：:])[^→\n]*/gmu,
    '$1{{input}} ',
  )
  const structured = evidence === undefined ? ''
    : `\n\n<structured-evidence>\n${JSON.stringify(evidence, null, 2)}\n</structured-evidence>`
  return `${chatInstructions}\n\nReply in ${locale === 'zh' ? 'Chinese' : 'English'}.${structured}\n\n<recent-activity>\n${redacted}\n</recent-activity>`
}

function isValidSkillParameter(parameter: unknown): parameter is ChatSkillParameter {
  if (typeof parameter !== 'object' || parameter === null || Array.isArray(parameter)) return false
  const candidate = parameter as Partial<ChatSkillParameter>
  if (typeof candidate.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(candidate.name)
    || typeof candidate.label !== 'string' || candidate.label.trim() === ''
    || !['string', 'secret', 'number', 'boolean'].includes(candidate.type ?? '')
    || typeof candidate.required !== 'boolean') return false
  if (candidate.defaultValue === undefined) return true
  if (candidate.type === 'secret') return false
  return (candidate.type === 'string' && typeof candidate.defaultValue === 'string')
    || (candidate.type === 'number' && typeof candidate.defaultValue === 'number')
    || (candidate.type === 'boolean' && typeof candidate.defaultValue === 'boolean')
}

function parsedDraft(value: unknown): ChatSkillDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const pair = value as Partial<AiSkillPairDraft>
  let draft: Partial<ChatSkillDraft> & { schemaVersion?: unknown }
  if (pair.schemaVersion === SKILL_PAIR_DRAFT_SCHEMA_VERSION) {
    if (typeof pair.browserSkill !== 'object' || pair.browserSkill === null || Array.isArray(pair.browserSkill)
      || !Object.hasOwn(pair, 'desktopSkill') || !Array.isArray(pair.questions)) return null
    draft = {
      schemaVersion: AGENT_SKILL_SCHEMA_VERSION,
      name: pair.name,
      ...pair.browserSkill,
      ...(pair.desktopSkill === null ? {} : { desktopAdapter: pair.desktopSkill }),
      questions: pair.questions,
    }
  } else {
    draft = value as Partial<ChatSkillDraft> & { schemaVersion?: unknown }
  }
  if (draft.schemaVersion !== AGENT_SKILL_SCHEMA_VERSION
    || typeof draft.name !== 'string' || draft.name.trim() === '' || draft.name.length > 100
    || typeof draft.goal !== 'string' || draft.goal.trim() === '' || draft.goal.length > 1_000
    || typeof draft.success !== 'string' || draft.success.length > 1_000
    || !Array.isArray(draft.steps) || draft.steps.length === 0 || draft.steps.length > 100
    || !draft.steps.every((step) => typeof step === 'string' && step.trim() !== '' && step.length <= 1_000)
    || !Array.isArray(draft.parameters) || draft.parameters.length > 50
    || !draft.parameters.every(isValidSkillParameter)
    || !Array.isArray(draft.allowedOrigins) || draft.allowedOrigins.length > 20
    || !draft.allowedOrigins.every((origin) => {
      if (typeof origin !== 'string') return false
      try { const parsed = new URL(origin); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin }
      catch { return false }
    })
    || !isValidSkillStartUrl(draft.startUrl, draft.allowedOrigins)
    || !isValidDesktopAdapter(draft.desktopAdapter, draft.parameters, draft.allowedOrigins)
    || !Array.isArray(draft.questions) || !draft.questions.every((question) => typeof question === 'string')
    || (draft.success.trim() === '' && draft.questions.length === 0)) return null
  return draft as ChatSkillDraft
}

export function parseExtractedSkill(text: string): ChatSkillDraft | null {
  const pairTagged = /<tandix-skill-pair-json>\s*([\s\S]*?)\s*<\/tandix-skill-pair-json>/iu.exec(text)
  const legacyTagged = /<tandix-skill-json>\s*([\s\S]*?)\s*<\/tandix-skill-json>/iu.exec(text)
  const trimmed = (pairTagged?.[1] ?? legacyTagged?.[1] ?? text).trim()
    .replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let value: unknown
  try { value = JSON.parse(trimmed) } catch { return null }
  return parsedDraft(value)
}

export function finalizeExtractedSkill(draft: ChatSkillDraft, sourceSessionId: string): ChatSkill {
  return {
    schemaVersion: AGENT_SKILL_SCHEMA_VERSION,
    version: 1,
    id: crypto.randomUUID(),
    name: draft.name.trim(),
    goal: draft.goal.trim(),
    steps: draft.steps.map((step) => step.trim()),
    success: draft.success.trim(),
    parameters: draft.parameters,
    allowedOrigins: draft.allowedOrigins,
    ...(draft.startUrl === undefined ? {} : { startUrl: draft.startUrl }),
    ...(draft.desktopAdapter === undefined ? {} : { desktopAdapter: draft.desktopAdapter }),
    sourceSessionId,
    createdAt: Date.now(),
  }
}

/** Keep the current reviewed draft across side-panel reloads and model replies. */
export async function checkpointChatSkillDraft(draft: ChatSkillDraft, sourceSessionId: string): Promise<void> {
  const stored: StoredChatSkillDraft = { sourceSessionId, updatedAt: Date.now(), draft }
  await chrome.storage.local.set({ [CHAT_SKILL_DRAFT_STORAGE_KEY]: stored })
}

export async function loadChatSkillDraftCheckpoint(sourceSessionId: string): Promise<ChatSkillDraft | null> {
  const stored = await chrome.storage.local.get(CHAT_SKILL_DRAFT_STORAGE_KEY)
  const value = stored[CHAT_SKILL_DRAFT_STORAGE_KEY] as Partial<StoredChatSkillDraft> | undefined
  if (value?.sourceSessionId !== sourceSessionId || typeof value.updatedAt !== 'number') return null
  return parsedDraft({ schemaVersion: AGENT_SKILL_SCHEMA_VERSION, ...value.draft })
}

export async function clearChatSkillDraftCheckpoint(): Promise<void> {
  if (typeof chrome.storage.local.remove === 'function') {
    await chrome.storage.local.remove(CHAT_SKILL_DRAFT_STORAGE_KEY)
  } else {
    await chrome.storage.local.set({ [CHAT_SKILL_DRAFT_STORAGE_KEY]: null })
  }
}

function isChatSkill(value: unknown): value is ChatSkill {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const skill = value as Partial<ChatSkill>
  return skill.schemaVersion === AGENT_SKILL_SCHEMA_VERSION && skill.version === 1
    && typeof skill.id === 'string' && skill.id !== ''
    && typeof skill.name === 'string' && skill.name.trim() !== '' && skill.name.length <= 100
    && typeof skill.goal === 'string' && skill.goal.trim() !== '' && skill.goal.length <= 1_000
    && typeof skill.success === 'string' && skill.success.trim() !== '' && skill.success.length <= 1_000
    && typeof skill.sourceSessionId === 'string' && typeof skill.createdAt === 'number'
    && Array.isArray(skill.steps) && skill.steps.length > 0 && skill.steps.length <= 100
    && skill.steps.every((step) => typeof step === 'string' && step.trim() !== '' && step.length <= 1_000)
    && Array.isArray(skill.parameters) && skill.parameters.every(isValidSkillParameter)
    && Array.isArray(skill.allowedOrigins) && skill.allowedOrigins.every((origin) => {
      if (typeof origin !== 'string') return false
      try { const parsed = new URL(origin); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin }
      catch { return false }
    })
    && isValidSkillStartUrl(skill.startUrl, skill.allowedOrigins)
    && isValidDesktopAdapter(skill.desktopAdapter, skill.parameters, skill.allowedOrigins)
}

function isValidSkillStartUrl(value: unknown, allowedOrigins: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string' || !Array.isArray(allowedOrigins)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
      && !url.pathname.split('/').some((segment) => segment === ':id')
      && allowedOrigins.includes(url.origin)
  } catch { return false }
}

const DESKTOP_TIME_TOKENS = new Set([
  'yesterday-start-iso', 'today-end-iso',
  'yesterday-start-ms', 'today-end-ms',
  'yesterday-start-s', 'today-end-s',
])

function validDesktopTemplate(value: DesktopHttpScalar, parameterNames: Set<string>): boolean {
  if (typeof value !== 'string') return true
  if (value.length > 1_000) return false
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    const token = match[1]!
    if (!parameterNames.has(token) && !(token.startsWith('time:') && DESKTOP_TIME_TOKENS.has(token.slice(5)))) return false
  }
  return true
}

function validDesktopValues(value: unknown, parameterNames: Set<string>): value is Record<string, DesktopHttpScalar> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.entries(value).length <= 100
    && Object.entries(value).every(([key, item]) => key !== '' && key.length <= 200
      && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      && validDesktopTemplate(item, parameterNames))
}

function isValidDesktopAdapter(value: unknown, parameters: unknown, allowedOrigins: unknown): value is DesktopHttpAdapter | undefined {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Array.isArray(parameters) || !Array.isArray(allowedOrigins)) return false
  const adapter = value as Partial<DesktopHttpAdapter>
  if (!Object.keys(adapter).every((key) => key === 'kind' || key === 'auth' || key === 'requests')) return false
  const parameterNames = new Set(parameters.flatMap((parameter) =>
    typeof parameter === 'object' && parameter !== null && typeof (parameter as { name?: unknown }).name === 'string'
      ? [(parameter as { name: string }).name] : []))
  if (adapter.kind !== 'http' || typeof adapter.auth !== 'object' || adapter.auth === null) return false
  if (!Object.keys(adapter.auth).every((key) => key === 'kind' || key === 'env')) return false
  if (adapter.auth.kind !== 'none'
    && (adapter.auth.kind !== 'bearer-env' && adapter.auth.kind !== 'cookie-env'
      || !('env' in adapter.auth) || typeof adapter.auth.env !== 'string'
      || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(adapter.auth.env))) return false
  if (!Array.isArray(adapter.requests) || adapter.requests.length === 0 || adapter.requests.length > 10) return false
  return adapter.requests.every((request) => {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return false
    const candidate = request as Partial<DesktopHttpRequest>
    if (!Object.keys(candidate).every((key) => key === 'name' || key === 'method' || key === 'url'
      || key === 'query' || key === 'jsonBody' || key === 'response')) return false
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '' || candidate.name.length > 100
      || (candidate.method !== 'GET' && candidate.method !== 'POST') || typeof candidate.url !== 'string') return false
    try {
      const url = new URL(candidate.url)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== ''
        || url.search !== '' || url.hash !== '' || !allowedOrigins.includes(url.origin)) return false
    } catch { return false }
    const responseValid = candidate.response === undefined || (typeof candidate.response === 'object'
      && candidate.response !== null && !Array.isArray(candidate.response)
      && Object.keys(candidate.response).every((key) => key === 'listPath')
      && typeof candidate.response.listPath === 'string'
      && (candidate.response.listPath === '$'
        || /^[\p{L}_$][\p{L}\p{N}_$-]*(?:\.[\p{L}_$][\p{L}\p{N}_$-]*)*$/u.test(candidate.response.listPath)))
    return responseValid && (candidate.query === undefined || validDesktopValues(candidate.query, parameterNames))
      && (candidate.jsonBody === undefined || validDesktopValues(candidate.jsonBody, parameterNames))
      && !(candidate.method === 'GET' && candidate.jsonBody !== undefined)
  })
}

export function parseImportedSkill(text: string): ChatSkill | null {
  try {
    const value: unknown = JSON.parse(text)
    return isChatSkill(value) ? value : null
  } catch { return null }
}

function migrateLegacySkill(value: unknown): ChatSkill | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const legacy = value as Partial<ChatSkill>
  if (legacy.version !== 1 || typeof legacy.id !== 'string' || typeof legacy.name !== 'string'
    || typeof legacy.goal !== 'string' || typeof legacy.success !== 'string'
    || !Array.isArray(legacy.steps) || !legacy.steps.every((step) => typeof step === 'string')
    || !Array.isArray(legacy.parameters) || !legacy.parameters.every((parameter) =>
      typeof parameter?.name === 'string' && typeof parameter.label === 'string')) return null
  const migrated: ChatSkill = {
    schemaVersion: AGENT_SKILL_SCHEMA_VERSION,
    version: 1,
    id: legacy.id,
    name: legacy.name,
    goal: legacy.goal,
    steps: legacy.steps,
    success: legacy.success.trim() || 'Verify each step and report the observed outcome.',
    parameters: legacy.parameters.map((parameter) => ({ ...parameter, type: parameter.type ?? 'string', required: parameter.required ?? true })),
    allowedOrigins: legacy.allowedOrigins ?? [],
    ...(isValidSkillStartUrl(legacy.startUrl, legacy.allowedOrigins ?? []) && legacy.startUrl !== undefined
      ? { startUrl: legacy.startUrl } : {}),
    ...(isValidDesktopAdapter(legacy.desktopAdapter, legacy.parameters, legacy.allowedOrigins ?? [])
      && legacy.desktopAdapter !== undefined ? { desktopAdapter: legacy.desktopAdapter } : {}),
    sourceSessionId: legacy.sourceSessionId ?? '',
    createdAt: legacy.createdAt ?? Date.now(),
  }
  return isChatSkill(migrated) ? migrated : null
}

export async function loadChatSkills(): Promise<ChatSkill[]> {
  const stored = await chrome.storage.local.get(CHAT_SKILLS_STORAGE_KEY)
  const value: unknown = stored[CHAT_SKILLS_STORAGE_KEY]
  return Array.isArray(value) ? value.map((entry) => isChatSkill(entry) ? entry : migrateLegacySkill(entry))
    .filter((entry): entry is ChatSkill => entry !== null).slice(0, MAX_SKILLS) : []
}

export async function saveChatSkill(skill: ChatSkill): Promise<ChatSkill[]> {
  const current = await loadChatSkills()
  const next = [skill, ...current.filter((entry) => entry.id !== skill.id)].slice(0, MAX_SKILLS)
  await chrome.storage.local.set({ [CHAT_SKILLS_STORAGE_KEY]: next })
  const persisted = await loadChatSkills()
  if (!persisted.some((entry) => entry.id === skill.id)) {
    throw new Error('Skill storage verification failed')
  }
  return persisted
}

export async function deleteChatSkill(id: string): Promise<ChatSkill[]> {
  const next = (await loadChatSkills()).filter((entry) => entry.id !== id)
  await chrome.storage.local.set({ [CHAT_SKILLS_STORAGE_KEY]: next })
  return next
}

export function buildChatSkillPrompt(skill: ChatSkill, values: Record<string, string>, locale: UiLocale): string {
  const inputs: Record<string, string | number | boolean> = {}
  for (const parameter of skill.parameters) {
    const raw = values[parameter.name] ?? (parameter.defaultValue === undefined ? undefined : String(parameter.defaultValue))
    if (raw === undefined || (raw === '' && !parameter.required)) continue
    inputs[parameter.name] = parameter.type === 'number' ? Number(raw)
      : parameter.type === 'boolean' ? raw === 'true' : raw
  }
  const task = {
    schemaVersion: AGENT_TASK_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    skillId: skill.id,
    skillVersion: skill.version,
    inputs,
    target: { kind: 'controlled-tab' },
    requestedAt: Date.now(),
  }
  return `${runInstructions}\n\nReply in ${locale === 'zh' ? 'Chinese' : 'English'}.\n\n<skill-json>\n${JSON.stringify(skill, null, 2)}\n</skill-json>\n\n<task-json>\n${JSON.stringify(task, null, 2)}\n</task-json>`
}
