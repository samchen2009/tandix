import { useEffect, useMemo, useState } from 'react'
import type { TeachState } from '../recording/state-machine.ts'
import type { PanelApi } from './api.ts'

const IDLE: TeachState = { phase: 'idle' }

function download(filename: string, mimeType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export function TeachPanel({ api, locale }: { api: PanelApi; locale: 'zh' | 'en' }): React.JSX.Element {
  const [state, setState] = useState<TeachState>(IDLE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const zh = locale === 'zh'

  useEffect(() => {
    const off = api.onRecordingState(setState)
    void api.getRecordingState().then(setState).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return off
  }, [api])

  const recording = state.phase === 'recording' || state.phase === 'arming' || state.phase === 'stopping'
  const duration = useMemo(() => {
    const milliseconds = state.summary?.durationMs ?? 0
    return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`
  }, [state.summary?.durationMs])

  async function toggle(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setState(recording ? await api.stopRecording() : await api.startRecording())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function exportAs(format: 'json' | 'jsonl'): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await api.exportRecording(state.recordingId, format)
      download(result.filename, result.mimeType, result.content)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="traceforge-workspace teach-workspace">
      <section className="teach-hero">
        <div>
          <span className="eyebrow">{zh ? '网页助手 · 示教' : 'TANDIX · TEACH'}</span>
          <h1>{zh ? '演示一次，沉淀为可靠任务' : 'Demonstrate once. Reuse reliably.'}</h1>
          <p>Turn browser traces into reliable agent tasks.</p>
        </div>
        <span className={`recording-pill ${recording ? 'active' : ''}`} role="status">
          <i aria-hidden="true" />
          {recording ? (zh ? '正在录制' : 'Recording') : (zh ? '未录制' : 'Not recording')}
        </span>
      </section>

      <section className="teach-card">
        <h2>{zh ? '浏览器示教' : 'Browser teaching'}</h2>
        <p>{zh
          ? '网页助手会记录点击、输入、选择、提交、按键、导航与标签页变化。密码和支付字段在页面内即被替换为参数占位符。'
          : 'Tandix records clicks, fields, selects, submits, keys, navigation, and tab changes. Password and payment fields become parameter placeholders before leaving the page.'}</p>
        <button className={recording ? 'record-button stop' : 'record-button'} disabled={busy} onClick={() => { void toggle() }}>
          <span aria-hidden="true" />
          {recording ? (zh ? '停止录制' : 'Stop recording') : (zh ? '开始录制' : 'Start recording')}
        </button>
        {error !== null && <p className="teach-error">{error}</p>}
      </section>

      {state.summary !== undefined && (
        <section className="teach-card recording-summary">
          <div className="summary-heading">
            <div>
              <span className="eyebrow">{zh ? '录制摘要' : 'RECORDING SUMMARY'}</span>
              <h2>{state.title ?? (zh ? '浏览器录制' : 'Browser recording')}</h2>
            </div>
            <span className="summary-state">{state.phase === 'recorded' ? (zh ? '已停止' : 'Stopped') : (zh ? '进行中' : 'Live')}</span>
          </div>
          <dl className="summary-grid">
            <div><dt>{zh ? '事件' : 'Events'}</dt><dd>{state.summary.eventCount}</dd></div>
            <div><dt>{zh ? '标签页' : 'Tabs'}</dt><dd>{state.summary.tabCount}</dd></div>
            <div><dt>{zh ? '导航' : 'Navigations'}</dt><dd>{state.summary.navigationCount}</dd></div>
            <div><dt>{zh ? '时长' : 'Duration'}</dt><dd>{duration}</dd></div>
          </dl>
          <div className="event-chips">
            {Object.entries(state.summary.eventTypes).map(([kind, count]) => <span key={kind}>{kind} · {count}</span>)}
            {state.summary.sensitiveEventCount > 0 && <span className="safe-chip">{zh ? '已脱敏' : 'Redacted'} · {state.summary.sensitiveEventCount}</span>}
          </div>
          {state.phase === 'recorded' && (
            <div className="export-actions">
              <button disabled={busy} onClick={() => { void exportAs('json') }}>{zh ? '导出 JSON' : 'Export JSON'}</button>
              <button disabled={busy} onClick={() => { void exportAs('jsonl') }}>{zh ? '导出 JSONL' : 'Export JSONL'}</button>
            </div>
          )}
        </section>
      )}
    </main>
  )
}

export function PlaceholderWorkspace({ mode, locale }: { mode: 'clarify' | 'run'; locale: 'zh' | 'en' }): React.JSX.Element {
  const zh = locale === 'zh'
  return (
    <main className="traceforge-workspace placeholder-workspace">
      <span className="eyebrow">{zh ? `网页助手 · ${mode.toUpperCase()}` : `TANDIX · ${mode.toUpperCase()}`}</span>
      <h1>{mode === 'clarify'
        ? (zh ? '澄清任务参数与成功条件' : 'Clarify parameters and success criteria')
        : (zh ? '运行已验证的任务' : 'Run a verified task')}</h1>
      <p>{mode === 'clarify'
        ? (zh ? '下一阶段将由 DSH Teach Plugin 把录制轨迹编译为 TaskSpec，并在这里确认变量、秘密值与断言。' : 'The next phase compiles the trace into a TaskSpec with the DSH Teach Plugin, then confirms variables, secrets, and assertions here.')
        : (zh ? '下一阶段将提供确定性执行、逐步验证以及失败后的 Agent Repair。' : 'The next phase adds deterministic execution, step verification, and Agent Repair on failure.')}</p>
    </main>
  )
}
