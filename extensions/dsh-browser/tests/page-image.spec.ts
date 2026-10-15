// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCapturePermissionError, probeVisiblePageImage, readVisiblePageImage } from '../src/background/page-image.ts'

function picture({ width = 2400, height = 3200, rectWidth = 600, rectHeight = 700, src = '/api/attachments/exam/content' } = {}) {
  const image = document.createElement('img')
  image.src = src
  Object.defineProperties(image, {
    complete: { value: true }, naturalWidth: { value: width }, naturalHeight: { value: height },
  })
  image.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: rectWidth, bottom: rectHeight,
    width: rectWidth, height: rectHeight, toJSON() {} })
  document.body.append(image)
  return image
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('visible webpage image reading', () => {
  it('reads the complete same-origin preview at source resolution, including offscreen image portions', () => {
    const image = picture()
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const selected = probeVisiblePageImage(null)
    expect(selected).toMatchObject({ naturalWidth: 2400, naturalHeight: 3200 })
    if (selected === null || 'error' in selected) throw Error('Expected preview candidate')
    expect(probeVisiblePageImage(selected)).toMatchObject({ mediaType: 'image/png', data: 'AQID', width: 2400, height: 3200 })
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 2400, 3200)
  })

  it('excludes hidden images, unloaded images, small icons, and images covered by a modal', () => {
    picture({ rectWidth: 24, rectHeight: 24 })
    const hidden = picture({ src: '/hidden' })
    hidden.style.opacity = '0'
    const covered = picture({ src: '/covered' })
    const visible = picture({ src: '/visible' })
    document.body.append(Object.assign(document.createElement('img'), { src: '/loading' }))
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => visible })
    try {
      const candidate = probeVisiblePageImage(null)
      expect(candidate).toMatchObject({ index: 3, src: visible.src })
      expect(candidate).not.toMatchObject({ src: covered.src })
    } finally { Reflect.deleteProperty(document, 'elementFromPoint') }
  })

  it('fails safely if the selected preview changes before pixels are read', () => {
    const image = picture()
    const selected = probeVisiblePageImage(null)
    if (selected === null || 'error' in selected) throw Error('Expected preview candidate')
    image.src = '/api/attachments/different/content'
    expect(probeVisiblePageImage(selected)).toMatchObject({ error: expect.stringContaining('changed') })
  })

  it('measures the visible portion inside a scrollable preview rather than the offscreen image rectangle', () => {
    const image = picture()
    const preview = document.createElement('div')
    preview.style.overflow = 'auto'
    preview.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 100,
      width: 400, height: 100, toJSON() {} })
    document.body.append(preview)
    preview.append(image)
    expect(probeVisiblePageImage(null)).toMatchObject({ index: 0, visibleArea: 40000 })
  })

  it('prioritizes the open attachment preview over larger partially visible background images', () => {
    picture({ src: '/background' })
    const exam = picture({ src: '/exam', rectWidth: 400, rectHeight: 190 })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    dialog.append(exam)
    expect(probeVisiblePageImage(null)).toMatchObject({ index: 1, src: exam.src, inDialog: true })
  })

  it('bounds oversized source images and explains cross-origin canvas protection', () => {
    picture({ width: 8000, height: 6000 })
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const selected = probeVisiblePageImage(null)
    if (selected === null || 'error' in selected) throw Error('Expected preview candidate')
    expect(probeVisiblePageImage(selected)).toMatchObject({ width: 4096, height: 3072 })
    encode.mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
    expect(probeVisiblePageImage(selected)).toMatchObject({ error: expect.stringContaining('protected') })
  })

  it('reads only the main document and binds pixels to its document identity', async () => {
    const small = { index: 0, src: 'https://example.com/small.png', visibleArea: 5000, naturalWidth: 100, naturalHeight: 100 }
    const large = { index: 1, src: 'https://example.com/exam.png', visibleArea: 400000, naturalWidth: 2400, naturalHeight: 3200 }
    const executeScript = vi.fn().mockResolvedValueOnce([
      { frameId: 0, documentId: 'main', result: small }, { frameId: 2, documentId: 'exam-frame', result: large },
    ]).mockResolvedValueOnce([{ frameId: 0, documentId: 'main', result: { ...small, data: 'AQID', mediaType: 'image/png', width: 100, height: 100 } }])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    const result = await readVisiblePageImage(7)
    expect(executeScript).toHaveBeenNthCalledWith(1, { target: { tabId: 7, frameIds: [0] }, func: probeVisiblePageImage, args: [null] })
    expect(executeScript).toHaveBeenLastCalledWith({ target: { tabId: 7, documentIds: ['main'] }, func: probeVisiblePageImage, args: [small] })
    expect(result.image).toEqual({ mediaType: 'image/png', data: 'AQID' })
    expect(result.text).toContain('not a viewport screenshot')
    expect(result.text).not.toContain('https://')
  })

  it('does not read pixels after tab handoff or cancellation', async () => {
    const candidate = { index: 0, src: 'https://example.com/exam.png', visibleArea: 5000, naturalWidth: 100, naturalHeight: 100 }
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: candidate }])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    const allowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    await expect(readVisiblePageImage(7, allowed)).rejects.toThrow('cancelled')
    expect(executeScript).toHaveBeenCalledTimes(1)
  })

  it('recognizes tab-capture permission errors without disguising rate limits', () => {
    expect(isCapturePermissionError(new Error("Either the '<all_urls>' or 'activeTab' permission is required."))).toBe(true)
    expect(isCapturePermissionError(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded'))).toBe(false)
  })
})
