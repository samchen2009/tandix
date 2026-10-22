// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageMarkdown } from '../src/panel/MessageMarkdown.tsx'
import { artifactDownload } from '../src/panel/artifacts.ts'
import type { PanelApi } from '../src/panel/api.ts'

const path = '/Users/me/workspace/output/数学学习-长图.png'
const text = `[下载长图](${path})`
const file = { filename: '数学学习-长图.png', size: 4, data: 'iVBORw==', mediaType: 'image/png' }

describe('assistant artifact downloads', () => {
  let root: Root
  let rpc: ReturnType<typeof vi.fn>
  let urls: ReturnType<typeof vi.fn>
  let downloaded: string[]

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    root = createRoot(document.querySelector('#root')!)
    rpc = vi.fn().mockResolvedValue(file)
    urls = vi.fn(() => 'blob:generated-output')
    downloaded = []
    vi.useFakeTimers()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: urls, revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloaded.push(this.download) })
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.runOnlyPendingTimers()
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  })

  async function render(sessionId = 'owned', assistant = true): Promise<void> {
    await act(async () => { root.render(createElement(MessageMarkdown, {
      text, sessionId, assistant, zh: true, api: { rpc } as unknown as PanelApi,
    })) })
  }

  function click(): void {
    document.querySelector('a[data-artifact-path]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  it('requests the current session only on click and downloads a blob with the actual filename', async () => {
    await render()
    expect(rpc).not.toHaveBeenCalled()
    await act(async () => { click() })
    expect(rpc).toHaveBeenCalledWith('session.artifact', { sessionId: 'owned', path })
    expect(downloaded).toEqual(['数学学习-长图.png'])
    expect(urls.mock.calls[0][0]).toMatchObject({ size: 4, type: 'application/octet-stream' })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('已开始下载')
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('keeps a missing-file error visible without reporting a download', async () => {
    rpc.mockRejectedValue(new Error('ENOENT: file does not exist'))
    await render()
    await act(async () => { click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('下载失败：ENOENT')
    expect(downloaded).toEqual([])
  })

  it('explains the upgrade needed for an older companion', async () => {
    rpc.mockRejectedValue(new Error('Codex backend does not support session.artifact'))
    await render()
    await act(async () => { click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('更新本机伴随程序')
    expect(urls).not.toHaveBeenCalled()
  })

  it('ignores repeated clicks while fetching and abandons downloads after switching sessions', async () => {
    let resolve!: (value: unknown) => void
    rpc.mockReturnValue(new Promise(done => { resolve = done }))
    await render()
    await act(async () => { click(); click() })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('准备下载')
    await render('different-session')
    await act(async () => { resolve(file) })
    expect(urls).not.toHaveBeenCalled()
  })

  it('never turns a user message into a file download grant', async () => {
    await render('owned', false)
    expect(document.querySelector('[data-artifact-path]')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('validates multi-megabyte output without truncation and rejects malformed file responses', () => {
    const size = 4_663_134
    const result = artifactDownload({ ...file, size, data: btoa('\0'.repeat(size)) })
    expect(result.blob.size).toBe(size)
    for (const invalid of [{ ...file, filename: '../secret' }, { ...file, size: 5 }, { ...file, data: '!!!!!!!!' }, { ...file, size: 26 * 1024 * 1024 }]) {
      expect(() => artifactDownload(invalid)).toThrow()
    }
  })
})
