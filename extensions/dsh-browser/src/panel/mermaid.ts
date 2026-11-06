import DOMPurify from 'dompurify'

// Load the bundled renderer only when a message actually contains a diagram.
const loadMermaid = () => import('mermaid').then(({ default: mermaid }) => {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    maxEdges: 500,
    theme: 'default',
    fontFamily: 'Arial, sans-serif',
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering',
      'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'themeVariables',
      'fontFamily', 'htmlLabels', 'flowchart', 'dompurifyConfig'],
  })
  return mermaid
})
let renderer: ReturnType<typeof loadMermaid> | undefined

/** Enhance trusted Markdown placeholders, keeping source readable on failure. */
export async function renderMermaidDiagrams(root: HTMLElement, isCurrent: () => boolean, zh: boolean): Promise<void> {
  const diagrams = [...root.querySelectorAll<HTMLElement>('[data-mermaid-source]')]
  if (!diagrams.length) return
  try {
    const mermaid = await (renderer ??= loadMermaid().catch(error => { renderer = undefined; throw error }))
    for (const diagram of diagrams) {
      if (!isCurrent()) return
      if (diagram.querySelector(':scope > img')) continue
      const source = diagram.dataset.mermaidSource ?? ''
      if (source.length > 50_000) continue
      // Mermaid measures text in a live DOM. Its scratch markup stays offscreen
      // and is removed on both success and failure, including cancelled streams.
      const host = document.createElement('div')
      host.className = 'mermaid-render-host'
      document.body.append(host)
      try {
        const { svg } = await mermaid.render(`mermaid-${crypto.randomUUID()}`, source, host)
        if (!isCurrent()) return
        const safeSvg = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ['foreignObject', 'a', 'image', 'use'],
          FORBID_ATTR: ['href', 'xlink:href'],
        })
        const parsed = new DOMParser().parseFromString(safeSvg, 'image/svg+xml').documentElement
        if (parsed.localName !== 'svg') continue
        const image = document.createElement('img')
        // SVG images isolate diagram CSS and disable scripts/external resources.
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safeSvg)}`
        image.alt = zh ? 'Mermaid 图表' : 'Mermaid diagram'
        const width = Number(parsed.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2])
        if (Number.isFinite(width) && width > 0) image.width = Math.ceil(width)
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = zh ? '查看图表源码' : 'View diagram source'
        details.append(summary, ...diagram.childNodes)
        diagram.replaceChildren(image, details)
      } catch {
        // Invalid or unsupported diagrams keep the original escaped code block.
      } finally {
        host.remove()
      }
    }
  } catch {
    // A loading failure must not break the rest of the conversation.
  }
}
