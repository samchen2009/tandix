const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_METADATA_PROTOCOLS = new Set(['about:', 'chrome:', 'edge:', 'file:', 'moz-extension:', 'chrome-extension:'])

function sensitivePathSegment(segment: string): boolean {
  let decoded = segment
  try { decoded = decodeURIComponent(segment) } catch { /* retain the encoded segment */ }
  return /^\d{5,}$/u.test(decoded)
    || /^[0-9a-f]{12,}$/iu.test(decoded)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded)
    || (/^[a-z0-9_-]{24,}$/iu.test(decoded) && /\d/u.test(decoded))
}

function maskedPath(pathname: string): string {
  return pathname.split('/').map((segment) => sensitivePathSegment(segment) ? ':id' : segment).join('/')
}

/**
 * Return a model-facing URL without credentials, query data, fragments, or
 * identifier-like path segments. This must never be used for real navigation.
 */
export function sanitizeUrlForModel(value: string | undefined, base?: string): string {
  if (value === undefined || value === '') return ''
  try {
    const url = new URL(value, base)
    if (!WEB_PROTOCOLS.has(url.protocol) && !SAFE_METADATA_PROTOCOLS.has(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = maskedPath(url.pathname)
    return url.toString()
  } catch {
    return ''
  }
}
