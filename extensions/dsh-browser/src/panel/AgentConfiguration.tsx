import { useEffect, useRef, useState } from 'react'
import type { AgentBackend } from '../agent-backend.ts'
import type { PanelApi } from './api.ts'

export interface AgentConfigurationSnapshot {
  backend: AgentBackend
  sessionId: string | null
  source: 'session' | 'default' | 'last-known' | 'unavailable' | 'next-turn'
  modelId: string | null
  modelLabel: string | null
  provider?: string | null
  reasoningEffortId?: string | null
  reasoningEffort?: string | null
  mode?: string | null
  approvalPolicy?: string | null
  sandbox?: string | null
  lastUsed?: string | null
}
interface ModelChoice { id: string; label: string; provider?: string; efforts: string[]; defaultEffort?: string | null }
const modelKey = (model: ModelChoice): string => JSON.stringify([model.provider ?? '', model.id])
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null

export function dshConfiguration(sessionId: string | null, selection: unknown, settings: unknown): AgentConfigurationSnapshot {
  const namespaces = record(settings) && Array.isArray(settings.namespaces) ? settings.namespaces : []
  const defaults: unknown = namespaces.find(item => record(item) && item.ns === 'agent-default-model')?.value
  const next = record(selection) && record(selection.next) ? selection.next : null
  const chosen = next ?? (record(defaults) ? defaults : {})
  return { backend: 'dsh', sessionId, source: next ? 'session' : text(chosen.model) ? 'default' : 'unavailable',
    modelId: text(chosen.model), modelLabel: text(chosen.model), provider: text(chosen.provider),
    reasoningEffort: text(chosen.reasoningEffort),
    lastUsed: record(selection) && record(selection.lastUsed) ? text(selection.lastUsed.model) : null }
}

/** Session-scoped model settings; changing a selection never changes global defaults. */
export function AgentConfiguration({ api, backend, sessionId, connected, working, selection, revision, locale, onBusyChange, onModelSelected, onConfigure, embedded = false }: {
  api: PanelApi; backend: AgentBackend; sessionId: string | null; connected: boolean; working: boolean
  selection: unknown; revision: number; locale: 'zh' | 'en'
  embedded?: boolean
  onConfigure?: () => void
  onBusyChange?: (busy: boolean) => void
  onModelSelected?: (selected: { provider?: string; model: string; reasoningEffort?: string }) => void
}): React.JSX.Element {
  const zh = locale === 'zh'
  const [open, setOpen] = useState(false)
  const expanded = embedded || open
  const [snapshot, setSnapshot] = useState<AgentConfigurationSnapshot | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [draftModel, setDraftModel] = useState('')
  const [draftEffort, setDraftEffort] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const savingRef = useRef(false)
  const scope = useRef({ backend, sessionId, connected })
  scope.current = { backend, sessionId, connected }
  const trigger = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setSnapshot(null); setFailure(null)
    if (!connected) return
    let cancelled = false
    void (async () => {
      const result = backend === 'dsh'
        ? dshConfiguration(sessionId, selection, await api.rpc('settings.describe', {}))
        : await api.rpc<AgentConfigurationSnapshot>('agent.configuration', { sessionId })
      if (!cancelled) {
        if (!result || result.backend !== backend || result.sessionId !== sessionId) throw new Error(zh ? '配置响应与当前会话不匹配' : 'Configuration belongs to a different session')
        setSnapshot(result)
      }
    })().catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [api, backend, sessionId, connected, working, selection, refresh, revision, zh])
  useEffect(() => {
    setOpen(false); setSaveError(null)
  }, [backend, sessionId, connected])
  useEffect(() => {
    if (!open || embedded) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open, embedded])
  useEffect(() => {
    setModels([]); setCatalogError(null); setSaved(false); setDraftModel(''); setDraftEffort('')
    if (!expanded || !connected || !sessionId) { setCatalogLoading(false); return }
    let cancelled = false
    setCatalogLoading(true)
    void (async () => {
      const result = await api.rpc<unknown>(backend === 'dsh' ? 'session.modelCatalog' : 'agent.models', { sessionId })
      const choices: ModelChoice[] = []
      if (backend === 'dsh' && record(result) && Array.isArray(result.groups)) {
        for (const group of result.groups) {
          if (!record(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) continue
          if (Array.isArray(result.routableProviders) && !result.routableProviders.includes(group.id)) continue
          for (const model of group.models) {
            if (!record(model) || !text(model.id)) continue
            const reasoning = record(model.reasoning) ? model.reasoning : {}
            choices.push({ id: String(model.id), label: text(model.name) ?? String(model.id), provider: group.id,
              efforts: Array.isArray(reasoning.efforts) ? reasoning.efforts.filter(record).map(item => text(item.id)).filter((item): item is string => item !== null) : [],
              defaultEffort: text(reasoning.defaultEffort) })
          }
        }
      } else if (record(result) && Array.isArray(result.models)) {
        for (const model of result.models) {
          if (!record(model) || !text(model.id)) continue
          choices.push({ id: String(model.id), label: text(model.label) ?? String(model.id),
            efforts: Array.isArray(model.efforts) ? model.efforts.filter((item): item is string => typeof item === 'string') : [], defaultEffort: text(model.defaultEffort) })
        }
      }
      if (!cancelled) setModels(choices)
    })().catch(error => { if (!cancelled) setCatalogError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setCatalogLoading(false) })
    return () => { cancelled = true }
  }, [api, backend, sessionId, connected, expanded, refresh])
  useEffect(() => {
    const current = models.find(model => model.id === snapshot?.modelId && (!model.provider || model.provider === snapshot.provider))
    setDraftModel(current ? modelKey(current) : '')
    const effort = snapshot?.reasoningEffortId ?? snapshot?.reasoningEffort ?? ''
    setDraftEffort(current?.efforts.includes(effort) ? effort : current?.defaultEffort ?? '')
  }, [models, snapshot])
  async function saveModel(): Promise<void> {
    const chosen = models.find(model => modelKey(model) === draftModel)
    if (!chosen || !sessionId || !connected || working || savingRef.current) return
    const owner = { backend, sessionId }
    const stillCurrent = (): boolean => scope.current.connected && scope.current.backend === owner.backend && scope.current.sessionId === owner.sessionId
    savingRef.current = true; setSaving(true); setSaveError(null); setSaved(false); onBusyChange?.(true)
    try {
      const selected = { model: chosen.id, ...(chosen.provider ? { provider: chosen.provider } : {}), ...(draftEffort ? { reasoningEffort: draftEffort } : {}) }
      const result = await api.rpc<unknown>(backend === 'dsh' ? 'session.selectModel' : 'agent.configuration.set', { sessionId, ...selected })
      if (!stillCurrent()) return
      if (backend === 'dsh') {
        if (!record(result) || !record(result.selected) || result.selected.model !== selected.model || result.selected.provider !== selected.provider) throw new Error(zh ? '运行时未确认模型设置' : 'The runtime did not confirm the selection')
        setSnapshot({ backend, sessionId, source: 'next-turn', modelId: chosen.id, modelLabel: chosen.label, provider: chosen.provider, reasoningEffort: draftEffort || null })
        onModelSelected?.(selected)
      } else {
        if (!record(result) || result.saved !== true || result.backend !== backend || result.sessionId !== sessionId || result.modelId !== chosen.id) throw new Error(zh ? '运行时未确认模型设置' : 'The runtime did not confirm the selection')
        setSnapshot(result as unknown as AgentConfigurationSnapshot)
      }
      setSaved(true)
    } catch (error) {
      if (stillCurrent()) { setSaveError(error instanceof Error ? error.message : String(error)); setRefresh(value => value + 1) }
    } finally { savingRef.current = false; setSaving(false); onBusyChange?.(false) }
  }
  const current = connected && snapshot !== null && snapshot.backend === backend && snapshot.sessionId === sessionId ? snapshot : null
  const label = current?.modelLabel ?? (failure || (current !== null && !current.modelLabel) ? (zh ? '配置未提供' : 'Unavailable') : connected ? (zh ? '读取配置…' : 'Reading…') : (zh ? '未连接' : 'Offline'))
  const chosenModel = models.find(model => modelKey(model) === draftModel)
  const source = current?.source === 'next-turn' ? (zh ? '已设置 · 下条消息生效' : 'Saved · next message') : current?.source === 'session' ? (zh ? '当前会话' : 'This session')
    : current?.source === 'default' ? (zh ? '默认配置' : 'Default settings')
      : current?.source === 'last-known' ? (zh ? '历史配置 · 待连接确认' : 'Last known · not live') : (zh ? '运行时未提供' : 'Not provided by runtime')
  const display = (value: string | null | undefined): string | null | undefined => {
    if (!zh || !value) return value
    const names: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '很高', minimal: '最低', max: '最高',
      'on-request': '按需确认', 'on-failure': '失败时确认', untrusted: '不受信任时确认', never: '不请求确认',
      workspaceWrite: '工作区可写', 'workspace-write': '工作区可写', readOnly: '只读', 'read-only': '只读', dangerFullAccess: '完整访问',
      'danger-full-access': '完整访问', agent: '执行', plan: '规划', ask: '问答' }
    return names[value] ?? value
  }
  const fields = [[zh ? '模型' : 'Model', current?.modelLabel], [zh ? '供应商' : 'Provider', current?.provider],
    [zh ? '推理强度' : 'Reasoning', current?.reasoningEffort], [zh ? '运行模式' : 'Mode', current?.mode],
    [zh ? '工具审批' : 'Tool approval', current?.approvalPolicy], [zh ? '沙箱' : 'Sandbox', current?.sandbox],
    [zh ? '上次使用' : 'Last used', current?.lastUsed]].filter(([, value]) => value)
  return <div className={`agent-configuration${embedded ? ' model-settings-inline' : ''}`} ref={container}>
    {!embedded && <button className="model-trigger" type="button" ref={trigger} aria-expanded={open}
      aria-label={zh ? '查看模型与配置' : 'View model and settings'} title={`${label} · ${source}`}
      onClick={() => setOpen(value => !value)}>
      <svg className="model-spark" viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" /></svg><span className="model-name">{label}</span>
      {current?.reasoningEffort && <small>{display(current.reasoningEffort)}</small>}<span className="model-chevron" aria-hidden="true">⌄</span>
    </button>}
    {expanded && <section className={embedded ? 'model-settings-panel' : 'agent-config-popover'} aria-label={zh ? (embedded ? '模型设置' : '模型与配置') : (embedded ? 'Model settings' : 'Model and settings')}>
      <div className="config-heading"><strong>{zh ? (embedded ? '模型设置' : '模型与配置') : (embedded ? 'Model settings' : 'Model and settings')}</strong>
        <div className="config-heading-actions">{!embedded && onConfigure && <button type="button" className="configure-model-button" disabled={saving} onClick={() => { setOpen(false); onConfigure() }}>{zh ? '设置模型' : 'Model settings'}</button>}
          <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={!connected || saving}>{zh ? '刷新' : 'Refresh'}</button></div></div>
      <span className="config-source">{source}</span>
      {embedded && !connected && <p role="status">{zh ? 'Agent 正在连接，连接完成后可设置模型。' : 'Connect the agent to edit model settings.'}</p>}
      {embedded && connected && !sessionId && <p role="status">{zh ? '正在准备对话，稍后即可设置模型。' : 'Preparing the chat for model settings…'}</p>}
      {catalogLoading && <p role="status">{zh ? '正在读取可用模型…' : 'Loading available models…'}</p>}
      {!catalogLoading && models.length > 0 && <div className="model-settings-form">
        <label>{zh ? '模型' : 'Model'}<select aria-label={zh ? '设置模型' : 'Set model'} value={draftModel} disabled={working || saving}
          onChange={event => {
            const model = models.find(item => modelKey(item) === event.target.value)
            setDraftModel(event.target.value); setDraftEffort(model?.efforts.includes(draftEffort) ? draftEffort : model?.defaultEffort ?? ''); setSaved(false)
          }}>
          <option value="" disabled>{zh ? '选择模型' : 'Choose a model'}</option>
          {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.provider ? `${model.provider} · ` : ''}{model.label}</option>)}
        </select></label>
        {(chosenModel?.efforts.length ?? 0) > 0 && <label>{zh ? '推理强度' : 'Reasoning effort'}<select aria-label={zh ? '设置推理强度' : 'Set reasoning effort'} value={draftEffort}
          disabled={working || saving} onChange={event => { setDraftEffort(event.target.value); setSaved(false) }}>
          <option value="">{zh ? '运行时默认' : 'Runtime default'}</option>
          {chosenModel?.efforts.map(effort => <option key={effort} value={effort}>{display(effort)}</option>)}
        </select></label>}
        <button type="button" className="model-settings-save" disabled={!chosenModel || working || saving} onClick={() => { void saveModel() }}>{saving ? (zh ? '正在应用…' : 'Applying…') : (zh ? '应用到此对话' : 'Apply to this chat')}</button>
        {working && <p>{zh ? '请先停止当前任务，再修改模型。' : 'Stop the current task before changing models.'}</p>}
        {saved && <p className="model-save-success" role="status">{zh ? '已设置，从下一条消息生效。' : 'Saved. Applies from the next message.'}</p>}
      </div>}
      {!catalogLoading && !models.length && connected && <p>{catalogError ? (zh ? '暂时无法加载模型选项，请刷新或更新伴随程序。' : 'Could not load model options. Refresh or update the companion.') : (zh ? '此运行时未提供可设置的模型选项。' : 'This runtime does not provide editable model options.')}</p>}
      {saveError && <p className="model-save-error" role="alert">{saveError}</p>}
      {fields.length > 0 && <dl>{fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{display(value)}</dd></div>)}</dl>}
      {failure && <p role="status">{zh ? '暂时无法读取。请检查连接，或更新本机伴随程序后重试。' : 'Could not read settings. Check the connection or update the local companion.'}</p>}
      {!failure && current?.source === 'unavailable' && <p>{zh ? '此运行时尚未返回模型信息。' : 'This runtime has not returned model information.'}</p>}
      {(current?.modelLabel === 'auto' || current?.modelId === 'default') && <p>{zh ? '自动选择由运行时决定，实际调用的模型可能不会返回。' : 'The runtime selects the model automatically and may not report the model used.'}</p>}
      <p className="config-footnote">{zh ? '仅作用于此 Tandix 对话，全局默认配置保持不变。' : 'Applies to this Tandix chat. Global defaults stay unchanged.'}</p>
    </section>}
  </div>
}
