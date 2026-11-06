/**
 * Markdown → sanitized HTML for conversation bubbles.
 *
 * Model and user text is untrusted: the rendered output goes through
 * DOMPurify before touching the DOM, and http(s) links are forced to open in
 * a new tab (the side panel must never navigate away from the chat).
 *
 * @module
 */

import DOMPurify, { type Config } from 'dompurify'
import { Marked } from 'marked'
import katex from 'katex'
import 'katex/contrib/mhchem'
import { mathExtensions } from './math.ts'
import { isLocalArtifactLink } from './artifacts.ts'

const MARKDOWN_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: [
    'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody',
    'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['align', 'href', 'start', 'title'],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
} satisfies Config

/**
 * Render markdown source to sanitized HTML safe for `innerHTML`.
 *
 * @param source - markdown text (may be empty)
 * @returns sanitized HTML fragment
 */
export function renderMarkdown(source: string, { artifactLinks = false } = {}): string {
  const generatedNodes = new Map<string, HTMLElement>()
  const nonce = crypto.randomUUID()
  const placeholder = (node: HTMLElement): string => {
    const key = `${nonce}:${generatedNodes.size}`
    generatedNodes.set(key, node)
    return `<code>${key}</code>`
  }
  const marked = new Marked({ gfm: true, breaks: true })
  marked.use({ renderer: {
    code({ text, lang, raw }) {
      const language = lang?.trim().split(/\s/)[0].toLowerCase() ?? ''
      // Models sometimes label flowcharts as CSS. Only infer diagrams from
      // unmistakable headers in unlabeled/CSS fences; leave real code alone.
      const flowchart = /^(?:\s*%%[^\n]*\n)*\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/.test(text)
      if (language !== 'mermaid' && !((language === '' || language === 'css') && flowchart)) return false
      const fence = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1]
      if (!fence || !new RegExp(`\\n[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`).test(raw.trimEnd())) return false
      const node = document.createElement('div')
      node.className = 'mermaid-diagram'
      node.dataset.mermaidSource = text
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = text
      pre.append(code)
      node.append(pre)
      return placeholder(node)
    },
  } })
  if (artifactLinks) marked.use({ renderer: {
    link({ href, tokens }) {
      if (!isLocalArtifactLink(href)) return false
      const node = document.createElement('a')
      node.href = '#'
      node.dataset.artifactPath = href
      node.innerHTML = DOMPurify.sanitize(this.parser.parseInline(tokens), MARKDOWN_SANITIZE_OPTIONS)
      return placeholder(node)
    },
  } })
  marked.use({ extensions: mathExtensions((text, displayMode) => {
    const node = document.createElement('span')
    node.className = displayMode ? 'math-block' : 'math-inline'
    try {
      const mathHtml = katex.renderToString(text, {
        displayMode, throwOnError: true, trust: false, strict: 'ignore',
        maxSize: 20, maxExpand: 1000,
      })
      node.innerHTML = DOMPurify.sanitize(mathHtml, {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        ADD_TAGS: ['semantics', 'annotation'],
        ADD_ATTR: ['encoding'],
        FORBID_TAGS: ['a', 'img', 'style'],
        FORBID_ATTR: ['href', 'src', 'xlink:href'],
      })
    } catch {
      // Incomplete streamed or unsupported formulas remain readable.
      node.classList.add('math-fallback')
      node.textContent = text
    }
    // Keep the Markdown allowlist strict. Only locally generated, unguessable
    // placeholders are replaced with separately sanitized KaTeX markup.
    return placeholder(node)
  }) })
  const html = marked.parse(source ?? '', { async: false }) as string
  const template = document.createElement('template')
  template.innerHTML = DOMPurify.sanitize(html, MARKDOWN_SANITIZE_OPTIONS)
  for (const code of template.content.querySelectorAll('code')) {
    const generated = generatedNodes.get(code.textContent ?? '')
    if (generated) code.replaceWith(generated)
  }
  for (const link of template.content.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noreferrer noopener')
    }
  }
  return template.innerHTML
}
