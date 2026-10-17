/** Public, versioned webpage API. All file bytes travel as bounded base64 chunks. */
export const WEB_API_VERSION = 1
export const WEB_API_PORT = 'tandix-web-v1'
export const WEB_DISCOVERY_REQUEST = 'tandix:discover:v1'
export const WEB_DISCOVERY_RESPONSE = 'tandix:discovered:v1'
export const WEB_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 25 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  chunkBytes: 192 * 1024,
  maxPromptChars: 64_000,
  maxResultChars: 1_000_000,
  maxTaskMs: 10 * 60_000,
} as const
export const WEB_MEDIA_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type WebMediaType = typeof WEB_MEDIA_TYPES[number]
export interface WebFileInfo { name: string; mediaType: WebMediaType; bytes: number }
export interface WebTaskResult { taskId: string; text: string; data?: unknown }
export interface WebTaskEvent {
  taskId: string
  seq?: number
  type: 'accepted' | 'creating' | 'mapped' | 'starting' | 'resuming' | 'started' | 'delta' | 'waiting-for-user' | 'interrupted' | 'completed' | 'failed' | 'cancelled' | 'disconnected' | 'reconnected' | 'snapshot'
  backend?: string
  sessionId?: string
  text?: string
  result?: WebTaskResult
  error?: { code: string; message: string }
}
export interface WebTaskSnapshot {
  taskId: string
  backend: 'codex'
  agentId: string
  sessionId: string | null
  turnId: string | null
  status: 'accepted' | 'creating' | 'ready' | 'dispatching' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
  attempt: number
  createdAt: number
  updatedAt: number
  lastSeq: number
  cursor: number
  hasMore: boolean
  reset: boolean
  text: string
  events: WebTaskEvent[]
  result?: WebTaskResult
  error?: { code: string; message: string }
  resumable: boolean
}
export class WebApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WebApiError' }
}
export function webRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function webpageOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return url.origin
  } catch { /* An opaque or invalid sender is never authorized. */ }
  return null
}
