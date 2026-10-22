/** File links are download actions through the local agent, never file:// navigation. */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024

export function isLocalArtifactLink(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false
  try {
    let path = value
    if (/^file:/i.test(path)) {
      const url = new URL(path)
      if (url.hostname !== '' && url.hostname !== 'localhost') return false
      path = url.pathname
    } else if (path.startsWith('sandbox:')) path = path.slice(8)
    path = decodeURIComponent(path)
    return !/[\u0000-\u001f\u007f]/u.test(path) && !path.startsWith('//') && !path.startsWith('\\\\')
      && /^(?:\/|[a-z]:[\\/]|\.\/|output\/|artifacts\/)/i.test(path)
  } catch { return false }
}

export function artifactDownload(value: unknown): { filename: string; blob: Blob } {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid artifact response')
  const file = value as Record<string, unknown>
  if (typeof file.filename !== 'string' || file.filename === '' || /[\\/\u0000-\u001f\u007f]/u.test(file.filename)
    || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > ARTIFACT_MAX_BYTES
    || typeof file.data !== 'string' || file.data.length !== Math.ceil(file.size / 3) * 4
    || /[^A-Za-z0-9+/=]/.test(file.data)) {
    throw new Error('Invalid artifact response')
  }
  const decoded = atob(file.data)
  if (decoded.length !== file.size) throw new Error('Incomplete artifact download')
  // Always download as a file; HTML/SVG output must never execute in the extension.
  return { filename: file.filename, blob: new Blob([Uint8Array.from(decoded, char => char.charCodeAt(0))], { type: 'application/octet-stream' }) }
}

export function saveArtifact(value: unknown): string {
  const { filename, blob } = artifactDownload(value)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  try {
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return filename
}
