import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelApi } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import { saveArtifact } from './artifacts.ts'

export const MessageMarkdown = memo(function MessageMarkdown({ text, assistant, api, sessionId, zh }: {
  text: string
  assistant: boolean
  api: PanelApi
  sessionId: string
  zh: boolean
}): React.JSX.Element {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const generation = useRef(0)
  const html = useMemo(() => renderMarkdown(text, { artifactLinks: assistant }), [text, assistant])
  useEffect(() => {
    pending.current = false
    setStatus(''); setError('')
    return () => { generation.current++ }
  }, [sessionId])
  return <>
    <div className="md" dangerouslySetInnerHTML={{ __html: html }}
      onClick={event => {
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-artifact-path]') : null
        if (!assistant || !link || !event.currentTarget.contains(link)) return
        event.preventDefault()
        if (pending.current) return
        pending.current = true
        const current = generation.current
        setError(''); setStatus(zh ? '正在准备下载…' : 'Preparing download…')
        void api.rpc('session.artifact', { sessionId, path: link.dataset.artifactPath }).then(value => {
          if (generation.current !== current) return
          const filename = saveArtifact(value)
          setStatus(zh ? `已开始下载：${filename}` : `Download started: ${filename}`)
        }).catch((cause: unknown) => {
          if (generation.current !== current) return
          setStatus('')
          const detail = cause instanceof Error ? cause.message : String(cause)
          setError(/does not support|not supported|unsupported|unknown method|not implemented/i.test(detail)
            ? (zh ? '当前 Agent 不支持文件下载。请更新本机伴随程序，或切换到 Codex、Cursor、WorkBuddy 后重试。' : 'This agent does not support file downloads. Update the native companion or use Codex, Cursor, or WorkBuddy.')
            : (zh ? `下载失败：${detail}` : `Download failed: ${detail}`))
        }).finally(() => { if (generation.current === current) pending.current = false })
      }} />
    {status && <p className="artifact-download-status" role="status">{status}</p>}
    {error && <p className="artifact-download-error" role="alert">{error}</p>}
  </>
})
