import type { UiLocale } from '../i18n.ts'
import type { RecordingEventInput, RecordingTarget } from './schema.ts'

type Step = {
  text: string
  kind: 'input' | 'click' | 'other'
  selector?: string
  capturedAt?: number
  outcomes?: string[]
  href?: string
  hrefHasHiddenQuery?: boolean
}
type NetworkCategory = 'search' | 'playback' | 'other'

function targetLabel(target: RecordingTarget): string {
  const label = target.name || target.text || target.selector
  return label.replace(/\s+/g, ' ').trim().slice(0, 100)
}

function controlLabel(target: RecordingTarget, zh: boolean): string {
  if (target.download) return zh ? '下载链接' : 'download link'
  const labels = zh
    ? { button: '按钮', link: '链接', input: '输入框', select: '选择框', custom: '可点击区域', other: '控件' }
    : { button: 'button', link: 'link', input: 'input', select: 'select', custom: 'clickable area', other: 'control' }
  return labels[target.control ?? 'other']
}

function displayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function networkCategory(raw: string): NetworkCategory | null {
  try {
    const url = new URL(raw)
    const path = url.pathname.toLowerCase()
    const host = url.hostname.toLowerCase()
    // Raw telemetry, ads and CDN fragments remain in Teach, not the chat draft.
    if (/\.(?:ts|m3u8|mp4|m4s|f4v|br|z)(?:$|\/)/.test(path)
      || /(?:^|\.)(?:amsg|qmsg)\./.test(host)
      || /(?:rum|telemetry|analytics|beacon|metrics|tracking)/.test(host)
      || /(?:^|\/)(?:act|qos|speed|collect|report|log|dash)(?:\/|$)/.test(path)) return null
    if (/(?:search|query|suggest|keyword)/.test(path)) return 'search'
    if (/(?:player|playervideo|playback|video\/info)/.test(path)) return 'playback'
    return 'other'
  } catch {
    return null
  }
}

function appendBlock(text: string, block: string): string {
  return `${text}${text.trim() === '' ? '' : '\n\n'}${block}`
}

export interface RecordingBlockUpdate { previous: string; next: string }

export function applyRecordingBlock(text: string, update: RecordingBlockUpdate): string {
  if (update.previous !== '' && text.includes(update.previous)) {
    return text.replace(update.previous, update.next)
  }
  return appendBlock(text, update.next)
}

/** Build a short chat summary while retaining every raw event in Teach. */
export class CompactRecordingComposer {
  private steps: Step[] = []
  private readonly networkOk = new Set<NetworkCategory>()
  private readonly networkFailures = new Set<string>()
  private readonly networkAttached = new Set<NetworkCategory>()
  private readonly networkByClick = new Set<string>()
  private readonly downloadOutcomes = new Map<number, { stepIndex: number; outcomeIndex: number }>()
  private rendered = ''
  private lastNavigation = ''
  private lastClickIndex: number | null = null

  reset(): void {
    this.steps = []
    this.networkOk.clear()
    this.networkFailures.clear()
    this.networkAttached.clear()
    this.networkByClick.clear()
    this.downloadOutcomes.clear()
    this.rendered = ''
    this.lastNavigation = ''
    this.lastClickIndex = null
  }

  snapshot(): string {
    return this.rendered
  }

  accept(event: RecordingEventInput, locale: UiLocale): RecordingBlockUpdate | null {
    const zh = locale === 'zh'
    switch (event.kind) {
      case 'tab':
        if (event.action === 'initial') {
          this.steps.push({ kind: 'other', text: `${zh ? '开始页面' : 'Start page'}：${event.tab.title || displayUrl(event.tab.url)}` })
        } else if (event.action === 'activated') {
          const outcome = `${zh ? '新标签页' : 'new tab'}：${event.tab.title || displayUrl(event.tab.url)}`
          if (!this.attachToRecentClick(event.capturedAt, outcome)) {
            this.steps.push({ kind: 'other', text: `${zh ? '切换标签页' : 'Switch tab'}：${event.tab.title || displayUrl(event.tab.url)}` })
          }
        }
        break
      case 'click':
        this.steps.push({
          kind: 'click',
          selector: event.target.selector,
          capturedAt: event.capturedAt,
          text: `${zh ? '点击' : 'Click'} [${controlLabel(event.target, zh)}] ${targetLabel(event.target)}`,
          outcomes: [],
          href: event.target.href,
          hrefHasHiddenQuery: event.target.hrefHasHiddenQuery,
        })
        this.lastClickIndex = this.steps.length - 1
        break
      case 'input':
      case 'change':
      case 'select': {
        const value = event.value.kind === 'secret' ? event.value.placeholder : JSON.stringify(event.value.value)
        const verb = event.kind === 'select' ? (zh ? '选择' : 'Select') : (zh ? '输入' : 'Enter')
        const step = { kind: 'input' as const, selector: event.target.selector, text: `${verb} ${targetLabel(event.target)}：${value}` }
        const last = this.steps.at(-1)
        if (last?.kind === 'input' && last.selector === step.selector) this.steps[this.steps.length - 1] = step
        else this.steps.push(step)
        break
      }
      case 'submit':
        this.steps.push({ kind: 'other', text: `${zh ? '提交表单' : 'Submit form'} ${targetLabel(event.target)}` })
        break
      case 'keydown':
        if (event.key === 'Enter' || event.key === 'Escape') {
          this.steps.push({ kind: 'other', text: `${zh ? '按键' : 'Key'} ${event.key}` })
        }
        break
      case 'navigation': {
        if (event.frame.id !== 0) break
        const url = displayUrl(event.url)
        if (url === '' || url === this.lastNavigation) break
        this.lastNavigation = url
        if (!this.attachToRecentClick(event.capturedAt, `${zh ? '打开页面' : 'open page'} ${url}`)) {
          this.steps.push({ kind: 'other', text: `${zh ? '打开页面' : 'Open page'}：${url}` })
        }
        break
      }
      case 'network': {
        const category = networkCategory(event.url)
        if (category === null) break
        const failed = event.failed === true || (event.statusCode !== undefined && event.statusCode >= 400)
        if (failed) this.networkFailures.add(`${event.method} ${event.url}`)
        else if (event.statusCode !== undefined && event.statusCode < 400) this.networkOk.add(category)
        if (event.trigger?.kind === 'click' && event.statusCode !== undefined) {
          const index = this.findRecentClick(event.capturedAt, event.trigger.target.selector, 4_000)
          const key = `${index}:${category}:${failed ? 'failed' : 'ok'}`
          if (index !== null && !this.networkByClick.has(key)) {
            this.networkByClick.add(key)
            this.attachToRecentClick(event.capturedAt,
              `${zh ? '关联请求' : 'related request'} ${event.method} ${new URL(event.url).pathname} → ${event.statusCode}`,
              event.trigger.target.selector, 4_000)
            this.networkAttached.add(category)
          }
        }
        break
      }
      case 'network-response':
        // Response structure is supplied to skill extraction, not the compact
        // human-readable action recap.
        break
      case 'download': {
        const state = event.state === 'complete' ? (zh ? '下载完成' : 'download complete')
          : event.state === 'interrupted' ? (zh ? '下载中断' : 'download interrupted')
            : (zh ? '开始下载' : 'download started')
        const filename = event.filename || event.url.split('/').at(-1) || (zh ? '文件' : 'file')
        const url = event.finalUrl || event.url
        const source = url === '' ? (zh ? '页面生成的文件' : 'page-generated file')
          : `${url}${event.urlHasHiddenQuery ? (zh ? '（参数已隐藏）' : ' (parameters hidden)') : ''}`
        const confidence = event.association === 'recent-click'
          ? (zh ? '（按时间关联，待确认）' : ' (time-correlated, unconfirmed)') : ''
        const outcome = `${state} ${filename}；${zh ? '来源' : 'source'} ${source}${confidence}`
        const mapped = this.downloadOutcomes.get(event.downloadId)
        if (mapped !== undefined) {
          const step = this.steps[mapped.stepIndex]
          if (step?.outcomes !== undefined) step.outcomes[mapped.outcomeIndex] = outcome
        } else {
          const index = this.findRecentClick(event.capturedAt, event.trigger.selector, 8_000)
          if (index === null) this.steps.push({ kind: 'other', text: outcome })
          else {
            const step = this.steps[index]!
            const outcomeIndex = step.outcomes!.push(outcome) - 1
            this.downloadOutcomes.set(event.downloadId, { stepIndex: index, outcomeIndex })
          }
        }
        break
      }
    }

    const next = this.render(locale)
    if (next === this.rendered) return null
    const previous = this.rendered
    this.rendered = next
    return { previous, next }
  }

  private render(locale: UiLocale): string {
    const zh = locale === 'zh'
    const lines = [zh ? '【操作记录】' : '[Recorded actions]', ...this.steps.map((step) => {
      const fallback = step.href === undefined ? ''
        : `${zh ? '链接目标' : 'link target'} ${step.href}${step.hrefHasHiddenQuery ? (zh ? '（参数已隐藏）' : ' (parameters hidden)') : ''}`
      const outcomes = [...(step.outcomes ?? [])]
      const reachedDestination = outcomes.some((outcome) => /^(?:打开页面|open page|开始下载|下载完成|下载中断|download started|download complete|download interrupted)/.test(outcome))
      if (fallback !== '' && !reachedDestination) outcomes.push(fallback)
      return `• ${step.text}${outcomes.length ? ` → ${outcomes.join('；')}` : ''}`
    })]
    const network: string[] = []
    if (this.networkOk.has('search') && !this.networkAttached.has('search')) network.push(zh ? '搜索接口已响应' : 'search API responded')
    if (this.networkOk.has('playback') && !this.networkAttached.has('playback')) network.push(zh ? '播放接口已响应' : 'player API responded')
    if (this.networkOk.has('other') && !this.networkAttached.has('other')
      && !this.networkOk.has('search') && !this.networkOk.has('playback')) {
      network.push(zh ? '页面接口已响应' : 'page API responded')
    }
    if (this.networkFailures.size > 0) network.push(zh
      ? `${this.networkFailures.size} 个接口异常`
      : `${this.networkFailures.size} API error(s)`)
    if (network.length > 0) lines.push(`• ${zh ? '网络概况' : 'Network'}：${network.join(zh ? '；' : '; ')}`)
    return lines.join('\n')
  }

  private findRecentClick(at: number, selector?: string, withinMs = 6_000): number | null {
    const index = this.lastClickIndex
    if (index === null) return null
    const click = this.steps[index]
    if (click?.kind !== 'click' || click.capturedAt === undefined
      || at - click.capturedAt < -500 || at - click.capturedAt > withinMs
      || (selector !== undefined && click.selector !== selector)) return null
    return index
  }

  private attachToRecentClick(at: number, outcome: string, selector?: string, withinMs = 6_000): boolean {
    const index = this.findRecentClick(at, selector, withinMs)
    if (index === null) return false
    const outcomes = this.steps[index]!.outcomes!
    if (!outcomes.includes(outcome)) outcomes.push(outcome)
    return true
  }
}
