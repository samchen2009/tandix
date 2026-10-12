import { useCallback, useEffect, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { AGENT_SKILL_SCHEMA_VERSION, type ChatActionCandidate, type ChatSkill } from '../skill/chat-skill.ts'
import { createSkillArchive } from '../skill/skill-archive.ts'
import { loadManagedSkills, MANAGED_SKILLS_STORAGE_KEY, type ManagedSkill } from '../skill/managed-skill.ts'

export function ChatSkillBuilder({ candidates, sourceSessionId, goalSuggestion, locale, onCancel, onExtract }: {
  candidates: ChatActionCandidate[]
  sourceSessionId: string
  goalSuggestion: string
  locale: UiLocale
  onCancel: () => void
  onExtract: (skill: ChatSkill) => Promise<void>
}): React.JSX.Element {
  const zh = locale === 'zh'
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [goal, setGoal] = useState(goalSuggestion)
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(id: string): void {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const chosen = candidates.filter((candidate) => selected.has(candidate.id))
    if (chosen.length === 0 || name.trim() === '' || goal.trim() === '') {
      setError(zh ? '请填写名称和目标，并至少选择一步操作。' : 'Enter a name and goal, and select at least one action.')
      return
    }
    const unreviewed = chosen.find((candidate) => candidate.requiresReview
      && (edits[candidate.id] ?? candidate.suggestedStep).trim() === candidate.suggestedStep)
    if (unreviewed !== undefined) {
      setError(zh
        ? '请把所选点击、输入或含隐藏参数的步骤改成可识别的目标说明。旧页面编号不能直接重放。'
        : 'Describe selected click, input, or redacted-URL steps in your own words. Old page indices cannot be replayed.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onExtract({
        schemaVersion: AGENT_SKILL_SCHEMA_VERSION,
        version: 1,
        id: crypto.randomUUID(),
        name: name.trim().slice(0, 100),
        goal: goal.trim().slice(0, 1_000),
        success: success.trim().slice(0, 1_000),
        steps: chosen.map((candidate) => (edits[candidate.id] ?? candidate.suggestedStep).trim().slice(0, 1_000)),
        parameters: chosen.flatMap((candidate) => candidate.parameter === undefined ? [] : [candidate.parameter]),
        allowedOrigins: [],
        sourceSessionId,
        createdAt: Date.now(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="chat-skill-workspace">
      <div className="chat-skill-heading">
        <div>
          <span className="eyebrow">{zh ? 'CHAT → RUN' : 'CHAT → RUN'}</span>
          <h1>{zh ? '提炼浏览器技能' : 'Create a browser skill'}</h1>
          <p>{zh ? '选取聊天或录制中的操作，补全目标；AI 会起草技能，需要澄清时提问，最后由你确认保存。' : 'Choose chat or recorded actions. AI drafts the skill, asks when clarification is needed, and saves only after your confirmation.'}</p>
        </div>
        <button className="secondary" type="button" onClick={onCancel}>{zh ? '返回聊天' : 'Back to chat'}</button>
      </div>
      <form onSubmit={(event) => { void submit(event) }}>
        <label className="chat-skill-field">
          <span>{zh ? '技能名称' : 'Skill name'}</span>
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={zh ? '例如：查询反馈并打开详情' : 'e.g. Find feedback and open details'} />
        </label>
        <label className="chat-skill-field">
          <span>{zh ? '目标' : 'Goal'}</span>
          <textarea value={goal} maxLength={1_000} rows={2} onChange={(event) => setGoal(event.target.value)} />
        </label>
        <div className="chat-skill-list-heading">
          <strong>{zh ? `选取操作（${selected.size}/${candidates.length}）` : `Select actions (${selected.size}/${candidates.length})`}</strong>
          <button className="secondary" type="button" onClick={() => setSelected(new Set(candidates.map((candidate) => candidate.id)))}>{zh ? '全选' : 'Select all'}</button>
        </div>
        {candidates.length === 0 ? (
          <p className="chat-skill-note">{zh ? '当前没有可提炼的操作。网页助手会自动保留最近 10 分钟的页面操作，请先完成一次网页流程。' : 'No actions found. Tandix automatically keeps the last 10 minutes of page activity; complete a browser workflow first.'}</p>
        ) : (
          <ol className="chat-skill-actions">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <label className="chat-skill-choice">
                  <input type="checkbox" checked={selected.has(candidate.id)} onChange={() => toggle(candidate.id)} />
                  <span>{candidate.label}</span>
                  {candidate.requiresReview && <small>{zh ? '需确认目标' : 'Review target'}</small>}
                </label>
                {selected.has(candidate.id) && (
                  <input className="chat-skill-step-input" value={edits[candidate.id] ?? candidate.suggestedStep}
                    maxLength={1_000} aria-label={`${candidate.label} ${zh ? '步骤说明' : 'step description'}`}
                    onChange={(event) => setEdits((current) => ({ ...current, [candidate.id]: event.target.value }))} />
                )}
              </li>
            ))}
          </ol>
        )}
        <label className="chat-skill-field">
          <span>{zh ? '成功条件' : 'Success condition'}</span>
          <textarea value={success} maxLength={1_000} rows={2} onChange={(event) => setSuccess(event.target.value)}
            placeholder={zh ? '例如：详情页显示目标记录，且状态为已处理' : 'e.g. The detail page shows the target record as resolved'} />
        </label>
        <p className="chat-skill-note">{zh ? '输入文字不会从聊天中保存；运行时再填参数。页面索引只作参考，Agent 会重新读取页面。' : 'Typed values are not saved from chat. Enter them at run time. The agent will re-read the page instead of reusing old indices.'}</p>
        {error !== null && <p className="chat-skill-error" role="alert">{error}</p>}
        <div className="chat-skill-actions-footer">
          <button className="primary" type="submit" disabled={busy || candidates.length === 0}>{busy ? (zh ? '提交中…' : 'Submitting…') : (zh ? '让 AI 提炼' : 'Extract with AI')}</button>
        </div>
      </form>
    </main>
  )
}

export function RunSkillsPanel({ skills, locale, canRun, onRun, onDelete, onImport,
  onUseManagedSkill }: {
  skills: ChatSkill[]
  locale: UiLocale
  canRun: boolean
  onRun: (skill: ChatSkill, values: Record<string, string>) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onImport: (text: string) => Promise<void>
  onUseManagedSkill?: (skill: ManagedSkill) => void
}): React.JSX.Element {
  const zh = locale === 'zh'
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [managedSkills, setManagedSkills] = useState<ManagedSkill[]>([])
  const [managedError, setManagedError] = useState<string | null>(null)
  const refreshManagedSkills = useCallback(async (): Promise<void> => {
    try { setManagedSkills(await loadManagedSkills()); setManagedError(null) }
    catch (cause) { setManagedError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  useEffect(() => {
    void refreshManagedSkills()
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName === 'local' && changes[MANAGED_SKILLS_STORAGE_KEY] !== undefined) void refreshManagedSkills()
    }
    chrome.storage.onChanged?.addListener(onStorageChanged)
    return () => { chrome.storage.onChanged?.removeListener(onStorageChanged) }
  }, [refreshManagedSkills])
  const entries: Array<{ key: string; kind: 'managed'; skill: ManagedSkill }
    | { key: string; kind: 'browser'; skill: ChatSkill }> = [
    ...managedSkills.map((skill) => ({ key: `managed:${skill.id}` as const, kind: 'managed' as const, skill })),
    ...skills.map((skill) => ({ key: `browser:${skill.id}` as const, kind: 'browser' as const, skill })),
  ]
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = normalizedQuery === '' ? entries : entries.filter((entry) =>
    (entry.kind === 'managed'
      ? [entry.skill.name, entry.skill.description, entry.skill.instructions]
      : [entry.skill.name, entry.skill.goal, ...entry.skill.steps]
    ).some((text) => text.toLocaleLowerCase().includes(normalizedQuery)))
  const selected = filteredEntries.find((entry) => entry.key === selectedKey) ?? filteredEntries[0]
  const active = selected?.kind === 'browser' ? selected.skill : undefined
  async function importFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setError(null)
    try { await onImport(await file.text()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function run(): Promise<void> {
    if (active === undefined || busy || !canRun) return
    const missing = active.parameters.find((parameter) => parameter.required && parameter.type !== 'boolean'
      && (values[parameter.name] ?? (parameter.defaultValue === undefined ? '' : String(parameter.defaultValue))).trim() === '')
    if (missing !== undefined) {
      setError(zh ? `请填写「${missing.label}」。` : `Enter "${missing.label}".`)
      return
    }
    setBusy(true)
    setError(null)
    try { await onRun(active, values) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  async function remove(): Promise<void> {
    if (active === undefined || busy) return
    if (!window.confirm(zh ? `删除技能「${active.name}」？` : `Delete skill "${active.name}"?`)) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(active.id)
      setSelectedKey(null)
      setValues({})
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  function downloadSkill(): void {
    if (active === undefined) return
    setError(null)
    try {
      const archive = createSkillArchive(active)
      const buffer = new ArrayBuffer(archive.bytes.length)
      new Uint8Array(buffer).set(archive.bytes)
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = archive.filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return (
    <main className="chat-skill-workspace run-skills-workspace">
      <div className="chat-skill-heading">
        <div>
          <span className="eyebrow">{zh ? '网页助手 · 运行' : 'TANDIX · RUN'}</span>
          <h1>{zh ? '我的技能' : 'My skills'}</h1>
          <p>{zh ? '网页助手技能在聊天中使用；浏览器技能可直接运行、下载或导入。' : 'Use Tandix skills in Chat; browser skills can be run, downloaded, or imported here.'}</p>
        </div>
      </div>
      <label className="run-skill-import">{zh ? '导入 CLI 生成的技能 JSON' : 'Import a CLI-generated skill JSON'}
        <input type="file" accept=".json,application/json" onChange={(event) => { void importFile(event) }} />
      </label>
      {managedError !== null && <p className="chat-skill-error" role="alert">{managedError}</p>}
      {error !== null && <p className="chat-skill-error" role="alert">{error}</p>}
      {entries.length === 0 ? <p className="chat-skill-note">{zh ? '还没有技能。可以在聊天中让 Agent 保存技能，或从浏览器操作中提炼技能。' : 'No skills yet. Ask the agent to save one in Chat, or create one from browser actions.'}</p> : (
        <div className="run-skills-layout">
          <section className="run-skills-browser" aria-label={zh ? '技能列表' : 'Skill list'}>
            <div className="run-skills-browser-heading">
              <strong>{zh ? '技能列表' : 'Skills'}</strong>
              <div className="run-skills-list-controls"><span>{filteredEntries.length}/{entries.length}</span>
                <button type="button" className="secondary" onClick={() => { void refreshManagedSkills() }}>{zh ? '刷新' : 'Refresh'}</button></div>
            </div>
            <label className="run-skills-search">
              <span className="sr-only">{zh ? '搜索技能' : 'Search skills'}</span>
              <input type="search" value={query}
                placeholder={zh ? '搜索名称、用途或步骤' : 'Search name, purpose, or steps'}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSelectedKey(null)
                  setValues({})
                  setError(null)
                }} />
            </label>
            {filteredEntries.length === 0
              ? <p className="run-skills-empty">{zh ? '没有匹配的技能' : 'No matching skills'}</p>
              : <div className="run-skills-list" role="listbox" aria-label={zh ? '技能列表' : 'Skill list'}>
                {filteredEntries.map((entry) => <button key={entry.key} type="button" role="option"
                  aria-selected={selected?.key === entry.key} className={selected?.key === entry.key ? 'selected' : ''}
                  onClick={() => { setSelectedKey(entry.key); setValues({}); setError(null) }}>
                  <span className="run-skill-list-copy">
                    <strong>{entry.skill.name}</strong>
                    <small>{entry.kind === 'managed' ? entry.skill.description : entry.skill.goal}</small>
                  </span>
                  <span className="run-skill-list-meta">{entry.kind === 'managed'
                    ? (zh ? '网页助手' : 'Tandix') : `${entry.skill.steps.length} ${zh ? '步' : 'steps'}`}</span>
                </button>)}
              </div>}
          </section>
          {selected?.kind === 'managed' && <section className="run-skill-detail" aria-label={zh ? '技能详情' : 'Skill details'}>
            <h2>{selected.skill.name}</h2>
            <p>{selected.skill.description}</p>
            <p className="chat-skill-note">{zh ? '网页助手技能 · 在聊天中使用' : 'Tandix skill · use in Chat'}</p>
            <pre className="managed-skill-instructions">{selected.skill.instructions}</pre>
            <div className="chat-skill-actions-footer">
              <button type="button" className="primary" disabled={onUseManagedSkill === undefined}
                onClick={() => onUseManagedSkill?.(selected.skill)}>{zh ? '在聊天中使用' : 'Use in Chat'}</button>
            </div>
          </section>}
          {active !== undefined && <section className="run-skill-detail">
            <h2>{active.name}</h2>
            <p>{active.goal}</p>
            {active.startUrl !== undefined && <p className="chat-skill-note"><strong>{zh ? '入口页面：' : 'Start page: '}</strong>{active.startUrl}</p>}
            <p className="chat-skill-note"><strong>{zh ? '桌面 Agent 版本：' : 'Desktop Agent version: '}</strong>{active.desktopAdapter === undefined
              ? (zh ? '未提供已审核的 API/CLI 契约；下载包仅支持在网页助手的浏览器模式下执行。' : 'No reviewed API/CLI contract; the downloadable package supports Tandix browser execution only.')
              : (zh ? `可下载；包含 ${active.desktopAdapter.requests.length} 个已审核 HTTP 请求及 scripts/run.mjs，运行时不依赖网页助手扩展。` : `Downloadable. It includes ${active.desktopAdapter.requests.length} reviewed HTTP request(s) and scripts/run.mjs and does not depend on the Tandix browser extension at run time.`)}</p>
            <ol>{active.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
            {active.success !== '' && <p><strong>{zh ? '成功条件：' : 'Success: '}</strong>{active.success}</p>}
            {active.parameters.map((parameter) => <label className="chat-skill-field" key={parameter.name}>
              <span>{parameter.label}</span>
              {parameter.type === 'boolean' ? <input type="checkbox"
                checked={(values[parameter.name] ?? String(parameter.defaultValue ?? false)) === 'true'}
                onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: String(event.target.checked) }))} />
                : <input type={parameter.type === 'secret' ? 'password' : parameter.type === 'number' ? 'number' : 'text'}
                  autoComplete="off" value={values[parameter.name] ?? (parameter.defaultValue === undefined ? '' : String(parameter.defaultValue))}
                  onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: event.target.value }))} />}
            </label>)}
            <p className="chat-skill-note">{zh ? '参数不会保存在技能中，但会发给当前 Agent，可能留在聊天历史。浏览器敏感操作仍需要确认。' : 'Inputs are not stored in the skill, but are sent to the current agent and may remain in chat history. Sensitive browser actions still require approval.'}</p>
            {error !== null && <p className="chat-skill-error" role="alert">{error}</p>}
            <div className="chat-skill-actions-footer">
              <button className="primary" type="button" disabled={!canRun || busy} onClick={() => { void run() }}>{zh ? '运行技能' : 'Run skill'}</button>
              <button className="secondary download-desktop-skill" type="button" disabled={busy}
                title={active.desktopAdapter === undefined
                  ? (zh ? '下载浏览器版技能包' : 'Download browser-only skill package')
                  : (zh ? '下载不依赖浏览器的桌面 Agent 版本' : 'Download the browser-independent Desktop Agent version')}
                onClick={downloadSkill}>{zh ? '下载技能' : 'Download skill'}</button>
              <button className="secondary" type="button" disabled={busy} onClick={() => { void remove() }}>{zh ? '删除技能' : 'Delete skill'}</button>
            </div>
          </section>}
        </div>
      )}
    </main>
  )
}
