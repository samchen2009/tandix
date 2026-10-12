/**
 * Installed into the page's MAIN world while recording. It never emits JSON
 * values: only bounded field paths and primitive/container types cross into
 * the extension world.
 */
export function installNetworkContractProbe(recordingId: string, enabled: boolean): void {
  const globalKey = '__tandixNetworkContractProbeV1__'
  const marker = '__TANDIX_NETWORK_RESPONSE_SHAPE_V1__'
  const page = globalThis as typeof globalThis & Record<string, unknown>
  type ProbeState = { enabled: boolean; recordingId: string }
  let state = page[globalKey] as ProbeState | undefined

  if (state === undefined) {
    state = { enabled: false, recordingId: '' }
    page[globalKey] = state

    const valueType = (value: unknown): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' => {
      if (value === null) return 'null'
      if (Array.isArray(value)) return 'array'
      if (typeof value === 'string') return 'string'
      if (typeof value === 'number') return 'number'
      if (typeof value === 'boolean') return 'boolean'
      return 'object'
    }
    const safeKey = (key: string): string => /^[\p{L}_$][\p{L}\p{N}_$-]{0,80}$/u.test(key) ? key : '*'
    const shape = (root: unknown): { fields: Array<{ path: string; type: string }>; listPaths: string[] } => {
      const fields: Array<{ path: string; type: string }> = []
      const listPaths: string[] = []
      const seen = new WeakSet<object>()
      const visit = (value: unknown, path: string, depth: number): void => {
        if (fields.length >= 200 || depth > 7) return
        const type = valueType(value)
        fields.push({ path: path || '$', type })
        if (type === 'array') {
          listPaths.push(path || '$')
          const sample = (value as unknown[]).find((entry) => entry !== null && entry !== undefined)
          if (sample !== undefined) visit(sample, `${path || '$'}[]`, depth + 1)
          return
        }
        if (type !== 'object' || value === null) return
        if (seen.has(value as object)) return
        seen.add(value as object)
        for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
          visit(child, path === '' ? safeKey(key) : `${path}.${safeKey(key)}`, depth + 1)
        }
      }
      visit(root, '', 0)
      return { fields, listPaths: [...new Set(listPaths)].slice(0, 50) }
    }
    const publish = (method: string, url: string, statusCode: number, json: unknown): void => {
      if (state?.enabled !== true) return
      const result = shape(json)
      if (result.fields.length === 0) return
      window.postMessage({
        source: marker,
        payload: {
          recordingId: state.recordingId,
          capturedAt: Date.now(),
          url,
          method: method.toUpperCase().slice(0, 12),
          statusCode,
          fields: result.fields,
          listPaths: result.listPaths,
        },
      }, '*')
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
      const response = await originalFetch.apply(this, args)
      try {
        if (state?.enabled === true && /(?:^|;)\s*application\/(?:[\w.+-]*\+)?json\b/iu.test(response.headers.get('content-type') ?? '')) {
          const input = args[0]
          const method = (args[1]?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
          void response.clone().json().then((json: unknown) => publish(method, response.url, response.status, json)).catch(() => {})
        }
      } catch { /* response inspection must never affect the page request */ }
      return response
    }

    const originalOpen = XMLHttpRequest.prototype.open
    const requestMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]): void {
      requestMeta.set(this, { method, url: String(url) })
      Reflect.apply(originalOpen, this, [method, url, ...rest])
    }
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest['send']>): void {
      this.addEventListener('loadend', () => {
        try {
          if (state?.enabled !== true || !/(?:^|;)\s*application\/(?:[\w.+-]*\+)?json\b/iu.test(this.getResponseHeader('content-type') ?? '')) return
          const meta = requestMeta.get(this)
          if (meta === undefined) return
          const json: unknown = this.responseType === 'json' ? this.response : JSON.parse(this.responseText)
          publish(meta.method, this.responseURL || new URL(meta.url, location.href).toString(), this.status, json)
        } catch { /* malformed or inaccessible responses are omitted */ }
      }, { once: true })
      return originalSend.apply(this, args)
    }
  }

  state.enabled = enabled
  state.recordingId = enabled ? recordingId : ''
}
