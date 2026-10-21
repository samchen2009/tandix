import type { TeachState } from '../recording/state-machine.ts'

/** Reflect the real recorder state; processing uses the existing skill extraction flow. */
export function SkillCaptureButton({ recording, processing, disabled, locale, onExtract }: {
  recording: TeachState
  processing: boolean
  disabled: boolean
  locale: 'zh' | 'en'
  onExtract: () => void
}): React.JSX.Element {
  const active = recording.phase === 'recording'
  const state = processing ? 'processing' : active ? 'recording' : 'idle'
  const label = processing ? (locale === 'zh' ? '正在生成技能' : 'Creating skill')
    : active ? (locale === 'zh' ? '生成技能（正在记录）' : 'Create skill (recording)')
      : (locale === 'zh' ? '生成技能' : 'Create skill')
  const hint = processing ? (locale === 'zh' ? '正在整理操作并生成技能草案…' : 'Turning recorded actions into a skill draft…')
    : active ? (locale === 'zh' ? '正在记录网页操作 · 点击生成技能' : 'Recording page actions · click to create a skill')
      : (locale === 'zh' ? '录制未进行 · 点击提炼最近 10 分钟的操作' : 'Recording is not active · create a skill from the last 10 minutes')
  return <button type="button" className="skill-capture-trigger" data-state={state}
    aria-label={label} aria-busy={processing} title={hint} disabled={disabled || processing} onClick={onExtract}>
    {processing ? <svg className="capture-processing" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="capture-orbit" cx="12" cy="12" r="8" />
      <path d="m12 7 1.5 3.5L17 12l-3.5 1.5L12 17l-1.5-3.5L7 12l3.5-1.5L12 7Z" />
    </svg> : <span className="capture-recorder" aria-hidden="true">
      <span className="capture-rec-ring" /><span className="capture-rec-core" />
    </span>}
    {!processing && <span className="capture-rec-label" aria-hidden="true">REC</span>}
    <span className="sr-only" role="status">{processing ? label : ''}</span>
  </button>
}
