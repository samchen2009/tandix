import type {
  DomCaptureEvent,
  NetworkRequestEvidence,
  NetworkScalar,
  NetworkValueEvidence,
} from './schema.ts'

const SENSITIVE_NAME = /(?:pass(?:word)?|secret|token|auth|cookie|session|csrf|sign(?:ature)?|api[-_]?key|credential|phone|mobile|email|idcard|identity)/iu
const RUNTIME_TEXT_NAME = /(?:keyword|query|search|content|text|remark|description|message|关键词|内容|描述|备注)/iu
const MAX_FIXED_TEXT = 160

export interface RecentFormValue {
  capturedAt: number
  event: Extract<DomCaptureEvent, { kind: 'input' | 'change' | 'select' }>
}

function scalarType(value: NetworkScalar): NetworkValueEvidence['valueType'] {
  return value === null ? 'null' : typeof value as NetworkValueEvidence['valueType']
}

function temporalFormat(name: string, value: NetworkScalar): NetworkValueEvidence['format'] | undefined {
  const text = String(value ?? '')
  const timeNamed = /(?:time|date|start|end|from|to|begin|日期|时间)/iu.test(name)
  if (!timeNamed) return undefined
  if (typeof value === 'number' || /^\d+$/.test(text)) {
    if (/^\d{13}$/.test(text)) return 'unix-milliseconds'
    if (/^\d{10}$/.test(text)) return 'unix-seconds'
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'date'
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    return /T|Z|[+-]\d{2}:?\d{2}$/.test(text) ? 'iso-8601' : 'date-time'
  }
  return undefined
}

function sourceFor(event: RecentFormValue['event']): NetworkValueEvidence['source'] {
  return {
    ...(event.target.name === undefined ? {} : { name: event.target.name }),
    ...(event.target.text === undefined ? {} : { text: event.target.text }),
    ...(event.target.control === undefined ? {} : { control: event.target.control }),
    ...(event.kind === 'select' ? { selectedLabels: event.selectedLabels } : {}),
  }
}

function evidenceFor(name: string, value: NetworkScalar, recent: RecentFormValue[]): NetworkValueEvidence {
  const valueType = scalarType(value)
  const format = temporalFormat(name, value)
  if (SENSITIVE_NAME.test(name)) return { kind: 'redacted', valueType, placeholder: '{{secret}}', ...(format === undefined ? {} : { format }) }
  const observed = [...recent].reverse().find(({ event }) => event.value.kind === 'literal'
    && event.value.value === String(value ?? ''))
  if (observed !== undefined) {
    const source = sourceFor(observed.event)
    if (observed.event.kind === 'select') {
      return { kind: 'fixed', valueType, ...(value === null ? {} : { value }), source, ...(format === undefined ? {} : { format }) }
    }
    return { kind: 'input', valueType, placeholder: '{{input}}', source, ...(format === undefined ? {} : { format }) }
  }
  if (RUNTIME_TEXT_NAME.test(name)) return { kind: 'input', valueType, placeholder: '{{input}}', ...(format === undefined ? {} : { format }) }
  if (format !== undefined) return { kind: 'input', valueType, placeholder: '{{input}}', format }
  if (typeof value === 'string' && value.length > MAX_FIXED_TEXT) {
    return { kind: 'redacted', valueType, placeholder: '{{secret}}' }
  }
  return { kind: 'fixed', valueType, ...(value === null ? {} : { value }) }
}

function scalar(value: unknown): NetworkScalar | undefined {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value : undefined
}

function flatten(value: unknown, prefix = '', output: Record<string, NetworkScalar> = {}, depth = 0): Record<string, NetworkScalar> {
  if (depth > 4 || Object.keys(output).length >= 100) return output
  const direct = scalar(value)
  if (direct !== undefined && prefix !== '') output[prefix] = direct
  else if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => flatten(item, `${prefix}[${index}]`, output, depth + 1))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      flatten(item, prefix === '' ? key : `${prefix}.${key}`, output, depth + 1)
    }
  }
  return output
}

function fields(values: Record<string, NetworkScalar>, recent: RecentFormValue[]): Record<string, NetworkValueEvidence> | undefined {
  const entries = Object.entries(values).map(([name, value]) => [name, evidenceFor(name, value, recent)] as const)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

export function requestEvidence(
  rawUrl: string,
  requestBody: chrome.webRequest.WebRequestBodyDetails['requestBody'] | undefined,
  recent: RecentFormValue[],
): Omit<NetworkRequestEvidence, 'auth'> {
  let queryValues: Record<string, NetworkScalar> = {}
  try {
    const url = new URL(rawUrl)
    for (const [name, value] of url.searchParams) queryValues[name] = value
  } catch { /* malformed URL is ignored */ }

  let bodyValues: Record<string, NetworkScalar> = {}
  let bodyEncoding: 'json' | 'form' | undefined
  if (requestBody?.formData !== undefined) {
    bodyEncoding = 'form'
    for (const [name, values] of Object.entries(requestBody.formData)) {
      if (values.length === 1) bodyValues[name] = values[0]!
      else values.slice(0, 20).forEach((value, index) => { bodyValues[`${name}[${index}]`] = value })
    }
  } else {
    const bytes = requestBody?.raw?.flatMap((part) => part.bytes === undefined ? [] : [new Uint8Array(part.bytes)]) ?? []
    if (bytes.length > 0) {
      const size = bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      if (size <= 128_000) {
        const merged = new Uint8Array(size)
        let offset = 0
        for (const chunk of bytes) { merged.set(chunk, offset); offset += chunk.byteLength }
        const text = new TextDecoder().decode(merged)
        try {
          bodyValues = flatten(JSON.parse(text))
          bodyEncoding = 'json'
        } catch {
          const form = new URLSearchParams(text)
          if ([...form].length > 0) {
            bodyEncoding = 'form'
            for (const [name, value] of form) bodyValues[name] = value
          }
        }
      }
    }
  }
  const query = fields(queryValues, recent)
  const body = fields(bodyValues, recent)
  return {
    ...(query === undefined ? {} : { query }),
    ...(body === undefined ? {} : { body }),
    ...(bodyEncoding === undefined ? {} : { bodyEncoding }),
  }
}

export function authenticationEvidence(headers: chrome.webRequest.HttpHeader[] | undefined): NetworkRequestEvidence['auth'] {
  if (headers === undefined) return { kind: 'unknown' }
  const names = headers.map((header) => header.name.toLowerCase())
  const authorization = headers.find((header) => header.name.toLowerCase() === 'authorization')?.value ?? ''
  const bearer = /^bearer\s+/iu.test(authorization)
  const cookie = names.includes('cookie')
  if (bearer && cookie) return { kind: 'cookie-and-bearer' }
  if (bearer) return { kind: 'bearer' }
  if (cookie) return { kind: 'cookie' }
  if (names.some((name) => /(?:token|api[-_]?key|csrf|signature)/iu.test(name))) return { kind: 'header-token' }
  return { kind: 'none' }
}
