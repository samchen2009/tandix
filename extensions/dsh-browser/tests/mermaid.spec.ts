// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../src/panel/markdown.ts'
import { renderMermaidDiagrams } from '../src/panel/mermaid.ts'

const { render, initialize } = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn() }))
vi.mock('mermaid', () => ({ default: { render, initialize } }))
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 100"><text>网络定义</text></svg>'

beforeEach(() => {
  document.body.innerHTML = '<div id="message"></div>'
  render.mockReset().mockResolvedValue({ svg })
})

function message(): HTMLElement {
  const root = document.querySelector<HTMLElement>('#message')!
  root.innerHTML = renderMarkdown('```css\nflowchart LR\nA["网络定义<br/>nemo_small.py"] --> B["新 .tnm"]\n```')
  return root
}

describe('Mermaid message rendering', () => {
  it('renders a diagram as an isolated image with readable width and expandable source', async () => {
    const root = message()
    await renderMermaidDiagrams(root, () => true, true)
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false }))
    expect(render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), expect.stringContaining('flowchart LR'), expect.any(HTMLElement))
    const image = root.querySelector('img')!
    expect(decodeURIComponent(image.src.split(',')[1])).toContain('<text>网络定义</text>')
    expect(image.width).toBe(1200)
    expect(root.querySelector('details')?.open).toBe(false)
    expect(root.querySelector('summary')?.textContent).toBe('查看图表源码')
    expect(root.querySelector('code')?.textContent).toContain('nemo_small.py')
    expect(document.querySelector('.mermaid-render-host')).toBeNull()
    await renderMermaidDiagrams(root, () => true, true)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('keeps broken diagrams readable and removes scratch DOM after errors', async () => {
    render.mockRejectedValue(new Error('parse error'))
    const root = message()
    await renderMermaidDiagrams(root, () => true, true)
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('pre')?.textContent).toContain('flowchart LR')
    expect(document.querySelector('.mermaid-render-host')).toBeNull()
  })

  it('does not insert a stale render after streaming changes or switching sessions', async () => {
    let finish!: (value: { svg: string }) => void
    render.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    let current = true
    const root = message()
    const work = renderMermaidDiagrams(root, () => current, false)
    await vi.waitFor(() => expect(render).toHaveBeenCalled())
    current = false
    finish({ svg })
    await work
    expect(root.querySelector('img')).toBeNull()
    expect(document.querySelector('.mermaid-render-host')).toBeNull()
  })

  it('sanitizes generated SVG and keeps its CSS outside the chat document', async () => {
    render.mockResolvedValue({ svg: svg.replace('</svg>', '<script>alert(1)</script><foreignObject><img src="https://evil.example" /></foreignObject><a href="javascript:alert(1)"><text>link</text></a><image href="https://evil.example" /></svg>') })
    const root = message()
    await renderMermaidDiagrams(root, () => true, false)
    const image = root.querySelector('img')!
    const output = decodeURIComponent(image.src.split(',')[1])
    expect(output).not.toMatch(/<script|foreignObject|javascript:|evil\.example|<image/)
    expect(root.querySelector('svg')).toBeNull()
    expect(root.querySelector('summary')?.textContent).toBe('View diagram source')
  })
})
