/**
 * Side panel application: chat with the local dsh agent, plus a settings
 * view. Renders conversation from session history and live session events;
 * browser actions are driven by the model through the bridge tools (the panel
 * only shows tool activity cards).
 *
 * @module
 */

import { memo, useEffect, useRef, useState } from 'react'
import { AGENT_CHOICES, agentLabel, agentPreference, type AgentBackend } from '../agent-backend.ts'
import { BRIDGE_SESSION_PURGE_METHOD, DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeCaps } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { AffinityTab, TabAffinityDecision, TabAffinityState } from '../background/tab-affinity.ts'
import { connectPanel, PanelRpcError, type PanelApi, type PanelSettings } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import brandIconUrl from '../../assets/icons/icon256.png'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { getUiLocale, loadUiLocale, saveUiLocale, type UiLocale } from '../i18n.ts'
import { PANEL_COPY, type PanelCopy } from './strings.ts'
import {
  applyUiScale,
  DEFAULT_UI_SCALE,
  formatUiScale,
  loadUiScale,
  saveUiScale,
  stepUiScale,
  uiScaleAtLimit,
} from './ui-scale.ts'
import { QuestionCard } from './QuestionCard.tsx'
import { UpdateCard } from './UpdateCard.tsx'
import { CodexCapabilities } from './CodexCapabilities.tsx'
import { buildGoalContinuePrompt, buildGoalDraftPrompt, buildGoalObjective, buildGoalStartPrompt, parseGoalDraft, type GoalState } from './goal.ts'
import { MessageImages } from './MessageImages.tsx'
import type { QuestionAnswer } from './questions.ts'
import {
  hasPendingQuestion,
  questionReceiptDisposition,
  removePendingQuestion,
  upsertPendingQuestion,
} from './pending-questions.ts'
import { normalizeTrustedOrigin } from '../security/trusted-origins.ts'
import type { PageSelection } from '../selection.ts'
import {
  selectionPromptText,
  selectionSourceLabel,
  splitSelectionMessage,
} from './selection.ts'
import { approvalReadyForSession, approvalSessionToFocus } from './approvals.ts'
import {
  browserTimeZone,
  clipboardMediaFiles,
  draftImageDataUrl,
  parseImageAttachmentLimits,
  prepareGenericFiles,
  prepareImageFiles,
  promptContent,
  type DraftFile,
  type DraftImage,
  type ImageAttachmentLimits,
} from './attachments.ts'
import { imageErrorMessage } from './image-errors.ts'
import { AssistantStreamView } from './assistant-stream.ts'
import {
  canAcceptImageSelection,
  emptyComposerDraft,
  restoreSubmittedDraft,
  type ComposerDraft,
} from './composer.ts'
import {
  latestSessionTitle,
  latestSessionContentTitle,
  projectedSessionTitle,
  resumableSessions,
  sessionAcceptsPrompts,
  sessionDisplayTitle,
  sessionTitleFromEvent,
  SessionRuntimeCache,
  type SessionPickerEntry,
} from './sessions.ts'
import { RunSkillsPanel } from './ChatSkillPanels.tsx'
import {
  buildChatSkillPrompt,
  buildExtractSkillPrompt,
  CHAT_SKILLS_STORAGE_KEY,
  checkpointChatSkillDraft,
  clearChatSkillDraftCheckpoint,
  deleteChatSkill,
  finalizeExtractedSkill,
  loadChatSkills,
  parseExtractedSkill,
  parseImportedSkill,
  saveChatSkill,
  type ChatSkill,
  type ChatSkillDraft,
} from '../skill/chat-skill.ts'
import { CompactRecordingComposer } from '../recording/composer.ts'
import { loadManagedSkills, MANAGED_SKILLS_STORAGE_KEY, parseManagedSkillEnvelope,
  saveManagedSkill, type ManagedSkill, type ManagedSkillInput } from '../skill/managed-skill.ts'
import { requestsSkillSave } from '../skill/save-intent.ts'
import type { RecordingEventInput } from '../recording/schema.ts'
import type { TeachState } from '../recording/state-machine.ts'
import {
  buildSkillExtractionEvidence,
  hasSkillExtractionCandidates,
} from '../skill/extraction-evidence.ts'

/** One rendered conversation row. */
import {
  appendLiveRow,
  appendToolCall,
  completeToolCall,
  interruptRunningTools,
  mergeHistoryRows,
  pendingQuestionFromFrame,
  agentApprovalFromFrame,
  agentApprovalResolvedFromFrame,
  resolvedQuestionFromFrame,
  rowFromEvent,
  type Row,
  type PendingQuestion,
  type AgentApproval,
  type ResolvedQuestion,
  type SessionEventView,
} from './events.ts'

function normalizeWebOrigin(value: string): string | null {
  return normalizeTrustedOrigin(value) ?? null
}

/** One editable API-relay profile in the settings view. */
interface RelayProfileDraft {
  /** Stable llm-pi-ai provider-route key; empty until first save mints it. */
  key: string
  name: string
  protocol: 'anthropic-messages' | 'openai-completions' | 'openai-codex-responses'
  baseUrl: string
  /** Typed token; empty means keep whatever is already stored. */
  token: string
  tokenConfigured: boolean
  modelsText: string
  setDefault: boolean
}

function latestSkillIntent(rows: Row[]): string {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.kind !== 'user' || row.text.includes('<recent-activity>')) continue
    const intent = row.text.split(/【操作记录】|\[Recorded actions\]/u, 1)[0]!.replace(/\s+/gu, ' ').trim()
    if (intent !== '') return intent.slice(0, 500)
  }
  return ''
}

/** Route keys managed by the relay editor; core-owned routes are never touched. */
const RELAY_ROUTE_PREFIX = 'relay-'

/**
 * Display names are free-form (CJK included); the route key needs the
 * ASCII shape the wire and credential refs expect, so CJK-heavy names
 * collapse to a stable name hash instead of being rejected.
 */
function relayRouteKey(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug !== '') return `${RELAY_ROUTE_PREFIX}${slug}`
  let hash = 5381
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(index)) | 0
  }
  return `${RELAY_ROUTE_PREFIX}n${(hash >>> 0).toString(36)}`
}

function relayTokenRef(routeKey: string): string {
  const suffix = routeKey.slice(RELAY_ROUTE_PREFIX.length).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
  return `DSH_RELAY_${suffix}_TOKEN`
}

function parseRelayModels(text: string): Array<{ id: string; contextWindow?: number }> {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => {
    const [id, contextWindow] = line.split(',').map((part) => part.trim())
    const parsed = contextWindow === undefined || contextWindow === '' ? undefined : Number(contextWindow)
    return {
      id,
      ...(parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? { contextWindow: parsed } : {}),
    }
  }).filter((model) => model.id !== '')
}

/** Gateways report failures with the endpoint named; surface everything we got. */
function relayErrorText(cause: unknown): string {
  if (cause instanceof PanelRpcError) {
    const detailKeys = Object.keys(cause.details ?? {})
    const details = detailKeys.length > 0 ? ` ${JSON.stringify(cause.details).slice(0, 220)}` : ''
    return `${cause.message}${details}`
  }
  return cause instanceof Error ? cause.message : String(cause)
}

type DiscoveredModel = { id: string; contextWindow?: number }

/**
 * Anthropic-protocol routes have no native listing; the gateway still fails
 * them with a "no model listing" message whose wording varies, so match the
 * known phrasings instead of one brittle code.
 */
function isManualOnlyDiscovery(cause: unknown): boolean {
  if (!(cause instanceof PanelRpcError)) return false
  return cause.code.includes('unsupported')
    || /no model listing|models by hand/i.test(cause.message)
}

function isAuthFailure(cause: unknown): boolean {
  return cause instanceof PanelRpcError
    && (cause.code.includes('credential') || /\b401\b|\b403\b|invalid[ _-]?key/i.test(cause.message))
}

async function discoverOnce(
  api: PanelApi,
  profile: RelayProfileDraft,
  attempt: { api: string; baseURL: string },
): Promise<DiscoveredModel[]> {
  const result = await api.rpc<{ models?: DiscoveredModel[] }>('llm.discoverModels', {
    settingsNs: 'llm-pi-ai',
    provider: profile.key !== '' ? profile.key : relayRouteKey(profile.name),
    api: attempt.api,
    baseURL: attempt.baseURL,
    ...(profile.token.trim() === '' ? {} : { apiKey: profile.token.trim() }),
  })
  return result.models ?? []
}

/**
 * Build the ordered discovery attempts for one draft. Anthropic-protocol
 * profiles have no native listing, so fall back to the relay's own
 * OpenAI-compatible listing endpoint (`<base>/v1/models`) — New API / One API
 * style stations serve it with the same token, and the returned ids are the
 * ones the Anthropic route accepts.
 */
async function discoverWithFallback(
  api: PanelApi,
  profile: RelayProfileDraft,
): Promise<{ models: DiscoveredModel[]; viaOpenaiListing: boolean }> {
  const base = profile.baseUrl.trim().replace(/\/+$/, '')
  const attempts: Array<{ api: string; baseURL: string; viaOpenaiListing: boolean }> = []
  if (profile.protocol === 'anthropic-messages') {
    attempts.push({ api: 'openai-completions', baseURL: `${base}/v1`, viaOpenaiListing: true })
    attempts.push({ api: 'openai-completions', baseURL: base, viaOpenaiListing: true })
  } else {
    attempts.push({ api: profile.protocol, baseURL: base, viaOpenaiListing: false })
    if (!base.includes('/v1')) {
      attempts.push({ api: profile.protocol, baseURL: `${base}/v1`, viaOpenaiListing: false })
    }
  }

  let lastCause: unknown
  for (const attempt of attempts) {
    try {
      const models = await discoverOnce(api, profile, attempt)
      if (models.length > 0) {
        return { models, viaOpenaiListing: attempt.viaOpenaiListing }
      }
      lastCause = new PanelRpcError('model-discovery-failed', 'the endpoint listed no models', {
        baseURL: attempt.baseURL,
      })
    } catch (cause) {
      lastCause = cause
      if (isAuthFailure(cause)) break
    }
  }
  throw lastCause ?? new PanelRpcError('model-discovery-failed', 'model discovery failed', {})
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 7.35A2.65 2.65 0 1 0 10 12.65 2.65 2.65 0 0 0 10 7.35Z" />
      <path d="M16.15 11.2a6.4 6.4 0 0 0 0-2.4l1.18-.91-1.5-2.6-1.4.57a6.3 6.3 0 0 0-2.08-1.2L12.15 3h-3l-.2 1.66a6.3 6.3 0 0 0-2.08 1.2l-1.4-.57-1.5 2.6 1.18.91a6.4 6.4 0 0 0 0 2.4l-1.18.91 1.5 2.6 1.4-.57a6.3 6.3 0 0 0 2.08 1.2l.2 1.66h3l.2-1.66a6.3 6.3 0 0 0 2.08-1.2l1.4.57 1.5-2.6-1.18-.91Z" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6m-7 0 .7 9.1A2 2 0 0 0 7.7 17h4.6a2 2 0 0 0 2-1.9L15 6M8.25 9v4.5M11.75 9v4.5" />
    </svg>
  )
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
    </svg>
  )
}

function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
    </svg>
  )
}

function AttachmentIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7.25 10.75 4.9-4.9a2.3 2.3 0 0 1 3.25 3.25l-6.2 6.2a3.55 3.55 0 1 1-5.02-5.02l6.2-6.2" />
    </svg>
  )
}

function QuoteIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8.4 5.5 6.9 8.2h1.9v4.8H4.5V8.5l2-3h1.9Zm7 0L13.9 8.2h1.9v4.8h-4.3V8.5l2-3h1.9Z" />
    </svg>
  )
}

function ToolIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M12.1 3.35a4 4 0 0 0-4.75 5.27l-4.1 4.1a1.85 1.85 0 1 0 2.62 2.62l4.1-4.1a4 4 0 0 0 5.25-4.78l-2.45 2.45-1.9-.5-.5-1.9 2.45-2.45a4 4 0 0 0-.72-.71Z" />
    </svg>
  )
}

function BackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.5 4.5-5.5 5.5 5.5 5.5" />
    </svg>
  )
}

function TextSizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 14.5 6.25 5h1.5l3.75 9.5M4.1 11.4h5.8" />
      <path d="M12.4 14.5 15 7.6h1.1l2.6 6.9M13.5 12.4h4.1" />
    </svg>
  )
}

function MinusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" />
    </svg>
  )
}

function ShieldIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5 16 5v4.2c0 3.8-2.45 6.45-6 8.3-3.55-1.85-6-4.5-6-8.3V5l6-2.5Z" />
      <path d="M10 6.5v4M10 13.5h.01" />
    </svg>
  )
}

/** Stepper for the panel-wide text scale; see `ui-scale.ts` for the model. */
function TextSizePanel({
  scale,
  copy,
  onStep,
  onReset,
}: {
  scale: number
  copy: PanelCopy
  onStep: (direction: 1 | -1) => void
  onReset: () => void
}): React.JSX.Element {
  return (
    <section className="text-size-panel" aria-label={copy.textSize.title}>
      <strong>{copy.textSize.title}</strong>
      <div className="text-size-stepper">
        <button type="button" disabled={uiScaleAtLimit(scale, -1)}
          onClick={() => onStep(-1)}
          aria-label={copy.textSize.smaller} title={copy.textSize.smaller}>
          <MinusIcon />
        </button>
        <span className="text-size-value" role="status"
          aria-label={copy.textSize.value(formatUiScale(scale))}>{formatUiScale(scale)}</span>
        <button type="button" disabled={uiScaleAtLimit(scale, 1)}
          onClick={() => onStep(1)}
          aria-label={copy.textSize.larger} title={copy.textSize.larger}>
          <PlusIcon />
        </button>
      </div>
      <button type="button" className="text-size-reset" disabled={scale === DEFAULT_UI_SCALE}
        onClick={onReset}>{copy.textSize.reset}</button>
    </section>
  )
}

function tabLabel(tab: AffinityTab | null, unknownTab: string): string {
  const title = tab?.title.trim()
  if (title !== undefined && title !== '') return title
  try {
    const hostname = new URL(tab?.url ?? '').hostname
    return hostname === '' ? unknownTab : hostname
  } catch {
    return unknownTab
  }
}

function TabAffinityBanner({
  state,
  copy,
  onDecision,
}: {
  state: TabAffinityState | null
  copy: PanelCopy
  onDecision: (decision: TabAffinityDecision) => void
}): React.JSX.Element | null {
  if (state === null || state.status === 'unbound' || state.status === 'following') return null
  const controlled = tabLabel(state.controlled, copy.tabHandoff.closedTab)
  const active = tabLabel(state.active, copy.tabHandoff.unknownTab)
  const lost = state.status === 'lost'
  const handoff = state.status === 'handoff'
  const title = lost
    ? copy.tabHandoff.lostTitle
    : handoff
      ? copy.tabHandoff.questionTitle
      : copy.tabHandoff.backgroundTitle(controlled)
  const body = lost
    ? copy.tabHandoff.lostBody
    : handoff
      ? copy.tabHandoff.questionBody(controlled, active)
      : state.pinned
        ? copy.tabHandoff.pinnedBody(active)
        : copy.tabHandoff.backgroundBody(active)

  return (
    <section className={`tab-affinity ${state.status}`} role={handoff || lost ? 'alert' : 'status'}>
      <div className="tab-affinity-heading">
        <span className="eyebrow">{copy.tabHandoff.eyebrow}</span>
        <strong>{title}</strong>
      </div>
      <div className="tab-affinity-route" aria-hidden="true">
        <span className={`tab-affinity-node ${lost ? 'closed' : 'controlled'}`}>
          <small>{copy.tabHandoff.assistant}</small>
          <span title={controlled}>{controlled}</span>
        </span>
        <span className="tab-affinity-arrow">→</span>
        <span className="tab-affinity-node active">
          <small>{copy.tabHandoff.you}</small>
          <span title={active}>{active}</span>
        </span>
      </div>
      <p>{body}</p>
      <div className="tab-affinity-actions">
        {handoff && <button className="keep" onClick={() => onDecision('keep')}>{copy.tabHandoff.keep}</button>}
        {!handoff && !lost && state.controlled !== null && (
          <button className="follow" onClick={() => onDecision('show-controlled')}>
            {copy.tabHandoff.showControlled}
          </button>
        )}
        {state.active !== null && (
          <button className={handoff || lost ? 'follow' : 'keep'} onClick={() => onDecision('follow')}>
            {lost ? copy.tabHandoff.useCurrent : handoff ? copy.tabHandoff.follow : copy.tabHandoff.followCurrent}
          </button>
        )}
        {handoff && (
          <button className="keep-always" onClick={() => onDecision('keep-always')}>
            {copy.tabHandoff.keepAlways}
          </button>
        )}
        {!handoff && !lost && state.pinned && (
          <button className="keep-always" onClick={() => onDecision('ask-again')}>
            {copy.tabHandoff.askAgain}
          </button>
        )}
      </div>
    </section>
  )
}

function ApprovalDialog({
  request,
  onDecision,
  copy,
}: {
  request: ApprovalRequest
  onDecision: (decision: ApprovalDecision) => void
  copy: PanelCopy
}): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDecision('deny')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [request.id, onDecision])

  return (
    <div className="approval-backdrop">
      <section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-rail" aria-hidden="true" />
        <div className="approval-heading">
          <span className="approval-shield"><ShieldIcon /></span>
          <div>
            <span className="eyebrow">{copy.approval.eyebrow}</span>
            <h2 id="approval-title">{request.kind === 'read' ? copy.approval.readTitle : copy.approval.actionTitle}</h2>
          </div>
        </div>
        <div className="approval-detail">
          <span>{copy.approval.request}</span>
          <strong>{request.summary}</strong>
        </div>
        <div className="approval-origins">
          <span>{copy.approval.origins}</span>
          {request.origins.length === 0
            ? <code className="unknown">{copy.approval.unknownOrigin}</code>
            : request.origins.map((origin) => <code key={origin}>{origin}</code>)}
        </div>
        <div className="approval-actions">
          <button className="deny" autoFocus onClick={() => onDecision('deny')}>{copy.approval.deny}</button>
          <button className="allow" onClick={() => onDecision('allow-once')}>{copy.approval.allowOnce}</button>
          {request.kind === 'read' && (
            <button className="read-always" onClick={() => onDecision('always-allow-reads')}>{copy.approval.alwaysAllowReads}</button>
          )}
          {request.kind === 'action' && request.canTrust && request.origins.length === 1 && (
            <button className="session-trust" onClick={() => onDecision('trust-session')}>{copy.approval.trustSession}</button>
          )}
        </div>
        <small className="approval-footnote">
          {request.kind === 'read'
            ? copy.approval.readFootnote
            : copy.approval.actionFootnote}
        </small>
      </section>
    </div>
  )
}

function AgentApprovalDialog({ request, locale, onDecision, deciding }: {
  request: AgentApproval
  locale: UiLocale
  onDecision: (decision: 'deny' | 'once' | 'session') => void
  deciding: boolean
}): React.JSX.Element {
  const zh = locale === 'zh'
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onDecision('deny') }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [request.rpcId, onDecision])
  const title = request.kind === 'file-change' ? (zh ? '确认文件修改' : 'Approve file changes')
    : request.kind === 'permissions' ? (zh ? '确认额外权限' : 'Approve permissions')
      : (zh ? '确认本地命令' : 'Approve local command')
  return <div className="approval-backdrop">
    <section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-approval-title">
      <div className="approval-rail" aria-hidden="true" />
      <div className="approval-heading"><span className="approval-shield"><ShieldIcon /></span><div>
        <span className="eyebrow">{request.backend.toUpperCase()} · {zh ? '授权请求' : 'Approval request'}</span>
        <h2 id="agent-approval-title">{title}</h2>
      </div></div>
      <div className="approval-detail"><span>{zh ? '请求原因' : 'Reason'}</span>
        <strong>{request.reason || (zh ? `${request.toolName} 请求授权` : `${request.toolName} requests approval`)}</strong>
      </div>
      {request.command !== '' && <div className="approval-detail"><span>{zh ? '将执行的命令' : 'Command'}</span>
        <pre className="agent-approval-command">{request.command}</pre></div>}
      {request.cwd !== '' && <div className="approval-detail"><span>{zh ? '工作目录' : 'Working directory'}</span><code>{request.cwd}</code></div>}
      <div className="approval-detail"><span>{zh ? '所属会话' : 'Conversation'}</span><code>{request.sessionId}</code></div>
      {request.details !== '' && <div className="approval-detail"><span>{zh ? '请求范围' : 'Requested scope'}</span>
        <pre className="agent-approval-command">{request.details}</pre></div>}
      {request.kind === 'command' && request.command === '' && <p className="approval-footnote">
        {zh ? '未收到完整命令预览；请先查看聊天中的工具调用详情，不确定时拒绝。' : 'No full command preview was received. Inspect the tool call in chat; deny if unsure.'}
      </p>}
      <div className="approval-actions">
        <button className="deny" autoFocus disabled={deciding} onClick={() => onDecision('deny')}>{zh ? '拒绝' : 'Deny'}</button>
        <button className="allow" disabled={deciding} onClick={() => onDecision('once')}>{zh ? '允许一次' : 'Allow once'}</button>
        {request.backend === 'codex' && <button className="session-trust" disabled={deciding}
          onClick={() => onDecision('session')}>{zh ? '本会话允许' : 'Allow for session'}</button>}
      </div>
      <small className="approval-footnote">{zh ? '「允许一次」仅批准当前请求；浏览器授权不会授予本地文件权限。' : 'Allow once applies only to this request. Browser access does not grant filesystem access.'}</small>
    </section>
  </div>
}

/**
 * A page quote: the highlighted text plus where it came from. The quote is
 * page-authored, so it renders as plain text and never as markdown.
 */
function SelectionQuote({
  selection,
  copy,
  label,
  onRemove,
}: {
  selection: { title: string; url: string; quote: string; truncated: boolean }
  copy: PanelCopy
  label: string
  onRemove?: () => void
}): React.JSX.Element {
  const source = selectionSourceLabel(selection)
  return (
    <div className="page-selection">
      <blockquote className="page-selection-quote" title={selection.quote}>
        {selection.quote}
        {selection.truncated && <span className="page-selection-truncated"> {copy.app.selectionTruncated}</span>}
      </blockquote>
      <div className="page-selection-meta">
        <span className="page-selection-chip">
          <QuoteIcon />
          <span>{label}</span>
          {onRemove !== undefined && (
            <button
              type="button"
              aria-label={copy.app.removeSelection}
              title={copy.app.removeSelection}
              onClick={onRemove}
            >×</button>
          )}
        </span>
        {source !== '' && <span className="page-selection-source" title={selection.url}>{source}</span>}
      </div>
    </div>
  )
}

/**
 * One conversation row body. Memoized: rows are immutable (append/merge copy
 * the array but reuse row objects), so markdown is re-parsed only when a
 * row's text actually changes — typing must not re-render every message.
 */
const MessageBody = memo(function MessageBody({
  row,
  sessionId,
  api,
  copy,
}: {
  row: Row
  sessionId: string
  api: PanelApi
  copy: PanelCopy
}): React.JSX.Element {
  if (row.kind === 'user' || row.kind === 'assistant') {
    // A user message may carry a page quote; show the quote, not its fence.
    const attached = row.kind === 'user' ? splitSelectionMessage(row.text) : null
    const text = row.kind === 'assistant'
      ? assistantDisplayText(row.text)
      : attached === null ? row.text : attached.message
    return (
      <div className="body message-body md">
        <MessageImages
          images={row.images ?? []}
          sessionId={sessionId}
          api={api}
          align={row.kind === 'user' ? 'end' : 'start'}
          copy={copy}
        />
        {attached !== null && (
          <SelectionQuote
            selection={attached.selection}
            copy={copy}
            label={copy.app.selectionAttached}
          />
        )}
        {text.trim() !== '' && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
      </div>
    )
  }
  return <pre>{row.text}</pre>
})

function assistantDisplayText(text: string): string {
  return text
    .replace(/<tandix-skill-save-json>[\s\S]*?<\/tandix-skill-save-json>/giu, '')
    .replace(/<tandix-skill-pair-json>[\s\S]*?<\/tandix-skill-pair-json>/giu, '')
    .replace(/<tandix-skill-json>[\s\S]*?<\/tandix-skill-json>/giu, '')
    .trim()
}

interface HistoryPage {
  events: { event: SessionEventView }[]
  assistantStream?: unknown
  snapshotId?: string
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

const ToolActivity = memo(function ToolActivity({ row, copy }: { row: Row; copy: PanelCopy }): React.JSX.Element {
  const running = row.status === 'running'
  const tools = row.tools ?? []
  const category = tools.length > 0 && tools.every((tool) => tool.name === 'bash')
    ? copy.tool.localCommand
    : tools.length > 0 && tools.every((tool) => tool.name.startsWith('browser_'))
      ? running ? copy.tool.running : copy.tool.complete
      : copy.tool.otherTool
  const state = running ? <span className="spinner" />
    : row.status === 'failed' ? copy.tool.failed
    : row.status === 'interrupted' ? copy.tool.interrupted : copy.tool.done
  return (
    <details className={`tool-activity ${running ? 'running' : row.status ?? 'complete'}`}>
      <summary aria-label={`${category}: ${row.text}. ${copy.tool.details}`}>
        <span className="tool-icon"><ToolIcon /></span>
        <span className="tool-copy">
          <span className="tool-label">{category}</span>
          <span className="tool-summary">{row.text}</span>
        </span>
        <span className="tool-state" aria-label={running ? copy.tool.inProgress : copy.tool.completed}>{state}</span>
      </summary>
      <div className="tool-details">
        {tools.map((tool, index) => <div className="tool-detail" key={`${tool.callId ?? tool.name}-${index}`}>
          <strong>{tool.name} · {tool.status === 'running' ? copy.tool.inProgress
            : tool.status === 'failed' ? copy.tool.failed
            : tool.status === 'interrupted' ? copy.tool.interrupted : copy.tool.completed}</strong>
          <span>{copy.tool.input}</span>
          <pre>{tool.input}</pre>
          {tool.output !== undefined && <><span>{copy.tool.output}</span><pre>{tool.output}</pre></>}
        </div>)}
      </div>
    </details>
  )
})

export function App(): React.JSX.Element {
  const [locale, setLocale] = useState<UiLocale>(getUiLocale)
  const copy = PANEL_COPY[locale]
  useEffect(() => {
    void loadUiLocale().then(setLocale)
  }, [])
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    document.title = copy.documentTitle
  }, [locale, copy.documentTitle])
  const [api] = useState<PanelApi>(() => connectPanel())
  const [workspaceMode, setWorkspaceMode] = useState<'chat' | 'run'>('chat')
  const [skills, setSkills] = useState<ChatSkill[]>([])
  const [managedSkillCount, setManagedSkillCount] = useState(0)
  const [proposedSkill, setProposedSkill] = useState<ChatSkillDraft | null>(null)
  const [skillQuestionAnswers, setSkillQuestionAnswers] = useState<Record<number, string>>({})
  const [skillExtracting, setSkillExtracting] = useState(false)
  const recordingIdRef = useRef<string | null>(null)
  const recentActionsRef = useRef<RecordingEventInput[]>([])
  const [state, setState] = useState<BridgeState>('stopped')
  const [caps, setCaps] = useState<BridgeCaps | null>(null)
  const [backend, setBackend] = useState<AgentBackend>('dsh')
  const backendRef = useRef<AgentBackend>('dsh')
  const [showBackendPicker, setShowBackendPicker] = useState(false)
  const [switchingBackend, setSwitchingBackend] = useState(false)
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [streamRow, setStreamRow] = useState<Row | null>(null)
  const [draft, setDraft] = useState<ComposerDraft<DraftImage, DraftFile>>(() => emptyComposerDraft())
  const input = draft.text
  const draftImages = draft.images
  const draftFiles = draft.files
  const [selection, setSelection] = useState<PageSelection | null>(null)
  const [imageLimits, setImageLimits] = useState<ImageAttachmentLimits | null>(null)
  const [addingImages, setAddingImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [uiScale, setUiScale] = useState(DEFAULT_UI_SCALE)
  const uiScaleRef = useRef(DEFAULT_UI_SCALE)
  const uiScaleChosenRef = useRef(false)
  const [showTextSize, setShowTextSize] = useState(false)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  const [agentApprovals, setAgentApprovals] = useState<AgentApproval[]>([])
  const [agentApprovalBusy, setAgentApprovalBusy] = useState(false)
  const [tabAffinity, setTabAffinity] = useState<TabAffinityState | null>(null)
  const [trustedOriginInput, setTrustedOriginInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sessionChanging, setSessionChanging] = useState(false)
  const [sessionList, setSessionList] = useState<SessionPickerEntry[]>([])
  const [relayProfiles, setRelayProfiles] = useState<RelayProfileDraft[]>([])
  const [relayLoaded, setRelayLoaded] = useState(false)
  const [relayNotice, setRelayNotice] = useState<string | null>(null)
  const [relayBusy, setRelayBusy] = useState(false)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const [goal, setGoal] = useState<GoalState | null>(null)
  const [goalBusy, setGoalBusy] = useState(false)
  const [goalStartError, setGoalStartError] = useState<string | null>(null)
  const [goalFormOpen, setGoalFormOpen] = useState(false)
  const [goalTask, setGoalTask] = useState('')
  const [goalDrafting, setGoalDrafting] = useState(false)
  const [goalDraftReady, setGoalDraftReady] = useState(false)
  const [goalOutcome, setGoalOutcome] = useState('')
  const [goalVerification, setGoalVerification] = useState('')
  const [goalConstraints, setGoalConstraints] = useState('')
  const [goalBoundaries, setGoalBoundaries] = useState('')
  const [goalIterationPolicy, setGoalIterationPolicy] = useState('')
  const [goalBlockedStop, setGoalBlockedStop] = useState('')
  const [goalBudgetLimit, setGoalBudgetLimit] = useState('')
  const [resumeHint, setResumeHint] = useState<{ ready: boolean; sessionId: string | null }>({ ready: false, sessionId: null })
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [questionSubmissions, setQuestionSubmissions] = useState<ResolvedQuestion[]>([])
  const approvalQueueRef = useRef<ApprovalRequest[]>([])
  const questionsRef = useRef<PendingQuestion[]>([])
  const questionSubmissionsRef = useRef<ResolvedQuestion[]>([])
  const stoppingRef = useRef(false)
  const addingImagesRef = useRef(false)
  const sendingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imageProjectionRef = useRef<{
    sessionId: string | null
    seq: number
    limits: ImageAttachmentLimits | null
  }>({ sessionId: null, seq: Number.NEGATIVE_INFINITY, limits: null })
  const sessionChangingRef = useRef(false)
  const sessionTransitionRef = useRef(0)
  const sessionInitializationRef = useRef(false)
  const sessionRuntimeRef = useRef(new SessionRuntimeCache())
  const assistantStreamsRef = useRef(new Map<string, AssistantStreamView>())
  const followSnapshotsRef = useRef(new Map<string, {
    id: string
    suffix: SessionEventView[]
    applied?: true
    overflow?: true
  }>())
  const pendingHistoriesRef = useRef(new Map<string, { sessionId: string; history: HistoryPage }>())
  const streamRefreshRef = useRef(new Set<string>())
  const seqRef = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const sessionPickerRequestRef = useRef(0)
  const sessionContentTitlesRef = useRef(new Map<string, string | null>())
  const pendingSkillExtractionRef = useRef<string | null>(null)
  const pendingGoalDraftRef = useRef<string | null>(null)
  const proposedSkillRef = useRef<ChatSkillDraft | null>(null)
  const proposedSkillSessionRef = useRef<string | null>(null)
  const importedSkillRef = useRef<ChatSkill | null>(null)
  const skillSavingRef = useRef(false)
  const pendingManagedSkillSaveRef = useRef<{ sessionId: string; sentAt: number; retries: number } | null>(null)
  const managedSkillDraftRef = useRef<ManagedSkillInput | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const refreshSkills = (): void => {
      void loadChatSkills().then(setSkills).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    }
    const refreshManagedSkillCount = (): void => {
      void loadManagedSkills().then((items) => setManagedSkillCount(items.length)).catch(() => {})
    }
    refreshSkills()
    refreshManagedSkillCount()
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName === 'local' && changes[CHAT_SKILLS_STORAGE_KEY] !== undefined) refreshSkills()
      if (areaName === 'local' && changes[MANAGED_SKILLS_STORAGE_KEY] !== undefined) refreshManagedSkillCount()
    }
    chrome.storage.onChanged?.addListener(onStorageChanged)
    return () => { chrome.storage.onChanged?.removeListener(onStorageChanged) }
  }, [])

  const nextSeq = (): number => { seqRef.current += 1; return seqRef.current }
  const question = questions[0] ?? null
  const questionSubmitting = question !== null && hasPendingQuestion(questionSubmissions, question)
  const sessionSwitchBlocked = sessionChanging || busy || addingImages || stopping || goalBusy || goalDrafting
    || questions.length > 0 || approvalQueue.length > 0
  const sessionReady = sessionAcceptsPrompts(
    state === 'connected',
    sessionChanging,
    sessionRef.current,
  )
  function replaceQuestions(next: PendingQuestion[]): void {
    questionsRef.current = next
    setQuestions(next)
  }

  function updateApprovalQueue(update: (current: ApprovalRequest[]) => ApprovalRequest[]): void {
    setApprovalQueue((current) => {
      const next = update(current)
      approvalQueueRef.current = next
      return next
    })
  }

  function removeQuestion(target: ResolvedQuestion): void {
    sessionRuntimeRef.current.resolveQuestion(target)
    replaceQuestions(removePendingQuestion(questionsRef.current, target))
    setQuestionBusy(target, false)
  }

  function clearQuestions(): void {
    replaceQuestions([])
    questionSubmissionsRef.current = []
    setQuestionSubmissions([])
  }

  function setQuestionBusy(target: PendingQuestion | ResolvedQuestion, next: boolean): void {
    const current = questionSubmissionsRef.current
    const updated = next
      ? hasPendingQuestion(current, target)
        ? current
        : [...current, { sessionId: target.sessionId, rpcId: target.rpcId }]
      : removePendingQuestion(current, target)
    questionSubmissionsRef.current = updated
    setQuestionSubmissions(updated)
  }

  // Text size: the stylesheet reads --ui-scale, so seed the document from
  // storage before the first paint the user notices, then keep the two in step.
  // A choice made while the read is still in flight has already been persisted,
  // so the late seed must not overwrite it and revert what the user sees.
  useEffect(() => {
    void loadUiScale().then((stored) => {
      if (uiScaleChosenRef.current) return
      uiScaleRef.current = stored
      setUiScale(stored)
      applyUiScale(stored)
    })
  }, [])

  // The stepper emits a direction, not a value: resolving the next step against
  // the ref keeps a fast double-click from computing both steps off the same
  // stale render and silently collapsing them into one.
  function changeUiScale(next: number): void {
    uiScaleChosenRef.current = true
    uiScaleRef.current = next
    setUiScale(next)
    applyUiScale(next)
    saveUiScale(next)
  }

  // Settings: seed from storage, then let the panel own the form.
  useEffect(() => {
    void chrome.storage.local.get('dshSettings').then((stored) => {
      const raw = stored.dshSettings as Partial<PanelSettings> | undefined
      setSettings({
        bridgeUrl: raw?.bridgeUrl ?? '',
        token: raw?.token ?? '',
        agentBackend: agentPreference(raw?.agentBackend),
        sandboxDirectory: raw?.sandboxDirectory ?? '',
        sharePageContent: raw?.sharePageContent ?? 'auto',
        unrestrictedBrowserAccess: raw?.unrestrictedBrowserAccess ?? false,
        trustedActionOrigins: raw?.trustedActionOrigins ?? [],
        approvalNotifications: raw?.approvalNotifications ?? true,
        autoResumeSession: raw?.autoResumeSession ?? true,
        autoFollowTabs: raw?.autoFollowTabs ?? (import.meta.env.EXT_TARGET === 'firefox'),
      })
    })
  }, [])

  useEffect(() => {
    const offState = api.onRecordingState((next) => {
      rememberRecordingState(next)
    })
    const offEvent = api.onRecordingEvent((recordingId, event) => {
      if (recordingIdRef.current !== recordingId) return
      const cutoff = Date.now() - 10 * 60_000
      recentActionsRef.current = [...recentActionsRef.current, event]
        .filter((item) => item.capturedAt >= cutoff).slice(-200)
    })
    void api.getRecordingState().then((next) => {
      rememberRecordingState(next)
    }).catch(() => {})
    return () => { offState(); offEvent() }
  }, [api])

  function rememberRecordingState(next: TeachState): void {
    // Chrome pauses one tab's recorder while the user works in another tab.
    // Keep this panel's already-routed events so returning to the page still
    // represents its own complete recent-ten-minute activity window.
    recordingIdRef.current = next.phase === 'recording' ? next.recordingId ?? null : null
  }

  // 每次连接重启（连接配置变更/断线重连）都新建会话。状态消息逐条监听：
  // React 会把 stopped/connecting 等瞬时状态合并进同一帧渲染，依赖渲染
  // 状态无法可靠观察到"连接已重置"，因此在这里按消息粒度判定。
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const lastStateRef = useRef<BridgeState | null>(null)
  useEffect(() => {
    const offStatus = api.onStatus((next, nextCaps, nextBackend, failure) => {
      setConnectionError(failure ?? null)
      setState(next)
      setCaps(nextCaps)
      setBackend(nextBackend)
      backendRef.current = nextBackend
      if (next !== 'connected') setAgentApprovals([])
      const previous = lastStateRef.current
      lastStateRef.current = next
      if (previous !== null && next !== previous && next === 'stopped') {
        sessionTransitionRef.current += 1
        sessionInitializationRef.current = false
        sessionChangingRef.current = false
        sessionRef.current = null
        setResumeHint({ ready: false, sessionId: null })
        sessionRuntimeRef.current.clear()
        assistantStreamsRef.current.clear()
        followSnapshotsRef.current.clear()
        pendingHistoriesRef.current.clear()
        streamRefreshRef.current.clear()
        setStreamRow(null)
        setRows([])
        setDraft((current) => ({ ...current, images: [], files: [] }))
        setImageLimits(null)
        imageProjectionRef.current = { sessionId: null, seq: Number.NEGATIVE_INFINITY, limits: null }
        setSessionTitle(null)
        setGoal(null)
        setGoalStartError(null)
        setGoalFormOpen(false)
        setGoalTask('')
        setGoalDrafting(false)
        setGoalDraftReady(false)
        pendingGoalDraftRef.current = null
        setWorking(false)
        setStopping(false)
        setSessionChanging(false)
        setShowSessionPicker(false)
        stoppingRef.current = false
        clearQuestions()
        setSessionEpoch((epoch) => epoch + 1)
      }
    })
    const offEvent = api.onEvent((frame) => { void onFrame(frame) })
    const offApproval = api.onApprovalRequest((request) => {
      updateApprovalQueue((current) => current.some((entry) => entry.id === request.id) ? current : [...current, request])
    })
    const offApprovalResolved = api.onApprovalResolved((id) => {
      updateApprovalQueue((current) => current.filter((request) => request.id !== id))
    })
    const offTabAffinity = api.onTabAffinity((next) => {
      setTabAffinity(next)
    })
    const offSelection = api.onSelection(setSelection)
    // A side panel has no sender.tab, so it reports its own window; the
    // background answers with whatever that window already had selected.
    void Promise.resolve(chrome.windows.getCurrent())
      .then((window) => { if (window.id !== undefined) return api.registerWindow(window.id) })
      .catch(() => {})
    const offResumeHint = api.onSessionResumeHint((sessionId) => {
      setResumeHint({ ready: true, sessionId })
    })
    void api.requestStatus().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      offStatus(); offEvent(); offApproval(); offApprovalResolved()
      offTabAffinity(); offSelection(); offResumeHint()
    }
  }, [api])

  useEffect(() => {
    if (state === 'connected' && settings !== null && resumeHint.ready && sessionRef.current === null) {
      void initializeSession()
    }
  }, [state, sessionEpoch, settings, resumeHint])

  const queuedApproval = approvalQueue[0]
  useEffect(() => {
    const sessionId = approvalSessionToFocus(
      queuedApproval,
      sessionRef.current,
      sessionChangingRef.current,
      state === 'connected',
    )
    if (sessionId !== undefined && queuedApproval !== undefined) void focusApprovalSession(queuedApproval)
  }, [queuedApproval?.id, queuedApproval?.sessionId, sessionChanging, state])

  // Auto-scroll to the newest row.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [rows, streamRow, working])

  function applyImageProjection(sessionId: string, seq: number, value: unknown): void {
    if (sessionRef.current !== sessionId || !Number.isSafeInteger(seq)) return
    const previous = imageProjectionRef.current
    if (previous.sessionId === sessionId && seq <= previous.seq) return
    const limits = parseImageAttachmentLimits(value)
    imageProjectionRef.current = { sessionId, seq, limits }
    setImageLimits(limits)
  }

  function applyHistoryImageProjection(sessionId: string, projections: HistoryPage['projections']): void {
    if (projections === undefined) {
      applyImageProjection(sessionId, -1, undefined)
      return
    }
    const values = projections.values
    applyImageProjection(
      sessionId,
      projections.asOfSeq,
      typeof values === 'object' && values !== null ? values.imageLimits : undefined,
    )
  }

  /** Live frame handling: session events append rows; turn/end reconciles with history. */
  async function onFrame(frame: ServerFrame): Promise<void> {
    if (frame.t !== 'event') return
    if (frame.frame.method === 'goal/refresh') {
      const payload = frame.frame.payload as { sessionId?: unknown } | undefined
      if (payload?.sessionId === sessionRef.current) void refreshGoal(payload.sessionId as string)
      return
    }
    if (frame.frame.method === 'goal/updated' || frame.frame.method === 'goal/cleared') {
      const payload = frame.frame.payload as { sessionId?: unknown; goal?: GoalState } | undefined
      if (payload?.sessionId === sessionRef.current) {
        const nextGoal = frame.frame.method === 'goal/cleared' ? null : payload.goal ?? null
        setGoal(nextGoal)
        if (nextGoal?.status !== 'active') setGoalStartError(null)
      }
      return
    }
    if (frame.frame.method === 'codex/open-url') {
      const payload = frame.frame.payload as { url?: unknown; sessionId?: unknown } | undefined
      if (payload?.sessionId !== sessionRef.current || typeof payload.url !== 'string') return
      try {
        const url = new URL(payload.url)
        if (url.protocol === 'https:' || (url.protocol === 'http:'
          && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
          await chrome.tabs.create({ url: url.toString() })
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      return
    }
    const agentApproval = agentApprovalFromFrame(frame.frame)
    if (agentApproval !== null) {
      setAgentApprovals((current) => current.some((entry) => entry.rpcId === agentApproval.rpcId)
        ? current : [...current, agentApproval])
      return
    }
    const resolvedAgentApproval = agentApprovalResolvedFromFrame(frame.frame)
    if (resolvedAgentApproval !== null) {
      setAgentApprovals((current) => current.filter((entry) => entry.rpcId !== resolvedAgentApproval))
      return
    }
    if (frame.frame.method === 'session/assistant-stream') {
      const payload = frame.frame.payload as { sessionId?: unknown; snapshotId?: unknown; frame?: unknown } | undefined
      if (typeof payload?.sessionId !== 'string' || typeof payload.frame !== 'object' || payload.frame === null) return
      const sessionId = payload.sessionId
      const stream = assistantStreamsRef.current.get(sessionId) ?? new AssistantStreamView()
      assistantStreamsRef.current.set(sessionId, stream)
      const value = payload.frame as { type?: unknown; baseline?: unknown }
      if (value.type === 'snapshot' && typeof payload.snapshotId === 'string') {
        followSnapshotsRef.current.set(sessionId, { id: payload.snapshotId, suffix: [] })
      }
      const update = value.type === 'snapshot' ? stream.replace(value.baseline) : stream.accept(value)
      if (sessionId !== sessionRef.current) return
      if (value.type === 'snapshot' && typeof payload.snapshotId === 'string') {
        const pending = pendingHistoriesRef.current.get(payload.snapshotId)
        // Only a matching pushed baseline may release a history response that
        // beat it through the RPC channel. Other pending cuts may belong to a
        // newer follower whose baseline is still queued behind this one.
        pendingHistoriesRef.current.delete(payload.snapshotId)
        if (pending !== undefined) applyHistory(sessionId, pending.history)
      }
      const streamedRow = stream.row()
      setStreamRow(streamedRow)
      if (streamedRow?.kind === 'assistant') {
        handleExtractedSkillText(streamedRow.text, sessionId)
        if (pendingManagedSkillSaveRef.current?.sessionId === sessionId) {
          managedSkillDraftRef.current = parseManagedSkillEnvelope(streamedRow.text) ?? managedSkillDraftRef.current
        }
      }
      if (update === 'rebaseline') await rebaselineStream(sessionId)
      return
    }
    const pendingQuestion = pendingQuestionFromFrame(frame.frame)
    if (pendingQuestion !== null) {
      sessionRuntimeRef.current.rememberQuestion(pendingQuestion)
      if (pendingQuestion.sessionId === sessionRef.current) {
        const wasEmpty = questionsRef.current.length === 0
        replaceQuestions(upsertPendingQuestion(questionsRef.current, pendingQuestion))
        if (wasEmpty) setError(null)
      }
      return
    }
    const resolvedQuestion = resolvedQuestionFromFrame(frame.frame)
    if (resolvedQuestion !== null) {
      removeQuestion(resolvedQuestion)
      return
    }
    if (frame.frame.method === 'session/projection'
      && typeof frame.frame.payload === 'object'
      && frame.frame.payload !== null) {
      const projection = frame.frame.payload as {
        sessionId?: unknown
        key?: unknown
        value?: unknown
        seq?: unknown
      }
      if (typeof projection.sessionId === 'string'
        && projection.key === 'imageLimits'
        && typeof projection.seq === 'number') {
        applyImageProjection(projection.sessionId, projection.seq, projection.value)
      }
      return
    }
    const payload = frame.frame.payload as { sessionId?: string; event?: SessionEventView } | undefined
    if (payload?.sessionId === undefined || payload.event === undefined) return
    if (payload.event.type === 'goal/change' && payload.sessionId === sessionRef.current) {
      void refreshGoal(payload.sessionId)
    }
    const followed = followSnapshotsRef.current.get(payload.sessionId)
    if (followed !== undefined && !followed.applied && !followed.overflow) {
      if (followed.suffix.length < 2048) followed.suffix.push(payload.event)
      else {
        followed.overflow = true
        followed.suffix = []
        void rebaselineStream(payload.sessionId)
      }
    }
    const stream = assistantStreamsRef.current.get(payload.sessionId)
    if (stream?.settle(payload.event) && payload.sessionId === sessionRef.current) setStreamRow(stream.row())
    const nextTitle = sessionTitleFromEvent(payload.event)
    if (nextTitle !== undefined && payload.sessionId === sessionRef.current) {
      sessionContentTitlesRef.current.set(payload.sessionId, nextTitle)
      setSessionTitle(nextTitle)
      return
    }
    if (payload.event.type === 'user/message') sessionContentTitlesRef.current.delete(payload.sessionId)
    if (payload.event.type === 'turn/start') {
      sessionRuntimeRef.current.startTurn(payload.sessionId)
      if (payload.sessionId !== sessionRef.current) return
      setGoalStartError(null)
      stoppingRef.current = false
      setStopping(false)
      setWorking(true)
      return
    }
    if (payload.event.type === 'turn/end') {
      sessionRuntimeRef.current.finishTurn(payload.sessionId)
      if (payload.sessionId !== sessionRef.current) return
      setRows((prev) => interruptRunningTools(prev))
      stoppingRef.current = false
      setStopping(false)
      setWorking(false)
      if (pendingSkillExtractionRef.current === payload.sessionId) {
        setSkillExtracting(false)
      }
      clearQuestions()
      await refreshHistory(payload.sessionId)
      void refreshGoal(payload.sessionId)
      const saveRequest = pendingManagedSkillSaveRef.current
      if (saveRequest?.sessionId === payload.sessionId) {
        try {
          let stored = await loadManagedSkills()
          if (!stored.some((skill) => skill.sourceSessionId === saveRequest.sessionId
            && skill.updatedAt >= saveRequest.sentAt) && managedSkillDraftRef.current !== null) {
            await saveManagedSkill(managedSkillDraftRef.current, saveRequest.sessionId)
            stored = await loadManagedSkills()
          }
          if (stored.some((skill) => skill.sourceSessionId === saveRequest.sessionId
            && skill.updatedAt >= saveRequest.sentAt)) {
            setManagedSkillCount(stored.length)
            pendingManagedSkillSaveRef.current = null
            managedSkillDraftRef.current = null
            setWorkspaceMode('run')
          } else if (saveRequest.retries === 0) {
            pendingManagedSkillSaveRef.current = { ...saveRequest, retries: 1 }
            const clientTimeZone = browserTimeZone()
            await api.rpc('session.prompt', {
              sessionId: saveRequest.sessionId,
              mode: 'queue',
              tandixSkillSaveIntent: true,
              content: promptContent(
                'The user asked to save the skill from the preceding conversation in the Tandix Skills tab. ' +
                'Tandix has not received a save receipt. Complete that request now: call tandix_skill_save ' +
                'with the reusable skill name, when-to-use description, and instructions. ' +
                'If that tool is unavailable, return only ' +
                '<tandix-skill-save-json>{"name":"...","description":"...","instructions":"..."}</tandix-skill-save-json> ' +
                'with real content so Tandix can save it. Do not claim success without confirmation.',
                [],
              ),
              ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
            })
          } else {
            pendingManagedSkillSaveRef.current = null
            setError(locale === 'zh'
              ? '重试后仍未收到网页助手的技能保存回执，技能尚未保存到「技能」Tab。'
              : 'No Tandix skill save receipt was found after a retry; nothing was saved to the Skills tab.')
          }
        } catch (cause) {
          pendingManagedSkillSaveRef.current = null
          setError(locale === 'zh' ? `无法核对技能保存结果：${cause instanceof Error ? cause.message : String(cause)}`
            : `Could not verify skill storage: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      if (pendingGoalDraftRef.current === payload.sessionId) {
        pendingGoalDraftRef.current = null
        setGoalDrafting(false)
        setError(locale === 'zh' ? 'Agent 未返回有效的目标草案，请重试或在聊天中补充任务信息。'
          : 'The agent did not return a valid goal draft. Retry or add more task detail in chat.')
      }
      if (pendingSkillExtractionRef.current === payload.sessionId && proposedSkillRef.current === null) {
        setError(locale === 'zh'
          ? 'AI 未返回有效的“浏览器技能 + 非浏览器技能”草稿，请重新点击「生成技能」。'
          : 'The AI did not return a valid browser + non-browser skill draft. Choose Create skill again.')
      }
      return
    }
    if (payload.sessionId !== sessionRef.current) return
    const row = rowFromEvent(payload.event)
    if (row !== null) {
      if (row.kind === 'assistant') {
        handleExtractedSkillText(row.text, payload.sessionId)
        handleGoalDraftText(row.text, payload.sessionId)
        if (pendingManagedSkillSaveRef.current?.sessionId === payload.sessionId) {
          managedSkillDraftRef.current = parseManagedSkillEnvelope(row.text) ?? managedSkillDraftRef.current
        }
      }
      setRows((prev) => appendLiveRow(prev, row.kind, row.text, nextSeq(), row.images))
      return
    }
    if (payload.event.type === 'tool/call') {
      setWorking(true)
      setRows((prev) => appendToolCall(prev, payload.event!, nextSeq(), locale))
      return
    }
    if (payload.event.type === 'tool/result') {
      setRows((prev) => completeToolCall(prev, payload.event!, nextSeq()))
      return
    }
  }

  async function answerQuestion(target: PendingQuestion, answers: QuestionAnswer[]): Promise<void> {
    if (hasPendingQuestion(questionSubmissionsRef.current, target)
      || !hasPendingQuestion(questionsRef.current, target)) return
    setQuestionBusy(target, true)
    setError(null)
    try {
      const receipt = await api.respond(target.rpcId, {
        ok: true,
        value: { sessionId: target.sessionId, answer: { answers } },
      })
      settleQuestionReceipt(target, receipt)
    } catch (cause) {
      if (hasPendingQuestion(questionsRef.current, target)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setQuestionBusy(target, false)
    }
  }

  async function dismissQuestion(target: PendingQuestion): Promise<void> {
    if (hasPendingQuestion(questionSubmissionsRef.current, target)
      || !hasPendingQuestion(questionsRef.current, target)) return
    setQuestionBusy(target, true)
    setError(null)
    try {
      const receipt = await api.respond(target.rpcId, {
        ok: false,
        error: { code: 'cancelled', message: 'the user dismissed this question request', details: {} },
      })
      settleQuestionReceipt(target, receipt)
    } catch (cause) {
      if (hasPendingQuestion(questionsRef.current, target)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setQuestionBusy(target, false)
    }
  }

  function settleQuestionReceipt(target: PendingQuestion, receipt: unknown): void {
    const disposition = questionReceiptDisposition(receipt)
    if (disposition === 'accepted') {
      removeQuestion(target)
      return
    }
    if (disposition === 'not-pending') {
      setError(copy.question.alreadyAnswered)
      removeQuestion(target)
      return
    }
    setError(copy.question.answerRejected)
    setQuestionBusy(target, false)
  }

  async function readHistory(id: string): Promise<HistoryPage> {
    return api.rpc<HistoryPage>('session.history', { sessionId: id })
  }

  async function rebaselineStream(sessionId: string): Promise<void> {
    if (sessionRef.current !== sessionId || streamRefreshRef.current.has(sessionId)) return
    streamRefreshRef.current.add(sessionId)
    try { await refreshHistory(sessionId) } finally { streamRefreshRef.current.delete(sessionId) }
  }

  function applyHistory(id: string, history: HistoryPage): void {
    if (sessionRef.current !== id) return
    const followed = followSnapshotsRef.current.get(id)
    // A newer history request may have replaced this follower while the RPC
    // response was travelling. Its older cut cannot replace the current view.
    if (history.snapshotId !== undefined && followed !== undefined && followed.id !== history.snapshotId) {
      pendingHistoriesRef.current.set(history.snapshotId, { sessionId: id, history })
      // Bound retired RPC responses that will never receive another baseline.
      if (pendingHistoriesRef.current.size > 32) {
        const oldest = pendingHistoriesRef.current.keys().next().value
        if (oldest !== undefined) pendingHistoriesRef.current.delete(oldest)
      }
      return
    }
    const events = history.events.map((entry) => entry.event)
    if (history.snapshotId !== undefined && followed?.id === history.snapshotId) {
      if (followed.overflow) {
        void rebaselineStream(id)
        return
      }
      events.push(...followed.suffix)
      followed.applied = true
      followed.suffix = []
    }
    if (pendingSkillExtractionRef.current === id) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const candidate = rowFromEvent(events[index]!)
        if (candidate?.kind === 'assistant' && handleExtractedSkillText(candidate.text, id)) break
      }
    }
    if (pendingManagedSkillSaveRef.current?.sessionId === id && managedSkillDraftRef.current === null) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const candidate = rowFromEvent(events[index]!)
        if (candidate?.kind !== 'assistant') continue
        const draft = parseManagedSkillEnvelope(candidate.text)
        if (draft !== null) { managedSkillDraftRef.current = draft; break }
      }
    }
    applyHistoryImageProjection(id, history.projections)
    const historyTitle = latestSessionTitle(events)
    const contentTitle = latestSessionContentTitle(events)
    sessionContentTitlesRef.current.set(id, historyTitle ?? contentTitle ?? null)
    if (historyTitle !== undefined) setSessionTitle(historyTitle)
    else if (contentTitle !== undefined) setSessionTitle(contentTitle)
    setRows(mergeHistoryRows(events, nextSeq, locale))
    // Only the baseline correlated with this history may have a newer live
    // suffix. A view left by a previous follower is stale, even when revisiting
    // the same session; absent stream state authoritatively clears that view.
    let stream = assistantStreamsRef.current.get(id)
    const hasMatchingBaseline = history.snapshotId !== undefined && followed?.id === history.snapshotId
    if (!hasMatchingBaseline || stream === undefined) {
      stream = new AssistantStreamView()
      if (history.assistantStream !== undefined) stream.replace(history.assistantStream)
      assistantStreamsRef.current.set(id, stream)
    }
    setStreamRow(stream.row())
  }

  async function refreshHistory(requestedId: string | null = sessionRef.current): Promise<void> {
    const id = requestedId
    if (id === null) return
    try {
      applyHistory(id, await readHistory(id))
    } catch (cause) {
      if (sessionRef.current === id) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function refreshGoal(sessionId: string): Promise<void> {
    try {
      const result = await api.rpc<{ goal: GoalState | null }>('goal.get', { sessionId })
      if (sessionRef.current === sessionId) {
        setGoal(result?.goal ?? null)
        if (result?.goal?.status !== 'active') setGoalStartError(null)
      }
    } catch {
      // A backend without Goal support reports an error at creation.
      if (sessionRef.current === sessionId) {
        setGoal(null)
        setGoalStartError(null)
      }
    }
  }

  function handleGoalDraftText(text: string, sessionId: string): boolean {
    if (pendingGoalDraftRef.current !== sessionId) return false
    const draft = parseGoalDraft(text, backendRef.current)
    if (draft === null) return false
    pendingGoalDraftRef.current = null
    setGoalOutcome(draft.outcome)
    setGoalVerification(draft.verification)
    setGoalConstraints(draft.constraints)
    setGoalBoundaries(draft.boundaries)
    setGoalIterationPolicy(draft.iterationPolicy)
    setGoalBlockedStop(draft.blockedStop)
    setGoalBudgetLimit(String(draft.budgetLimit))
    setGoalDraftReady(true)
    setGoalDrafting(false)
    return true
  }

  async function requestGoalDraft(): Promise<void> {
    const sessionId = sessionRef.current
    if (sessionId === null || working || busy || goalBusy
      || pendingGoalDraftRef.current !== null || goalTask.trim() === '') return
    pendingGoalDraftRef.current = sessionId
    setGoalDraftReady(false)
    setGoalDrafting(true)
    setWorking(true)
    setError(null)
    try {
      const clientTimeZone = browserTimeZone()
      await api.rpc('session.prompt', { sessionId, mode: 'queue',
        content: promptContent(buildGoalDraftPrompt(goalTask, backend), [], []),
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
    } catch (cause) {
      if (pendingGoalDraftRef.current === sessionId) pendingGoalDraftRef.current = null
      if (sessionRef.current === sessionId) {
        setGoalDrafting(false)
        setWorking(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  async function createGoal(): Promise<void> {
    const sessionId = sessionRef.current
    if (sessionId === null || goalBusy || working || !goalDraftReady
      || goalOutcome.trim() === '' || goalVerification.trim() === ''
      || goalIterationPolicy.trim() === '' || goalBlockedStop.trim() === '') return
    const budgetLimit = Number(goalBudgetLimit)
    if (!Number.isSafeInteger(budgetLimit) || budgetLimit <= 0
      || (backend === 'dsh' && budgetLimit > 256)) {
      setError(locale === 'zh' ? '预算上限必须是有效的正整数。' : 'Budget limit must be a valid positive integer.')
      return
    }
    setGoalBusy(true)
    setError(null)
    setGoalStartError(null)
    try {
      const result = await api.rpc<{ goal: GoalState }>('goal.create', {
        sessionId,
        objective: buildGoalObjective({ outcome: goalOutcome, verification: goalVerification,
          constraints: goalConstraints, boundaries: goalBoundaries,
          iterationPolicy: goalIterationPolicy, blockedStop: goalBlockedStop }),
        budgetLimit,
      })
      if (sessionRef.current === sessionId) {
        setGoal(result.goal)
        setGoalFormOpen(false)
        setGoalDraftReady(false)
        await startGoalTask(sessionId, goalTask)
      }
    } catch (cause) {
      if (sessionRef.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setGoalBusy(false) }
  }

  async function startGoalTask(sessionId: string, task: string): Promise<void> {
    if (sessionRef.current !== sessionId) return
    setWorking(true)
    setGoalStartError(null)
    try {
      const clientTimeZone = browserTimeZone()
      await api.rpc('session.prompt', { sessionId, mode: 'queue',
        content: promptContent(buildGoalStartPrompt(task), [], []),
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
    } catch (cause) {
      if (sessionRef.current !== sessionId) return
      setWorking(false)
      const detail = cause instanceof Error ? cause.message : String(cause)
      setGoalStartError(detail)
      setError(locale === 'zh'
        ? `目标已创建，但启动任务失败：${detail}`
        : `Goal created, but the task did not start: ${detail}`)
    }
  }

  async function retryGoalStart(): Promise<void> {
    const sessionId = sessionRef.current
    if (sessionId === null || goal === null || goal.status !== 'active'
      || goalBusy || working || goalStartError === null) return
    setGoalBusy(true)
    setError(null)
    try { await startGoalTask(sessionId, goalTask) }
    finally { setGoalBusy(false) }
  }

  async function continueGoal(): Promise<void> {
    const sessionId = sessionRef.current
    if (sessionId === null || goal?.status !== 'active' || goal.activation === 'disarmed'
      || goalBusy || working || goalStartError !== null) return
    setGoalBusy(true)
    setWorking(true)
    setError(null)
    try {
      const clientTimeZone = browserTimeZone()
      await api.rpc('session.prompt', { sessionId, mode: 'queue',
        content: promptContent(buildGoalContinuePrompt(), [], []),
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
    } catch (cause) {
      if (sessionRef.current === sessionId) {
        setWorking(false)
        const detail = cause instanceof Error ? cause.message : String(cause)
        setError(locale === 'zh' ? `未能提交继续请求：${detail}` : `Could not submit continuation: ${detail}`)
      }
    } finally { setGoalBusy(false) }
  }

  async function updateGoalStatus(status: 'active' | 'paused'): Promise<void> {
    const sessionId = sessionRef.current
    if (sessionId === null || goalBusy) return
    setGoalBusy(true)
    setError(null)
    try {
      const result = await api.rpc<{ goal: GoalState }>(status === 'active' ? 'goal.resume' : 'goal.pause', { sessionId })
      if (sessionRef.current === sessionId) setGoal(result.goal)
    } catch (cause) {
      if (sessionRef.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setGoalBusy(false) }
  }

  async function clearGoal(): Promise<void> {
    const sessionId = sessionRef.current
    if (sessionId === null || goalBusy || !window.confirm(locale === 'zh'
      ? '结束并移除这个目标？已完成的工作与聊天记录会保留。'
      : 'End and remove this goal? Existing work and chat history will remain.')) return
    setGoalBusy(true)
    setError(null)
    try {
      await api.rpc('goal.clear', { sessionId })
      if (sessionRef.current === sessionId) {
        setGoal(null)
        setGoalStartError(null)
      }
    } catch (cause) {
      if (sessionRef.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setGoalBusy(false) }
  }

  async function createSession(transition: number): Promise<void> {
    const created = await api.rpc<{ sessionId: string }>('session.create', {})
    if (sessionTransitionRef.current !== transition) return
    sessionRef.current = created.sessionId
    await api.setActiveSession(created.sessionId, true)
    setSessionTitle(null)
    setGoal(null)
    setGoalStartError(null)
    sessionRuntimeRef.current.seedRunning(created.sessionId, false)
    applyHistory(created.sessionId, await readHistory(created.sessionId))
  }

  /** Load the raw host index plus workspace archive state once. */
  async function loadSessionCatalog(): Promise<{
    items: SessionPickerEntry[]
    archived: Set<string>
  }> {
    const [listed, workspaces] = await Promise.all([
      api.rpc<{ items: SessionPickerEntry[] }>('session.list', {}),
      api.rpc<{ archivedSessionIds?: string[] }>('workspace.list', {}).catch(() => ({ archivedSessionIds: [] as string[] })),
    ])
    const archived = new Set(workspaces.archivedSessionIds ?? [])
    for (const entry of listed.items ?? []) {
      sessionRuntimeRef.current.seedRunning(entry.sessionId, entry.running)
    }
    return { items: listed.items ?? [], archived }
  }

  /** Filter the raw catalog for the manual history picker. */
  async function loadVisibleSessions(): Promise<SessionPickerEntry[]> {
    const { items, archived } = await loadSessionCatalog()
    return resumableSessions(items).filter((entry) => !archived.has(entry.sessionId))
  }

  /** Backfill untitled rows from user messages without blocking the sorted list. */
  async function hydrateSessionTitles(items: SessionPickerEntry[], request: number): Promise<void> {
    const untitled = items.filter((entry) => entry.sessionId !== sessionRef.current
      && projectedSessionTitle(entry) === undefined && !sessionContentTitlesRef.current.has(entry.sessionId))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < untitled.length && sessionPickerRequestRef.current === request) {
        const entry = untitled[next++]!
        try {
          const history = await readHistory(entry.sessionId)
          const events = history.events.map((item) => item.event)
          const title = latestSessionTitle(events) ?? latestSessionContentTitle(events)
          if (sessionPickerRequestRef.current !== request) continue
          sessionContentTitlesRef.current.set(entry.sessionId, title ?? null)
          if (title === undefined) continue
          setSessionList((current) => current.map((item) => item.sessionId === entry.sessionId
            ? { ...item, contentTitle: title } : item))
          if (sessionRef.current === entry.sessionId) setSessionTitle(title)
        } catch { /* Keep the distinct ID fallback if this history cannot be read. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, untitled.length) }, worker))
  }

  /** Restore only the exact current-page conversation, otherwise create a chat. */
  async function initializeSession(): Promise<void> {
    if (sessionInitializationRef.current || sessionChangingRef.current || sessionRef.current !== null) return
    sessionInitializationRef.current = true
    const transition = beginSessionTransition()
    try {
      const hinted = settings?.autoResumeSession === true ? resumeHint.sessionId : null
      if (hinted !== null && hinted.trim() !== '') {
        try {
          const { items, archived } = await loadSessionCatalog()
          // A contextual hint may identify a live provisional/blank session,
          // which is intentionally hidden only from the manual history picker.
          const entry = archived.has(hinted)
            ? undefined
            : items.find((candidate) => candidate.sessionId === hinted && candidate.origin !== 'subagent')
          if (entry !== undefined) {
            const history = await readHistory(hinted)
            if (sessionTransitionRef.current !== transition) return
            const runtime = sessionRuntimeRef.current.snapshot(hinted, entry.running)
            // A highlight captured while startup history is loading belongs to
            // the still-open page, so automatic restoration must not erase it.
            prepareSessionSwitch(runtime.running, runtime.questions, true)
            sessionRef.current = hinted
            await api.setActiveSession(hinted)
            setSessionTitle(projectedSessionTitle(entry) ?? sessionDisplayTitle(entry))
            applyHistory(hinted, history)
            void refreshGoal(hinted)
            return
          }
        } catch {
          // Missing, archived, or unreadable contextual sessions start fresh.
        }
      }
      await createSession(transition)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      sessionInitializationRef.current = false
      finishSessionTransition(transition)
    }
  }

  /** 打开历史会话选择器：拉取持久化会话列表（已过滤空白会话），供恢复。 */
  async function openSessionPicker(): Promise<void> {
    if (showSessionPicker) {
      sessionPickerRequestRef.current += 1
      setShowSessionPicker(false)
      return
    }
    if (state !== 'connected' || sessionSwitchBlocked || sessionChangingRef.current) return
    const request = ++sessionPickerRequestRef.current
    setShowSessionPicker(true)
    setLoadingSessions(true)
    try {
      const items = (await loadVisibleSessions()).map((entry) => {
        if (projectedSessionTitle(entry) !== undefined) return entry
        const cached = sessionContentTitlesRef.current.get(entry.sessionId)
        if (cached !== undefined && cached !== null) return { ...entry, contentTitle: cached }
        return entry.sessionId === sessionRef.current && sessionTitle !== null
          && sessionTitle !== entry.sessionId && !sessionTitle.endsWith(` · ${entry.sessionId.slice(-8)}`)
          ? { ...entry, contentTitle: sessionTitle } : entry
      })
      if (sessionPickerRequestRef.current !== request) return
      const current = items.find((entry) => entry.sessionId === sessionRef.current)
      const currentTitle = current === undefined ? undefined : projectedSessionTitle(current)
      if (currentTitle !== undefined) setSessionTitle(currentTitle)
      setSessionList(items)
      void hydrateSessionTitles(items, request)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingSessions(false)
    }
  }

  /** 恢复历史会话：切换当前 session 并加载其历史。 */
  async function resumeSession(entry: SessionPickerEntry): Promise<void> {
    if (sessionSwitchBlocked || sessionChangingRef.current) return
    const transition = beginSessionTransition()
    try {
      await api.setActiveSession(entry.sessionId)
      if (sessionTransitionRef.current !== transition) return
      const runtime = sessionRuntimeRef.current.snapshot(entry.sessionId, entry.running)
      prepareSessionSwitch(runtime.running, runtime.questions)
      sessionRef.current = entry.sessionId
      setSessionTitle(projectedSessionTitle(entry) ?? sessionDisplayTitle(entry))
      await refreshHistory(entry.sessionId)
      void refreshGoal(entry.sessionId)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      finishSessionTransition(transition)
    }
  }

  /** 删除历史会话：由桥接在存储锁内归档并清理，拒绝时保留重试入口。 */
  async function deleteSession(entry: SessionPickerEntry): Promise<void> {
    if (entry.running || sessionSwitchBlocked || sessionChangingRef.current) return
    const title = projectedSessionTitle(entry) ?? sessionDisplayTitle(entry)
    if (!window.confirm(copy.app.deleteSessionConfirm(title))) return
    try {
      await api.rpc(BRIDGE_SESSION_PURGE_METHOD, { sessionId: entry.sessionId })
      setSessionList((prev) => prev.filter((item) => item.sessionId !== entry.sessionId))
      if (sessionRef.current === entry.sessionId) {
        setShowSessionPicker(false)
        await startNewSession()
      }
    } catch (cause) {
      setError(copy.app.deleteSessionFailed(cause instanceof Error ? cause.message : String(cause)))
    }
  }

  /** Load the session that owns an approval before exposing its decision UI. */
  async function focusApprovalSession(request: ApprovalRequest): Promise<void> {
    const sessionId = request.sessionId
    if (sessionId === undefined || sessionChangingRef.current || sessionRef.current === sessionId) return
    const transition = beginSessionTransition()
    let history: HistoryPage | undefined
    let historyError: unknown
    try {
      try {
        history = await readHistory(sessionId)
      } catch (cause) {
        historyError = cause
      }
      if (sessionTransitionRef.current !== transition
        || !approvalQueueRef.current.some((entry) => entry.id === request.id)) return
      const runtime = sessionRuntimeRef.current.snapshot(sessionId)
      prepareSessionSwitch(runtime.running, runtime.questions)
      sessionRef.current = sessionId
      await api.setActiveSession(sessionId)
      setSessionTitle(sessionId)
      if (history !== undefined) applyHistory(sessionId, history)
      else setError(historyError instanceof Error ? historyError.message : String(historyError))
      void refreshGoal(sessionId)
    } finally {
      finishSessionTransition(transition)
    }
  }

  /** 新建会话：创建后由 session.active(isNew) 将其绑定到当前标签页。 */
  async function startNewSession(): Promise<void> {
    if (sessionSwitchBlocked || sessionChangingRef.current) return
    const transition = beginSessionTransition()
    try {
      sessionRef.current = null
      setSessionTitle(null)
      prepareSessionSwitch(false)
      await createSession(transition)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      finishSessionTransition(transition)
    }
  }

  function beginSessionTransition(): number {
    sessionChangingRef.current = true
    setSessionChanging(true)
    sessionTransitionRef.current += 1
    return sessionTransitionRef.current
  }

  function finishSessionTransition(transition: number): void {
    if (sessionTransitionRef.current !== transition) return
    sessionChangingRef.current = false
    setSessionChanging(false)
  }

  /** Drop the attached quote here and in every other open panel. */
  function dismissSelection(): void {
    const dismissed = selection
    setSelection(null)
    if (dismissed !== null) void api.clearSelection(dismissed).catch(() => {})
  }

  function prepareSessionSwitch(
    nextWorking: boolean,
    nextQuestions: PendingQuestion[] = [],
    preserveSelection = false,
  ): void {
    setRows([])
    setGoal(null)
    setGoalStartError(null)
    setGoalFormOpen(false)
    setGoalTask('')
    setGoalDrafting(false)
    setGoalDraftReady(false)
    pendingGoalDraftRef.current = null
    setStreamRow(null)
    setDraft(emptyComposerDraft())
    if (!preserveSelection) {
      setSelection(null)
      // An explicit conversation switch abandons whatever attachment is
      // current when the background processes it, rather than a stale render.
      void api.clearSelection().catch(() => {})
    }
    setImageLimits(null)
    imageProjectionRef.current = { sessionId: null, seq: Number.NEGATIVE_INFINITY, limits: null }
    setWorking(nextWorking)
    setStopping(false)
    stoppingRef.current = false
    replaceQuestions(nextQuestions)
    questionSubmissionsRef.current = []
    setQuestionSubmissions([])
    setError(null)
    setShowSessionPicker(false)
  }

  async function addImageFiles(files: readonly File[]): Promise<void> {
    const limits = imageLimits
    const sessionId = sessionRef.current
    if (files.length === 0 || limits === null || sessionId === null
      || !canAcceptImageSelection(addingImagesRef.current, sendingRef.current)) return
    addingImagesRef.current = true
    setAddingImages(true)
    setError(null)
    const existing = draftImages
    try {
      const prepared = await prepareImageFiles(files, existing, limits)
      if (sessionRef.current === sessionId) {
        setDraft((current) => ({ ...current, images: [...current.images, ...prepared] }))
      }
    } catch (cause) {
      if (sessionRef.current === sessionId) setError(imageErrorMessage(cause, copy, limits))
    } finally {
      addingImagesRef.current = false
      setAddingImages(false)
    }
  }

  async function addAttachmentFiles(files: readonly File[]): Promise<void> {
    const images = files.filter((file) => !file.type.startsWith('video/'))
    const generic = files.filter((file) => file.type.startsWith('video/'))
    if (images.length > 0) await addImageFiles(images)
    if (generic.length === 0) return
    if (backend !== 'codex') {
      setError(locale === 'zh' ? '视频附件需要使用 Codex；请切换 Agent。' : 'Video attachments require the Codex backend.')
      return
    }
    const sessionId = sessionRef.current
    if (sessionId === null || addingImagesRef.current || sendingRef.current) return
    addingImagesRef.current = true
    setAddingImages(true)
    setError(null)
    try {
      const prepared = await prepareGenericFiles(generic)
      if (sessionRef.current === sessionId) {
        setDraft((current) => ({ ...current, files: [...current.files, ...prepared] }))
      }
    } catch (cause) {
      if (sessionRef.current === sessionId) setError(imageErrorMessage(cause, copy, imageLimits ?? undefined))
    } finally {
      addingImagesRef.current = false
      setAddingImages(false)
    }
  }

  async function send(textOverride?: string): Promise<boolean> {
    const text = (textOverride ?? input).trim()
    const saveSkillIntent = textOverride === undefined && requestsSkillSave(text)
    const submittedImages = textOverride === undefined ? draftImages : []
    const submittedFiles = textOverride === undefined ? draftFiles : []
    // A quick-start prompt asks about the whole page, not about a quote.
    const submittedSelection = textOverride === undefined ? selection : null
    const id = sessionRef.current
    // busy state 是异步的：连续回车可能都通过 state 检查——用 ref 同步锁。
    if ((text === '' && submittedImages.length === 0 && submittedFiles.length === 0 && submittedSelection === null)
      || busy || goalDrafting || addingImagesRef.current || sendingRef.current || sessionChangingRef.current || id === null) return false
    sendingRef.current = true
    const submittedDraft: ComposerDraft<DraftImage, DraftFile> = {
      text, images: submittedImages, files: submittedFiles,
    }
    if (textOverride === undefined) {
      setDraft(emptyComposerDraft())
    }
    setBusy(true)
    setWorking(true)
    setError(null)
    // 不渲染乐观行：live user/message 事件即时回显，避免同一消息出现两行。
    try {
      if (saveSkillIntent) {
        pendingManagedSkillSaveRef.current = { sessionId: id, sentAt: Date.now(), retries: 0 }
        managedSkillDraftRef.current = null
      }
      const clientTimeZone = browserTimeZone()
      await api.rpc('session.prompt', {
        sessionId: id,
        mode: 'queue',
        ...(saveSkillIntent ? { tandixSkillSaveIntent: true } : {}),
        content: promptContent(
          submittedSelection === null ? text : selectionPromptText(submittedSelection, text),
          submittedImages,
          submittedFiles,
        ),
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
      if (submittedSelection !== null) {
        // Keep the background authoritative while the prompt is in flight.
        // Conditional clearing cannot consume a newer highlight captured in
        // the meantime, and its broadcast updates every panel together.
        void api.clearSelection(submittedSelection).then(() => {
          setSelection((current) => current?.capturedAt === submittedSelection.capturedAt ? null : current)
        }).catch(() => {})
      }
      return true
    } catch (cause) {
      if (saveSkillIntent && pendingManagedSkillSaveRef.current?.sessionId === id) {
        pendingManagedSkillSaveRef.current = null
        managedSkillDraftRef.current = null
      }
      if (sessionRef.current === id) {
        setError(imageErrorMessage(cause, copy, imageLimits ?? undefined))
        setWorking(false)
        if (textOverride === undefined) {
          setDraft((current) => restoreSubmittedDraft(current, submittedDraft))
        }
      }
      return false
    } finally {
      setBusy(false)
      sendingRef.current = false
    }
  }

  async function extractSkillFromRecentActions(): Promise<void> {
    if (!sessionReady || sessionRef.current === null) {
      setError(locale === 'zh' ? '请先连接 Agent。' : 'Connect an agent first.')
      return
    }
    const cutoff = Date.now() - 10 * 60_000
    const events = recentActionsRef.current.filter((event) => event.capturedAt >= cutoff)
    const evidence = buildSkillExtractionEvidence(events, latestSkillIntent(rows))
    const composer = new CompactRecordingComposer()
    for (const event of events) composer.accept(event, locale)
    const recap = composer.snapshot()
    if (events.length === 0 || !hasSkillExtractionCandidates(evidence)) {
      setError(locale === 'zh'
        ? '最近 10 分钟没有可提炼的页面操作。请先在当前页面完成一些操作，再生成技能。'
        : 'No useful page actions were observed in the last 10 minutes. Complete the workflow on the current page, then create the skill.')
      return
    }
    pendingSkillExtractionRef.current = sessionRef.current
    setSkillExtracting(true)
    proposedSkillRef.current = null
    await clearChatSkillDraftCheckpoint().catch(() => {})
    setSkillQuestionAnswers({})
    setProposedSkill(null)
    const accepted = await send(buildExtractSkillPrompt(recap, locale, evidence))
    if (!accepted) {
      pendingSkillExtractionRef.current = null
      setSkillExtracting(false)
      setError(locale === 'zh' ? '提炼请求未发送，请检查 Agent 连接。' : 'Extraction request was not sent. Check the agent connection.')
    }
  }

  /** Parse one extraction reply; every draft remains reviewable until explicitly confirmed. */
  function handleExtractedSkillText(text: string, sourceSessionId: string): boolean {
    const extracted = parseExtractedSkill(text)
    if (extracted === null) return false
    // A side-panel reload can clear React refs while the durable checkpoint and
    // conversation remain. A valid protocol payload reclaims that session.
    if (pendingSkillExtractionRef.current !== sourceSessionId) {
      pendingSkillExtractionRef.current = sourceSessionId
    }
    setSkillExtracting(false)
    const previousQuestions = proposedSkillRef.current?.questions ?? []
    if (previousQuestions.length !== extracted.questions.length
      || previousQuestions.some((question, index) => question !== extracted.questions[index])) {
      setSkillQuestionAnswers({})
    }
    proposedSkillRef.current = extracted
    proposedSkillSessionRef.current = sourceSessionId
    void checkpointChatSkillDraft(extracted, sourceSessionId).catch(() => {})
    importedSkillRef.current = null
    setError(null)
    setProposedSkill(extracted)
    return true
  }

  async function acceptProposedSkill(): Promise<boolean> {
    const currentDraft = proposedSkillRef.current ?? proposedSkill
    if (currentDraft === null || currentDraft.questions.length > 0) return false
    return await persistSkillDraft(currentDraft, proposedSkillSessionRef.current ?? '')
  }

  async function submitSkillQuestionAnswers(): Promise<void> {
    const currentDraft = proposedSkillRef.current ?? proposedSkill
    if (currentDraft === null || currentDraft.questions.length === 0) return
    const answers = currentDraft.questions.map((question, index) => ({
      question,
      answer: (skillQuestionAnswers[index] ?? '').trim(),
    }))
    if (answers.some((entry) => entry.answer === '')) {
      setError(locale === 'zh' ? '请回答全部待确认问题。' : 'Answer every clarification question.')
      return
    }
    const prompt = locale === 'zh'
      ? `对技能草案待确认问题的回答：\n${answers.map((entry, index) => `${index + 1}. ${entry.question}\n回答：${entry.answer}`).join('\n')}\n\n请应用这些回答，并重新输出完整的 <tandix-skill-pair-json>；没有已审核的 API/CLI 契约时，desktopSkill 保持 null。不要只回复更新说明。`
      : `Answers to the skill draft questions:\n${answers.map((entry, index) => `${index + 1}. ${entry.question}\nAnswer: ${entry.answer}`).join('\n')}\n\nApply these answers and re-emit the complete <tandix-skill-pair-json>. Keep desktopSkill null without a reviewed API/CLI contract. Do not reply with an update summary only.`
    if (await send(prompt)) setSkillQuestionAnswers({})
  }

  async function persistSkillDraft(skillDraft: ChatSkillDraft, sourceSessionId: string): Promise<boolean> {
    if (skillSavingRef.current) return false
    skillSavingRef.current = true
    const skill = importedSkillRef.current ?? finalizeExtractedSkill(skillDraft, sourceSessionId)
    try {
      setSkills(await saveChatSkill(skill))
      proposedSkillRef.current = null
      setSkillQuestionAnswers({})
      setProposedSkill(null)
      pendingSkillExtractionRef.current = null
      proposedSkillSessionRef.current = null
      importedSkillRef.current = null
      await clearChatSkillDraftCheckpoint().catch(() => {})
      setError(null)
      setWorkspaceMode('run')
      return true
    } catch (cause) {
      setError(locale === 'zh'
        ? `技能保存失败：${cause instanceof Error ? cause.message : String(cause)}`
        : `Failed to save skill: ${cause instanceof Error ? cause.message : String(cause)}`)
      return false
    } finally {
      skillSavingRef.current = false
    }
  }

  async function importSkillJson(text: string): Promise<void> {
    const skill = parseImportedSkill(text)
    if (skill === null) throw new Error(locale === 'zh' ? '文件不是有效的 tandix.agent-skill/v1 技能。' : 'Not a valid tandix.agent-skill/v1 skill file.')
    importedSkillRef.current = skill
    proposedSkillRef.current = { ...skill, questions: [] }
    setSkillQuestionAnswers({})
    setProposedSkill(proposedSkillRef.current)
    setWorkspaceMode('chat')
  }

  async function removeSavedSkill(id: string): Promise<void> {
    setSkills(await deleteChatSkill(id))
  }

  async function runSavedSkill(skill: ChatSkill, values: Record<string, string>): Promise<void> {
    if (!sessionReady) throw new Error(locale === 'zh' ? '请先连接聊天会话。' : 'Connect a chat session first.')
    const prompt = buildChatSkillPrompt(skill, values, locale)
    setWorkspaceMode('chat')
    await send(prompt)
  }

  /** Stop the turn and, for an active Goal, prevent automatic continuation. */
  async function stopTurn(): Promise<void> {
    const id = sessionRef.current
    if (id === null || stoppingRef.current || sessionChangingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    setError(null)
    try {
      if (goal?.status === 'active') {
        const result = await api.rpc<{ goal: GoalState }>('goal.pause', { sessionId: id })
        if (sessionRef.current === id) setGoal(result.goal)
      }
      await api.rpc('session.cancel', { sessionId: id })
      if (sessionRef.current === id) {
        if (pendingGoalDraftRef.current === id) {
          pendingGoalDraftRef.current = null
          setGoalDrafting(false)
        }
        sessionRuntimeRef.current.finishTurn(id)
        setWorking(false)
        clearQuestions()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }

  async function saveSettings(): Promise<void> {
    if (settings === null) return
    const sandboxDirectory = settings.sandboxDirectory.trim()
    if (sandboxDirectory !== '' && !sandboxDirectory.startsWith('/') && !sandboxDirectory.startsWith('~/')) {
      setError(copy.settings.sandboxDirectoryInvalid)
      return
    }
    if (sandboxDirectory !== '' && settings.bridgeUrl.trim() !== '') {
      setError(copy.settings.sandboxDirectoryLocalOnly)
      return
    }
    try {
      const relaySaved = backend !== 'dsh' ? true : await saveRelayProfiles()
      if (!relaySaved) return
      await api.updateSettings(settings)
      setShowSettings(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function chooseBackend(next: PanelSettings['agentBackend']): Promise<void> {
    if (settings === null || switchingBackend || working || sessionSwitchBlocked) return
    setShowBackendPicker(false)
    if (next === settings.agentBackend && state === 'connected') return
    setSwitchingBackend(true)
    setError(null)
    try {
      await api.updateSettings({ agentBackend: next }, true)
      setSettings((current) => current === null ? current : { ...current, agentBackend: next })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSwitchingBackend(false)
    }
  }

  /** Load relay profiles from the llm-pi-ai settings namespace once per settings visit. */
  useEffect(() => {
    if (!showSettings || relayLoaded || backend !== 'dsh') return
    let cancelled = false
    void (async () => {
      try {
        const described = await api.rpc<{
          namespaces?: Array<{ ns: string; value?: Record<string, unknown> }>
        }>('settings.describe', {})
        const ns = described.namespaces?.find((candidate) => candidate.ns === 'llm-pi-ai')
        const providers = (ns?.value?.providers ?? {}) as Record<string, {
          displayName?: string
          api?: string
          baseURL?: string
          apiKeyEnv?: string
          models?: Array<{ id: string; contextWindow?: number }>
        }>
        const defaults = (described.namespaces?.find((candidate) => candidate.ns === 'agent-default-model')
          ?.value ?? {}) as { provider?: unknown }
        const refs = Object.entries(providers)
          .filter(([key]) => key.startsWith(RELAY_ROUTE_PREFIX))
          .map(([, route]) => typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : '')
          .filter((ref) => ref !== '')
        let configuredRefs = new Set<string>()
        if (refs.length > 0) {
          try {
            const creds = await api.rpc<{ credentials?: Record<string, { configured?: boolean }> }>(
              'credentials.describe',
              { refs },
            )
            configuredRefs = new Set(
              Object.entries(creds.credentials ?? {})
                .filter(([, view]) => view.configured === true)
                .map(([ref]) => ref),
            )
          } catch {
            // Credential visibility is cosmetic here; treat every token as unconfigured.
          }
        }
        const drafts = Object.entries(providers)
          .filter(([key]) => key.startsWith(RELAY_ROUTE_PREFIX))
          .map(([key, route]) => ({
            key,
            name: typeof route.displayName === 'string' && route.displayName !== '' ? route.displayName : key,
            protocol: (route.api === 'anthropic-messages' || route.api === 'openai-codex-responses'
              ? route.api
              : 'openai-completions') as RelayProfileDraft['protocol'],
            baseUrl: typeof route.baseURL === 'string' ? route.baseURL : '',
            token: '',
            tokenConfigured: route.apiKeyEnv !== undefined && configuredRefs.has(route.apiKeyEnv),
            modelsText: (route.models ?? []).map((model) => [
              model.id,
              model.contextWindow === undefined ? '' : String(model.contextWindow),
            ].filter((part) => part !== '').join(', ')).join('\n'),
            setDefault: defaults.provider === key,
          }))
        if (!cancelled) setRelayProfiles(drafts)
      } catch {
        // The namespace may not exist yet; an empty list still allows creating profiles.
      }
      if (!cancelled) setRelayLoaded(true)
    })()
    return () => { cancelled = true }
  }, [api, showSettings, relayLoaded, backend])

  function updateRelayProfile(index: number, patch: Partial<RelayProfileDraft>): void {
    setRelayProfiles((current) => current.map((profile, at) => at === index ? { ...profile, ...patch } : profile))
  }

  function addRelayProfile(): void {
    setRelayNotice(null)
    setRelayProfiles((current) => [...current, {
      key: '',
      name: '',
      protocol: 'openai-completions',
      baseUrl: '',
      token: '',
      tokenConfigured: false,
      modelsText: '',
      setDefault: false,
    }])
  }

  async function removeRelayProfile(index: number): Promise<void> {
    const profile = relayProfiles[index]
    setRelayProfiles((current) => current.filter((_, at) => at !== index))
    setRelayNotice(null)
    if (profile === undefined || profile.key === '') return
    try {
      await api.rpc('settings.mutate', {
        ns: 'llm-pi-ai',
        ops: [{ op: 'unset', path: ['providers', profile.key] }],
      })
      try {
        await api.rpc('credentials.unset', { ref: relayTokenRef(profile.key) })
      } catch {
        // The route is gone either way; a stale credential reference harms nothing.
      }
    } catch (cause) {
      setRelayNotice(copy.settings.relaySaveFailed(cause instanceof Error ? cause.message : String(cause)))
    }
  }

  async function testRelayConnection(index: number): Promise<void> {
    const profile = relayProfiles[index]
    if (profile === undefined || relayBusy) return
    setRelayBusy(true)
    setRelayNotice(copy.settings.relayTesting)
    try {
      const { models, viaOpenaiListing } = await discoverWithFallback(api, profile)
      const ids = models.map((model) => model.id)
      if (ids.length === 0) {
        setRelayNotice(copy.settings.relayTestManualOnly)
        return
      }
      setRelayNotice(copy.settings.relayTestOk(ids.length, ids.slice(0, 4).join(', ')
        + (ids.length > 4 ? ' …' : ''))
        + (viaOpenaiListing ? copy.settings.relayOpenaiListingNote : ''))
    } catch (cause) {
      setRelayNotice(isManualOnlyDiscovery(cause)
        ? copy.settings.relayTestManualOnly
        : copy.settings.relayTestFailed(relayErrorText(cause)))
    } finally {
      setRelayBusy(false)
    }
  }

  /** Discover models from the drafted endpoint and fill the textarea in place. */
  async function fetchRelayModels(index: number): Promise<void> {
    const profile = relayProfiles[index]
    if (profile === undefined || relayBusy) return
    if (profile.baseUrl.trim() === '') {
      setRelayNotice(copy.settings.relayNeedBaseUrl)
      return
    }
    setRelayBusy(true)
    setRelayNotice(copy.settings.relayFetching)
    try {
      const { models, viaOpenaiListing } = await discoverWithFallback(api, profile)
      if (models.length === 0) {
        setRelayNotice(copy.settings.relayTestManualOnly)
        return
      }
      updateRelayProfile(index, {
        modelsText: models.map((model) => [
          model.id,
          model.contextWindow === undefined ? '' : String(model.contextWindow),
        ].filter((part) => part !== '').join(', ')).join('\n'),
      })
      setRelayNotice(copy.settings.relayFetchOk(models.length)
        + (viaOpenaiListing ? copy.settings.relayOpenaiListingNote : ''))
    } catch (cause) {
      setRelayNotice(isManualOnlyDiscovery(cause)
        ? copy.settings.relayTestManualOnly
        : copy.settings.relayTestFailed(relayErrorText(cause)))
    } finally {
      setRelayBusy(false)
    }
  }

  /**
   * Persist every relay draft: token to the credential store, route to the
   * llm-pi-ai namespace, optional default to agent-default-model.
   * @returns false when validation failed and the outer save must abort.
   */
  async function saveRelayProfiles(): Promise<boolean> {
    for (const profile of relayProfiles) {
      if (profile.name.trim() === '') {
        setRelayNotice(copy.settings.relayInvalidName)
        return false
      }
    }
    try {
      const usedKeys = new Set<string>()
      let defaultApplied = false
      for (const profile of relayProfiles) {
        let key = profile.key !== '' ? profile.key : relayRouteKey(profile.name)
        while (usedKeys.has(key)) key += '-x'
        usedKeys.add(key)
        const ref = relayTokenRef(key)
        if (profile.token.trim() !== '') {
          await api.rpc('credentials.set', { ref, value: profile.token.trim() })
        }
        const models = parseRelayModels(profile.modelsText)
        const firstModel = models[0]
        const routeValue: Record<string, unknown> = {
          displayName: profile.name.trim(),
          apiKeyEnv: ref,
          baseURL: profile.baseUrl.trim(),
          models,
          api: profile.protocol,
        }
        await api.rpc('settings.mutate', {
          ns: 'llm-pi-ai',
          ops: [{ op: 'set', path: ['providers', key], value: routeValue }],
        })
        if (profile.setDefault && !defaultApplied && models.length > 0) {
          await api.rpc('settings.mutate', {
            ns: 'agent-default-model',
            ops: [
              { op: 'set', path: ['provider'], value: key },
              { op: 'set', path: ['model'], value: firstModel?.id ?? '' },
              { op: 'unset', path: ['reasoningEffort'] },
            ],
          })
          defaultApplied = true
          // Model selection is remembered per session; the active one would
          // otherwise stay on its old provider until a new chat is started.
          const activeSessionId = sessionRef.current
          if (activeSessionId !== null && firstModel?.id !== undefined) {
            try {
              await api.rpc('session.selectModel', {
                sessionId: activeSessionId,
                provider: key,
                model: firstModel.id,
              })
            } catch {
              // Best effort: the default still applies to every new session.
            }
          }
        }
      }
      if (relayProfiles.length > 0) setRelayNotice(copy.settings.relaySavedOk)
      return true
    } catch (cause) {
      setRelayNotice(copy.settings.relaySaveFailed(cause instanceof Error ? cause.message : String(cause)))
      return false
    }
  }

  async function decideApproval(decision: ApprovalDecision): Promise<void> {
    const request = approvalQueue[0]
    if (request === undefined) return
    try {
      await api.respondToApproval(request.id, decision)
      if (decision === 'always-allow-reads') {
        setSettings((current) => current === null ? current : { ...current, sharePageContent: 'auto' })
      }
      updateApprovalQueue((current) => current.filter((entry) => entry.id !== request.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function decideAgentApproval(decision: 'deny' | 'once' | 'session'): Promise<void> {
    const request = agentApprovals[0]
    if (request === undefined || agentApprovalBusy) return
    setAgentApprovalBusy(true)
    try {
      const receipt = await api.respond(request.rpcId, { ok: true,
        value: request.backend === 'dsh' ? (decision === 'deny' ? 'rejected' : 'allowed-once')
          : decision === 'deny' ? 'decline' : decision === 'session' ? 'acceptForSession' : 'accept' }) as { accepted?: boolean }
      if (receipt.accepted !== true) throw new Error(locale === 'zh' ? '授权请求已过期或被取消' : 'Approval request expired or was cancelled')
      setAgentApprovals((current) => current.filter((entry) => entry.rpcId !== request.rpcId))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAgentApprovalBusy(false) }
  }

  async function decideTabAffinity(decision: TabAffinityDecision): Promise<void> {
    if (tabAffinity === null) return
    try {
      await api.resolveTabAffinity(tabAffinity.revision, decision, sessionRef.current)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function addTrustedOrigin(): void {
    const origin = normalizeWebOrigin(trustedOriginInput)
    if (origin === null) return
    setSettings((current) => current === null
      ? current
      : { ...current, trustedActionOrigins: [...new Set([...current.trustedActionOrigins, origin])].sort() })
    setTrustedOriginInput('')
  }

  function removeTrustedOrigin(origin: string): void {
    setSettings((current) => current === null
      ? current
      : { ...current, trustedActionOrigins: current.trustedActionOrigins.filter((candidate) => candidate !== origin) })
  }

  // 状态栏只显示连接状态；快照上限是技术细节，在设置页说明（见 hint）。
  const statusText = state === 'connected'
    ? (locale === 'zh' ? `${agentLabel(backend, locale)} 已连接` : `${agentLabel(backend, locale)} connected`)
    : copy.status[state]
  const sessionMenuTitle = sessionTitle ?? copy.app.newSession
  const approvalDialog = agentApprovals[0] !== undefined
    ? <AgentApprovalDialog request={agentApprovals[0]} locale={locale} deciding={agentApprovalBusy} onDecision={(decision) => { void decideAgentApproval(decision) }} />
    : !approvalReadyForSession(queuedApproval, sessionRef.current, sessionChanging)
      ? null : <ApprovalDialog request={queuedApproval!} onDecision={decideApproval} copy={copy} />

  if (showSettings) {
    return (
      <><div className="settings">
        <div className="settings-heading">
          <button className="icon-button" onClick={() => setShowSettings(false)} aria-label={copy.settings.back}><BackIcon /></button>
          <div>
            <span className="eyebrow">{copy.settings.eyebrow}</span>
            <h1>{copy.settings.title}</h1>
          </div>
        </div>
        <UpdateCard copy={copy.update} />
        <div className="settings-panel">
          <label>
            <span>{copy.settings.language}</span>
            <small>{copy.settings.languageHelp}</small>
            <select value={locale} onChange={(event) => {
              const next = event.target.value as UiLocale
              setLocale(next)
              void saveUiLocale(next)
            }}>
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </label>
          {backend === 'dsh' && <><label>
            <span>{copy.settings.bridgeAddress}</span>
            <small>{copy.settings.bridgeHelp}</small>
            <input
              value={settings?.bridgeUrl ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, bridgeUrl: e.target.value })}
              placeholder={copy.settings.bridgePlaceholder}
            />
          </label>
          <label>
            <span>Token</span>
            <small>{copy.settings.tokenHelp}</small>
            <input
              type="password"
              value={settings?.token ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, token: e.target.value })}
              placeholder={copy.settings.tokenPlaceholder}
            />
          </label></>}
          <label className="sandbox-directory-setting">
            <span>{copy.settings.sandboxDirectory}</span>
            <small>{copy.settings.sandboxDirectoryHelp}</small>
            <input
              value={settings?.sandboxDirectory ?? ''}
              onChange={(event) => setSettings((current) => current === null ? current
                : { ...current, sandboxDirectory: event.target.value })}
              placeholder={copy.settings.sandboxDirectoryPlaceholder}
              spellCheck={false}
            />
          </label>
          <label>
            <span>{copy.settings.pageSharing}</span>
            <small>{copy.settings.pageSharingHelp}</small>
            <select
              value={settings?.sharePageContent ?? 'auto'}
              disabled={settings?.unrestrictedBrowserAccess ?? false}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, sharePageContent: e.target.value as PanelSettings['sharePageContent'] })}
            >
              <option value="auto">{copy.settings.sharingAuto}</option>
              <option value="ask">{copy.settings.sharingAsk}</option>
              <option value="off">{copy.settings.sharingOff}</option>
            </select>
          </label>
        </div>
        <div className="settings-panel preference-toggles">
          <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.unrestrictedBrowserAccess}</strong>
              <small>{copy.settings.unrestrictedBrowserAccessHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.unrestrictedBrowserAccess ?? false}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, unrestrictedBrowserAccess: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>
          <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.approvalNotifications}</strong>
              <small>{copy.settings.approvalNotificationsHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.approvalNotifications ?? true}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, approvalNotifications: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>
          <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.autoResumeSession}</strong>
              <small>{copy.settings.autoResumeSessionHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.autoResumeSession ?? true}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, autoResumeSession: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>
          {import.meta.env.EXT_TARGET === 'firefox' && <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.autoFollowTabs}</strong>
              <small>{copy.settings.autoFollowTabsHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.autoFollowTabs ?? true}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, autoFollowTabs: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>}
        </div>
        {backend === 'codex' ? (
          <><section className="relay-config" aria-label="Codex">
            <p>{locale === 'zh'
              ? '正在使用已登录的 Codex。Skills、MCP 和 Plugins 来自同一 Codex 环境。'
              : 'Using your signed-in Codex. Skills, MCP servers and plugins come from the same Codex environment.'}</p>
          </section>
          {state === 'connected' && <CodexCapabilities api={api} sessionId={sessionRef.current} locale={locale} />}</>
        ) : backend === 'workbuddy' ? <section className="relay-config" aria-label="WorkBuddy">
          <p>{locale === 'zh'
            ? 'WorkBuddy 通过本机 ACP Agent 连接。请配置兼容的 Agent 运行时并完成其登录；此连接不会自动复用 WorkBuddy 桌面端账号。'
            : 'WorkBuddy connects through a local ACP agent. Configure and sign in to a compatible runtime; this connection does not automatically reuse the WorkBuddy desktop login.'}</p>
        </section> : <section className="relay-config" aria-labelledby="relay-title">
          <div className="relay-heading">
            <span id="relay-title">
              <strong>{copy.settings.relaySection}</strong>
              <small>{copy.settings.relayHelp}</small>
            </span>
            <button className="secondary" onClick={addRelayProfile}>{copy.settings.relayAdd}</button>
          </div>
          {relayProfiles.length === 0 && <p>{copy.settings.relayEmpty}</p>}
          {relayProfiles.map((profile, index) => (
            <div className="relay-profile" key={profile.key === '' ? `new-${index}` : profile.key}>
              <label>
                <span>{copy.settings.relayName}</span>
                <input
                  value={profile.name}
                  onChange={(event) => updateRelayProfile(index, { name: event.target.value })}
                  placeholder={copy.settings.relayNamePlaceholder}
                />
              </label>
              <label>
                <span>{copy.settings.relayProtocol}</span>
                <select
                  value={profile.protocol}
                  onChange={(event) => updateRelayProfile(index, {
                    protocol: event.target.value as RelayProfileDraft['protocol'],
                  })}
                >
                  <option value="openai-completions">{copy.settings.relayProtocolOpenai}</option>
                  <option value="openai-codex-responses">{copy.settings.relayProtocolCodex}</option>
                  <option value="anthropic-messages">{copy.settings.relayProtocolClaude}</option>
                </select>
              </label>
              <label>
                <span>{copy.settings.relayBaseUrl}</span>
                <input
                  value={profile.baseUrl}
                  onChange={(event) => updateRelayProfile(index, { baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                <span>{copy.settings.relayToken}</span>
                <input
                  type="password"
                  value={profile.token}
                  onChange={(event) => updateRelayProfile(index, { token: event.target.value })}
                  placeholder={copy.settings.relayTokenPlaceholder(profile.tokenConfigured)}
                />
              </label>
              <div className="relay-models">
                <div className="relay-label-row">
                  <span>{copy.settings.relayModels}</span>
                  <button className="relay-fetch" disabled={profile.baseUrl.trim() === '' || relayBusy}
                    onClick={() => { void fetchRelayModels(index) }}>
                    {copy.settings.relayFetchModels}
                  </button>
                </div>
                <small>{copy.settings.relayModelsHelp}</small>
                <textarea
                  rows={3}
                  aria-label={copy.settings.relayModels}
                  value={profile.modelsText}
                  onChange={(event) => updateRelayProfile(index, { modelsText: event.target.value })}
                  placeholder={copy.settings.relayModelsPlaceholder}
                />
              </div>
              <label className="setting-toggle">
                <span className="setting-toggle-copy">
                  <strong>{copy.settings.relaySetDefault}</strong>
                  <small>{copy.settings.relaySetDefaultHelp}</small>
                </span>
                <input
                  className="setting-toggle-input"
                  type="checkbox"
                  checked={profile.setDefault}
                  onChange={(event) => setRelayProfiles((current) => current.map((candidate, at) => at === index
                    ? { ...candidate, setDefault: event.target.checked }
                    : candidate))}
                />
                <span className="setting-toggle-control" aria-hidden="true"><span /></span>
              </label>
              <div className="relay-profile-actions">
                <button
                  disabled={profile.name.trim() === '' || profile.baseUrl.trim() === ''}
                  onClick={() => { void testRelayConnection(index) }}
                >
                  {copy.settings.relayTest}
                </button>
                <button className="secondary" onClick={() => { void removeRelayProfile(index) }}>
                  {copy.settings.relayRemove}
                </button>
              </div>
            </div>
          ))}
          {relayNotice !== null && <p className="hint">{relayNotice}</p>}
        </section>}
        <section className="trusted-origins" aria-labelledby="trusted-origins-title">
          <div>
            <span id="trusted-origins-title">{copy.settings.trustedOrigins}</span>
            <small>{copy.settings.trustedOriginsHelp}</small>
          </div>
          <div className="trusted-origin-add">
            <input
              aria-label={copy.settings.trustedOriginInput}
              value={trustedOriginInput}
              onChange={(event) => setTrustedOriginInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') addTrustedOrigin() }}
              placeholder="https://example.com / https://*.example.com"
            />
            <button disabled={normalizeWebOrigin(trustedOriginInput) === null} onClick={addTrustedOrigin}>{copy.settings.add}</button>
          </div>
          {trustedOriginInput.trim() !== '' && normalizeWebOrigin(trustedOriginInput) === null && (
            <p className="origin-error">{copy.settings.invalidOrigin}</p>
          )}
          {settings?.trustedActionOrigins.length === 0 && <p>{copy.settings.noTrustedOrigins}</p>}
          {settings?.trustedActionOrigins.map((origin) => (
            <div className="trusted-origin" key={origin}>
              <code>{origin}</code>
              <button onClick={() => removeTrustedOrigin(origin)} aria-label={copy.settings.removeOrigin(origin)}>{copy.settings.remove}</button>
            </div>
          ))}
        </section>
        <div className="settings-actions">
          <button className="primary" onClick={saveSettings}>{copy.settings.save}</button>
          <button className="secondary" onClick={() => setShowSettings(false)}>{copy.settings.cancel}</button>
        </div>
        <p className="hint">{copy.settings.snapshotHint(caps?.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS, backend)}</p>
      </div>{approvalDialog}</>
    )
  }

  return (
    <><div className="app">
      <header className="topbar">
        <div className="connection-control">
          <button type="button" className="connection" aria-expanded={showBackendPicker}
            aria-label={locale === 'zh' ? `连接状态：${statusText}。点击选择 Agent` : `Connection: ${statusText}. Choose agent`}
            onClick={() => setShowBackendPicker((shown) => !shown)}>
            <span className={`dot ${state}`} />
            <span className="connection-label">{statusText}</span>
            <ChevronDownIcon />
          </button>
          {showBackendPicker && <div className="backend-picker" role="menu">
            <p>{locale === 'zh' ? '连接到' : 'Connect to'}</p>
            {AGENT_CHOICES.map((choice) => <button type="button" role="menuitemradio"
              key={choice} aria-checked={settings?.agentBackend === choice}
              disabled={settings === null || switchingBackend || working || sessionSwitchBlocked}
              onClick={() => { void chooseBackend(choice) }}>
              <span>{agentLabel(choice, locale)}</span>
              {settings?.agentBackend === choice && <span aria-hidden="true">✓</span>}
            </button>)}
            {(working || sessionSwitchBlocked) && <small>{locale === 'zh' ? '请先停止当前任务再切换' : 'Stop the current task before switching'}</small>}
          </div>}
        </div>
        <button className="session-menu-trigger" disabled={state !== 'connected' || sessionSwitchBlocked}
          aria-expanded={showSessionPicker} aria-label={copy.app.openSessions}
          onClick={() => { void openSessionPicker() }} title={sessionMenuTitle}>
          <span>{sessionMenuTitle}</span>
          <ChevronDownIcon />
        </button>
        <div className="topbar-actions">
          <button className="icon-button new-session-trigger" disabled={state !== 'connected' || sessionSwitchBlocked}
            onClick={() => { void startNewSession() }}
            aria-label={copy.app.newSession} title={copy.app.newSession}>
            <PlusIcon />
          </button>
          <button className="icon-button text-size-trigger" onClick={() => setShowTextSize((open) => !open)}
            aria-expanded={showTextSize} aria-label={copy.textSize.open} title={copy.textSize.open}>
            <TextSizeIcon />
          </button>
          <button className="icon-button settings-trigger" onClick={() => setShowSettings(true)}
            aria-label={copy.app.openSettings} title={copy.app.settings}><SettingsIcon /></button>
        </div>
      </header>
      <nav className="workspace-nav" aria-label={locale === 'zh' ? '网页助手工作模式' : 'Tandix workspace mode'}>
        {(['chat', 'run'] as const).map((mode) => (
          <button key={mode} aria-current={workspaceMode === mode ? 'page' : undefined}
            onClick={() => setWorkspaceMode(mode)}>
            {mode === 'chat' ? 'Chat' : <span className="skills-tab-label">
              <span>{locale === 'zh' ? '技能' : 'Skills'}</span>
              <sup className="skills-tab-count" aria-label={locale === 'zh'
                ? `${skills.length + managedSkillCount} 个技能` : `${skills.length + managedSkillCount} skills`}>{skills.length + managedSkillCount}</sup>
            </span>}
          </button>
        ))}
      </nav>
      {showTextSize && (
        <TextSizePanel scale={uiScale} copy={copy}
          onStep={(direction) => changeUiScale(stepUiScale(uiScaleRef.current, direction))}
          onReset={() => changeUiScale(DEFAULT_UI_SCALE)} />
      )}
      {workspaceMode === 'chat' && <>
      <TabAffinityBanner state={tabAffinity} copy={copy} onDecision={decideTabAffinity} />
      {backend !== 'workbuddy' && <section className="task-goal" aria-label={locale === 'zh' ? '任务目标' : 'Task goal'}>
        {goal === null ? <>
          <div className="task-goal-heading">
            <div><strong>{locale === 'zh' ? '让 Agent 持续完成目标' : 'Give the agent a goal'}</strong>
              <small>{locale === 'zh' ? '适合多步骤任务；普通聊天仍可直接发送。' : 'For multi-step work; regular chat stays available.'}</small></div>
            <button type="button" className="secondary" disabled={!sessionReady || goalBusy || goalDrafting}
              onClick={() => setGoalFormOpen((open) => !open)}>{goalFormOpen ? (locale === 'zh' ? '收起' : 'Close') : (locale === 'zh' ? '设定目标' : 'Set goal')}</button>
          </div>
          {goalFormOpen && <div className="task-goal-form">
            <label>{locale === 'zh' ? '告诉 Agent 你想完成什么' : 'Tell the agent what you want done'}
              <textarea value={goalTask} onChange={(event) => { setGoalTask(event.target.value); setGoalDraftReady(false) }}
                placeholder={locale === 'zh' ? '例如：把这份飞书文档的本周报告补完整' : 'For example: complete this week’s report in the Feishu document'}
                maxLength={4000} rows={3} /></label>
            <button type="button" className="secondary" disabled={!sessionReady || working || busy || goalBusy || goalDrafting || goalTask.trim() === ''}
              onClick={() => { void requestGoalDraft() }}>{goalDrafting
                ? (locale === 'zh' ? 'Agent 正在拟定…' : 'Agent is drafting…')
                : goalDraftReady ? (locale === 'zh' ? '重新生成草案' : 'Regenerate draft')
                  : (locale === 'zh' ? '让 Agent 拟定目标' : 'Ask agent to draft')}</button>
            {goalDraftReady && <>
            <p className="task-goal-review-note">{locale === 'zh' ? '请核对 Agent 的建议；需要时可以修改，确认前不会启动目标。草案仅通过提示词约束为只读。' : 'Review the agent’s suggestion. The Goal starts only after confirmation. Drafting is read-only by instruction, not a hard sandbox.'}</p>
            <label>{locale === 'zh' ? '期望结果' : 'Desired outcome'}
              <textarea value={goalOutcome} onChange={(event) => setGoalOutcome(event.target.value)}
                placeholder={locale === 'zh' ? '例如：在飞书文档中完成本周报告' : 'For example: complete this week’s report in Feishu'} rows={2} /></label>
            <label>{locale === 'zh' ? '完成的证据 / 验收标准' : 'Evidence / completion criteria'}
              <textarea value={goalVerification} onChange={(event) => setGoalVerification(event.target.value)}
                placeholder={locale === 'zh' ? '例如：重新读取文档，确认新增内容和位置' : 'For example: reread the document and confirm content and placement'} rows={2} /></label>
            <label>{locale === 'zh' ? '质量与资源约束（可选）' : 'Quality and resource constraints (optional)'}
              <textarea value={goalConstraints} onChange={(event) => setGoalConstraints(event.target.value)} rows={2} /></label>
            <label>{locale === 'zh' ? '范围、权限与审批（可选）' : 'Scope, permissions and approvals (optional)'}
              <textarea value={goalBoundaries} onChange={(event) => setGoalBoundaries(event.target.value)}
                placeholder={locale === 'zh' ? '例如：只修改指定文档；发送前必须让我确认' : 'For example: edit only the named document; ask before sending'} rows={2} /></label>
            <label>{locale === 'zh' ? '迭代规则' : 'Iteration policy'}
              <textarea value={goalIterationPolicy} onChange={(event) => setGoalIterationPolicy(event.target.value)} rows={2} /></label>
            <label>{locale === 'zh' ? '何时停下并求助' : 'When to stop and ask for help'}
              <textarea value={goalBlockedStop} onChange={(event) => setGoalBlockedStop(event.target.value)} rows={2} /></label>
            <label className="task-goal-budget">{backend === 'codex'
              ? (locale === 'zh' ? '建议 Token 上限' : 'Suggested token budget')
              : (locale === 'zh' ? '建议自主轮次上限' : 'Suggested round limit')}
              <input type="number" min="1" max={backend === 'dsh' ? '256' : undefined}
                step={backend === 'codex' ? '1000' : '1'} value={goalBudgetLimit}
                onChange={(event) => setGoalBudgetLimit(event.target.value)} /></label>
            <button type="button" className="primary" disabled={!sessionReady || working || goalBusy
              || goalOutcome.trim() === '' || goalVerification.trim() === ''
              || goalIterationPolicy.trim() === '' || goalBlockedStop.trim() === ''}
              onClick={() => { void createGoal() }}>{goalBusy ? (locale === 'zh' ? '启动中…' : 'Starting…') : (locale === 'zh' ? '确认并启动目标' : 'Confirm and start goal')}</button>
            </>}
          </div>}
        </> : <>
          <div className="task-goal-heading">
            <div><strong>{locale === 'zh' ? '当前目标' : 'Current goal'}</strong>
              <small role="status">{goal.status === 'active' && goalStartError !== null
                ? (locale === 'zh' ? '目标已创建 · 首轮未启动' : 'Goal created · first turn did not start')
                : goal.status === 'active' && goal.activation === 'disarmed'
                  ? (locale === 'zh' ? '已停止自动续跑 · 需手动继续' : 'Auto-continuation stopped · resume manually')
                  : goal.status === 'active' && working
                    ? (locale === 'zh' ? '正在执行 · 目标仍活跃' : 'Working · goal active')
                    : goal.status === 'active'
                      ? (locale === 'zh' ? '本轮已结束 · 目标仍活跃' : 'Turn ended · goal still active')
                : ({ active: locale === 'zh' ? '进行中' : 'Active', paused: locale === 'zh' ? '已暂停' : 'Paused', blocked: locale === 'zh' ? '遇到阻碍' : 'Blocked', usageLimited: locale === 'zh' ? '用量受限' : 'Usage limited', budgetLimited: locale === 'zh' ? '达到预算上限' : 'Budget reached', complete: locale === 'zh' ? 'Agent 标记完成 · 请核对证据' : 'Agent marked complete · review evidence' })[goal.status]}</small></div>
            <span className="task-goal-usage">{goal.budgetUsed.toLocaleString()}{goal.budgetLimit === null ? '' : ` / ${goal.budgetLimit.toLocaleString()}`} {goal.budgetKind === 'tokens' ? 'tokens' : (locale === 'zh' ? '轮' : 'rounds')}</span>
          </div>
          <p className="task-goal-objective">{goal.objective}</p>
          {goalStartError !== null && <p className="task-goal-review-note" role="alert">{locale === 'zh'
            ? `首轮任务未启动：${goalStartError}。请检查会话记录后重试，避免重复执行。`
            : `The first turn did not start: ${goalStartError}. Check the conversation before retrying to avoid duplicate work.`}</p>}
          {goal.blockedReason && <p className="task-goal-review-note">{goal.blockedReason}</p>}
          <div className="task-goal-actions">
            {goal.status === 'active' && goalStartError !== null && <button type="button" className="secondary"
              disabled={goalBusy || working} onClick={() => { void retryGoalStart() }}>{locale === 'zh' ? '重试启动' : 'Retry start'}</button>}
            {goal.status === 'active' && goal.activation !== 'disarmed' && goalStartError === null && !working
              && <button type="button" className="secondary" disabled={goalBusy}
                onClick={() => { void continueGoal() }}>{locale === 'zh' ? '未自动续跑？继续' : 'Not continuing? Resume'}</button>}
            {goal.status === 'active' && <button type="button" className="secondary" disabled={goalBusy}
              onClick={() => { void updateGoalStatus('paused') }}>{locale === 'zh' ? '暂停目标' : 'Pause goal'}</button>}
            {(goal.status === 'paused' || goal.status === 'blocked' || (goal.status === 'active' && goal.activation === 'disarmed')) && <button type="button" className="secondary" disabled={goalBusy || goal.budgetUsed >= (goal.budgetLimit ?? Infinity)}
              onClick={() => { void updateGoalStatus('active') }}>{locale === 'zh' ? '继续目标' : 'Resume goal'}</button>}
            <button type="button" className="secondary" disabled={goalBusy}
              onClick={() => { void clearGoal() }}>{locale === 'zh' ? '移除目标' : 'Clear goal'}</button>
          </div>
        </>}
      </section>}
      {showSessionPicker && (
        <section className="session-picker" aria-label={copy.app.sessions}>
          <div className="session-picker-head">
            <strong>{copy.app.sessions}</strong>
            <button className="session-new" disabled={state !== 'connected' || sessionSwitchBlocked}
              onClick={() => { void startNewSession() }}>
              {copy.app.newSession}
            </button>
          </div>
          {loadingSessions
            ? <p className="session-empty">{copy.app.sessionPickerLoading}</p>
            : sessionList.length === 0
              ? <p className="session-empty">{copy.app.sessionPickerEmpty}</p>
              : (
                <ul className="session-list">
                  {sessionList.map((entry) => {
                    const title = sessionDisplayTitle(entry)
                    return (
                      <li key={entry.sessionId}>
                        <button disabled={sessionSwitchBlocked}
                          aria-current={entry.sessionId === sessionRef.current ? 'true' : undefined}
                          onClick={() => { void resumeSession(entry) }}>
                          <span className="session-title" title={title}>{title}</span>
                          <span className="session-meta">
                            <span className="session-time">{new Date(entry.updatedAt).toLocaleString()}</span>
                            {entry.cwd !== undefined && <span className="session-cwd" title={entry.cwd}>{entry.cwd}</span>}
                          </span>
                        </button>
                        {backend === 'dsh' && !entry.running && (
                          <button className="icon-button session-delete" disabled={sessionSwitchBlocked}
                            aria-label={copy.app.deleteSession} title={copy.app.deleteSession}
                            onClick={() => { void deleteSession(entry) }}>
                            <TrashIcon />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
        </section>
      )}
      <div className="messages" ref={scrollRef}>
        {rows.length === 0 && streamRow === null && !working && (
          <div className="empty">
            <span className="empty-logo"><img src={brandIconUrl} alt="" /></span>
            <div>
              <h1>{copy.app.emptyTitle}</h1>
              <p>{copy.app.emptyDescription}</p>
            </div>
            <button disabled={!sessionReady}
              onClick={() => { void send(copy.app.overviewPrompt) }}>
              {copy.app.overviewPage}
            </button>
          </div>
        )}
        {rows.map((row) => row.kind === 'assistant' && assistantDisplayText(row.text) === '' ? null : (
          <div key={row.seq} className={`row ${row.kind}`}>
            {row.kind === 'assistant' && <span className="assistant-avatar"><img src={brandIconUrl} alt={copy.app.assistant} /></span>}
            {row.kind === 'tool'
              ? <ToolActivity row={row} copy={copy} />
              : <MessageBody row={row} sessionId={sessionRef.current ?? ''} api={api} copy={copy} />}
          </div>
        ))}
        {streamRow !== null && !(streamRow.kind === 'assistant' && assistantDisplayText(streamRow.text) === '') && (
          <div className="row assistant" aria-live="polite">
            <span className="assistant-avatar"><img src={brandIconUrl} alt={copy.app.assistant} /></span>
            <MessageBody row={streamRow} sessionId={sessionRef.current ?? ''} api={api} copy={copy} />
          </div>
        )}
        {working && streamRow === null && question === null && rows[rows.length - 1]?.status !== 'running' && (
          <div className="ai-progress" role="status" aria-label={copy.app.assistantWorking}>
            <span className="assistant-avatar"><img src={brandIconUrl} alt="" /></span>
            <span className="progress-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{rows[rows.length - 1]?.kind === 'tool' ? copy.app.organizingResults : copy.app.thinking}</span>
          </div>
        )}
      </div>
      {proposedSkill !== null && <section className="chat-skill-review" aria-label={locale === 'zh' ? '待确认的技能草案' : 'Skill draft for review'}>
        <strong>{locale === 'zh' ? '技能草案：' : 'Skill draft: '}{proposedSkill.name}</strong>
        <p>{proposedSkill.goal}</p>
        {proposedSkill.startUrl !== undefined && <p><strong>{locale === 'zh' ? '入口页面：' : 'Start page: '}</strong>{proposedSkill.startUrl}</p>}
        <ol>{proposedSkill.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        <p>{locale === 'zh' ? '成功条件：' : 'Success: '}{proposedSkill.success || (locale === 'zh' ? '待澄清' : 'Needs clarification')}</p>
        <p><strong>{locale === 'zh' ? '运行时需填写：' : 'Run-time inputs: '}</strong>{proposedSkill.parameters.length === 0
          ? (locale === 'zh' ? '无需填写，筛选条件将按技能步骤自动设置。' : 'None; the skill will apply its fixed settings automatically.')
          : proposedSkill.parameters.map((parameter) => parameter.label).join(locale === 'zh' ? '、' : ', ')}</p>
        <p><strong>{locale === 'zh' ? '桌面 Agent 版本：' : 'Desktop Agent version: '}</strong>{proposedSkill.desktopAdapter === undefined
          ? (locale === 'zh' ? '未提供已审核的 API/CLI 契约；可保存、运行和下载浏览器版。' : 'No reviewed API/CLI contract; the browser-only skill can be saved, run, and downloaded.')
          : (locale === 'zh' ? `已生成 ${proposedSkill.desktopAdapter.requests.length} 个 HTTP 请求；下载后运行不依赖网页助手扩展。` : `${proposedSkill.desktopAdapter.requests.length} HTTP request(s) generated; the downloaded package does not depend on the Tandix browser extension.`)}</p>
        {proposedSkill.questions.length > 0
          ? <><p><strong>{locale === 'zh' ? '保存前请确认：' : 'Confirm before saving:'}</strong></p>
            <div className="chat-skill-questions">{proposedSkill.questions.map((question, index) => <label className="chat-skill-field" key={index}>
              <span>{index + 1}. {question}</span>
              <input className="chat-skill-question-answer" value={skillQuestionAnswers[index] ?? ''}
                onChange={(event) => setSkillQuestionAnswers((current) => ({ ...current, [index]: event.target.value }))}
                placeholder={locale === 'zh' ? '输入答案' : 'Enter answer'} />
            </label>)}</div></>
          : <p>{locale === 'zh' ? '确认后将保存技能，并立即出现在「技能」Tab。' : 'Confirm to save the skill and update the Skills tab.'}</p>}
        <div className="chat-skill-actions-footer">
          {proposedSkill.questions.length > 0
            ? <button className="primary skill-clarification-submit" type="button"
                disabled={busy || working || proposedSkill.questions.some((_question, index) => (skillQuestionAnswers[index] ?? '').trim() === '')}
                onClick={() => { void submitSkillQuestionAnswers() }}>{locale === 'zh' ? '提交答案' : 'Submit answers'}</button>
            : <button className="primary" type="button" onClick={() => { void acceptProposedSkill() }}>{locale === 'zh' ? '确认保存' : 'Confirm'}</button>}
          <button className="secondary" type="button" onClick={() => { proposedSkillRef.current = null; setSkillQuestionAnswers({}); setProposedSkill(null); pendingSkillExtractionRef.current = null; void clearChatSkillDraftCheckpoint().catch(() => {}) }}>{locale === 'zh' ? '放弃' : 'Discard'}</button>
        </div>
      </section>}
      {question !== null && (
        <QuestionCard
          key={`${question.sessionId}:${question.rpcId}`}
          question={question}
          copy={copy}
          submitting={questionSubmitting}
          onAnswer={(answers) => { void answerQuestion(question, answers) }}
          onDismiss={() => { void dismissQuestion(question) }}
        />
      )}
      {(error ?? connectionError) !== null && <div className="error">{error ?? connectionError}</div>}
      <footer className="composer">
        <div className="composer-box">
          {selection !== null && (
            <SelectionQuote
              selection={{ ...selection, quote: selection.text }}
              copy={copy}
              label={copy.app.selectionChip}
              onRemove={dismissSelection}
            />
          )}
          {draftImages.length > 0 && (
            <div className="draft-images" aria-label={copy.app.addImages}>
              {draftImages.map((image) => {
                const name = image.name ?? copy.app.image
                return (
                  <span className="draft-image" key={image.id}>
                    <img src={draftImageDataUrl(image)} alt={name} />
                    <button
                      type="button"
                      disabled={busy || addingImages}
                      aria-label={copy.app.removeImage(name)}
                      title={copy.app.removeImage(name)}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        images: current.images.filter((item) => item.id !== image.id),
                      }))}
                    >×</button>
                  </span>
                )
              })}
            </div>
          )}
          {draftFiles.length > 0 && (
            <div className="draft-files" aria-label={locale === 'zh' ? '视频附件' : 'Video attachments'}>
              {draftFiles.map((file) => (
                <span className="draft-file" key={file.id} title={file.name}>
                  <span>{file.name}</span>
                  <button type="button"
                    aria-label={locale === 'zh' ? `移除 ${file.name}` : `Remove ${file.name}`}
                    onClick={() => setDraft((current) => ({
                      ...current,
                      files: current.files.filter((item) => item.id !== file.id),
                    }))}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => {
              if (!sendingRef.current) setDraft((current) => ({ ...current, text: e.target.value }))
            }}
            onPaste={(e) => {
              const files = clipboardMediaFiles(e.clipboardData)
              if (files.length > 0) void addAttachmentFiles(files)
            }}
            onKeyDown={(e) => {
              // isComposing：输入法组词中的回车是确认选字，不是发送。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={state === 'connected' ? copy.app.connectedPlaceholder : copy.app.disconnectedPlaceholder}
            disabled={!sessionReady || busy || goalDrafting}
            rows={2}
          />
          <div className="composer-actions">
            <span className="composer-actions-start">
              <input
                ref={fileInputRef}
                className="image-file-input"
                type="file"
                accept={`${imageLimits?.mediaTypes.join(',') ?? ''}${backend === 'codex' ? ',video/*' : ''}`}
                multiple
                tabIndex={-1}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  void addAttachmentFiles(files)
                }}
              />
              <button
                type="button"
                className="attachment-button"
                disabled={!sessionReady || busy || addingImages || imageLimits === null
                  || (backend === 'dsh' && draftImages.length >= imageLimits.maxImagesPerMessage)}
                aria-label={copy.app.addImages}
                title={imageLimits === null ? copy.app.imageUnavailable : copy.app.addImages}
                onClick={() => fileInputRef.current?.click()}
              ><AttachmentIcon /></button>
              <button type="button" className="recording-composer-button skill-extract-button"
                disabled={!sessionReady || busy || working || skillExtracting}
                aria-label={locale === 'zh' ? '生成技能' : 'Create skill'}
                title={locale === 'zh' ? '根据最近 10 分钟录制的操作生成技能' : 'Create a skill from recorded actions in the last 10 minutes'}
                onClick={() => { void extractSkillFromRecentActions() }}>
                <span>{skillExtracting ? (locale === 'zh' ? '生成中…' : 'Creating…') : (locale === 'zh' ? '生成技能' : 'Create skill')}</span>
              </button>
              <span>{copy.app.composerHelp}</span>
            </span>
            {working ? (
              <button
                className="stop-button"
                onClick={() => { void stopTurn() }}
                disabled={!sessionReady || stopping}
                aria-label={stopping ? copy.app.stoppingTurn : copy.app.stopTurn}
                title={stopping ? copy.app.stoppingTurn : copy.app.stopTurn}
              >
                <span className="stop-glyph" aria-hidden="true" />
              </button>
            ) : (
              <button onClick={() => void send()}
                disabled={!sessionReady || busy || goalDrafting || addingImages
                  || (input.trim() === '' && draftImages.length === 0 && draftFiles.length === 0 && selection === null)}
                aria-label={copy.app.sendMessage}><SendIcon /></button>
            )}
          </div>
        </div>
      </footer>
      </>}
      {workspaceMode === 'run' && <RunSkillsPanel skills={skills} locale={locale} canRun={sessionReady && !busy && !working}
        onUseManagedSkill={(skill: ManagedSkill) => {
          setDraft((current) => ({ ...current, text: `${current.text.trimEnd()}\n${locale === 'zh'
            ? `请先用 tandix_skill_read 读取网页助手技能「${skill.name}」，再按该技能协助我。`
            : `Read the Tandix skill "${skill.name}" with tandix_skill_read, then use it to help me.`}`.trim() }))
          setWorkspaceMode('chat')
        }}
        onRun={runSavedSkill} onDelete={removeSavedSkill} onImport={importSkillJson} />}
    </div>{approvalDialog}</>
  )
}
