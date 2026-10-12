import {
  REDACTED_VALUE,
  sanitizeRecordedUrl,
  type DomCaptureEvent,
  type RecordedValue,
  type RecordingTarget,
} from '../recording/schema.ts'
import { isSensitiveField } from './privacy.ts'

const MAX_TARGET_TEXT = 160

function shortText(value: string | null | undefined, max = MAX_TARGET_TEXT): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function selectorFor(element: Element): string {
  if (element.id !== '') return `#${CSS.escape(element.id)}`
  const testId = element.getAttribute('data-testid')
  if (testId !== null && testId !== '') return `[data-testid="${CSS.escape(testId)}"]`
  const name = element.getAttribute('name')
  if (name !== null && name !== '') return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`

  const segments: string[] = []
  let current: Element | null = element
  while (current !== null && current !== document.documentElement && segments.length < 5) {
    let segment = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (parent !== null) {
      const siblings = [...parent.children].filter((child) => child.tagName === current!.tagName)
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    segments.unshift(segment)
    current = parent
  }
  return segments.join(' > ') || element.tagName.toLowerCase()
}

function targetFor(element: Element): RecordingTarget {
  const role = shortText(element.getAttribute('role'))
  const label = element instanceof HTMLInputElement ? shortText(element.labels?.[0]?.textContent) : ''
  const name = shortText(element.getAttribute('aria-label') || element.getAttribute('title')
    || element.getAttribute('alt') || label || element.getAttribute('placeholder'))
  const text = isSensitiveField(element) || (element instanceof HTMLElement && element.isContentEditable)
    ? '' : shortText(element.textContent)
  const control = element instanceof HTMLAnchorElement || role === 'link' ? 'link'
    : element instanceof HTMLButtonElement || role === 'button' ? 'button'
      : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? 'input'
        : element instanceof HTMLSelectElement ? 'select'
          : element instanceof HTMLElement && (element.onclick !== null || element.tabIndex >= 0
            || getComputedStyle(element).cursor === 'pointer') ? 'custom' : 'other'
  const destination = element instanceof HTMLAnchorElement
    ? sanitizeRecordedUrl(element.href)
    : { url: '', hadHiddenQuery: false }
  return {
    tag: element.tagName.toLowerCase(),
    selector: selectorFor(element),
    ...(role === '' ? {} : { role }),
    ...(name === '' ? {} : { name }),
    ...(text === '' ? {} : { text }),
    control,
    ...(destination.url === '' ? {} : { href: destination.url }),
    ...(destination.hadHiddenQuery ? { hrefHasHiddenQuery: true } : {}),
    ...(element instanceof HTMLAnchorElement && element.hasAttribute('download') ? { download: true } : {}),
  }
}

function clickTarget(element: Element): Element {
  const actionable = element.closest('button, a, input, select, textarea, [role="button"], [role="link"], [data-testid]')
  if (actionable !== null) return actionable
  // Video cards and other custom controls often use nested, non-semantic divs.
  // Prefer the nearest bounded label instead of an opaque inner div selector.
  let candidate: Element | null = element
  let fallback: Element | null = null
  for (let depth = 0; candidate !== null && depth < 5; depth += 1, candidate = candidate.parentElement) {
    const label = shortText(candidate.getAttribute('aria-label') || candidate.getAttribute('title')
      || candidate.getAttribute('alt') || candidate.textContent)
    if (label.length < 2 || label.length > 120) continue
    fallback ??= candidate
    if (candidate instanceof HTMLElement && (candidate.onclick !== null || candidate.tabIndex >= 0
      || getComputedStyle(candidate).cursor === 'pointer')) return candidate
  }
  return fallback ?? element
}

function fieldValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): RecordedValue {
  if (isSensitiveField(element)) {
    const parameter = shortText(element.name || element.id || element.getAttribute('aria-label') || 'secret', 80)
      .replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'secret'
    return { kind: 'secret', parameter, placeholder: REDACTED_VALUE }
  }
  return { kind: 'literal', value: element.value.slice(0, 2_000) }
}

function eventElement(event: Event): Element | null {
  return event.composedPath().find((node): node is Element => node instanceof Element) ?? null
}

function modifiers(event: KeyboardEvent): string[] {
  return [
    event.altKey ? 'Alt' : '',
    event.ctrlKey ? 'Control' : '',
    event.metaKey ? 'Meta' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean)
}

/** Capture user-authored DOM interactions without ever emitting a sensitive value. */
export class DomRecorder {
  private enabled = false
  private recordingId: string | null = null

  constructor(private readonly emit: (event: DomCaptureEvent) => void) {}

  start(recordingId: string): void {
    if (this.enabled && this.recordingId === recordingId) return
    this.stop()
    this.enabled = true
    this.recordingId = recordingId
    document.addEventListener('click', this.onClick, true)
    document.addEventListener('input', this.onInput, true)
    document.addEventListener('change', this.onChange, true)
    document.addEventListener('submit', this.onSubmit, true)
    document.addEventListener('keydown', this.onKeyDown, true)
  }

  stop(): void {
    if (!this.enabled) return
    this.enabled = false
    this.recordingId = null
    document.removeEventListener('click', this.onClick, true)
    document.removeEventListener('input', this.onInput, true)
    document.removeEventListener('change', this.onChange, true)
    document.removeEventListener('submit', this.onSubmit, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
  }

  dispose(): void {
    this.stop()
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!event.isTrusted) return
    const element = eventElement(event)
    if (element === null) return
    this.emit({ kind: 'click', capturedAt: Date.now(), target: targetFor(clickTarget(element)), button: event.button })
  }

  private readonly onInput = (event: Event): void => {
    if (!event.isTrusted) return
    const element = eventElement(event)
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      this.emit({ kind: 'input', capturedAt: Date.now(), target: targetFor(element), value: fieldValue(element) })
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      this.emit({
        kind: 'input', capturedAt: Date.now(), target: targetFor(element),
        value: isSensitiveField(element)
          ? { kind: 'secret', parameter: 'contenteditable', placeholder: REDACTED_VALUE }
          : { kind: 'literal', value: (element.textContent ?? '').slice(0, 2_000) },
      })
    }
  }

  private readonly onChange = (event: Event): void => {
    if (!event.isTrusted) return
    const element = eventElement(event)
    if (element instanceof HTMLSelectElement) {
      this.emit({
        kind: 'select',
        capturedAt: Date.now(),
        target: targetFor(element),
        value: fieldValue(element),
        selectedLabels: [...element.selectedOptions].map((option) => shortText(option.label)).filter(Boolean),
      })
      return
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return
    this.emit({ kind: 'change', capturedAt: Date.now(), target: targetFor(element), value: fieldValue(element) })
  }

  private readonly onSubmit = (event: SubmitEvent): void => {
    if (!event.isTrusted) return
    const element = eventElement(event)
    if (!(element instanceof HTMLFormElement)) return
    this.emit({ kind: 'submit', capturedAt: Date.now(), target: targetFor(element) })
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!event.isTrusted || (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey)) return
    const element = eventElement(event)
    if (element === null) return
    const sensitive = isSensitiveField(element)
    this.emit({
      kind: 'keydown',
      capturedAt: Date.now(),
      target: targetFor(element),
      key: sensitive && event.key.length === 1 ? 'Redacted' : event.key,
      code: sensitive && event.key.length === 1 ? 'Redacted' : event.code,
      modifiers: modifiers(event),
    })
  }
}
