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
export function renderMarkdown(source: string): string {
  const mathNodes = new Map<string, HTMLSpanElement>()
  const nonce = crypto.randomUUID()
  const marked = new Marked({ gfm: true, breaks: true })
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
    const key = `${nonce}:${mathNodes.size}`
    mathNodes.set(key, node)
    // Keep the Markdown allowlist strict. Only locally generated, unguessable
    // placeholders are replaced with separately sanitized KaTeX markup.
    return `<code>${key}</code>`
  }) })
  const html = marked.parse(source ?? '', { async: false }) as string
  const template = document.createElement('template')
  template.innerHTML = DOMPurify.sanitize(html, MARKDOWN_SANITIZE_OPTIONS)
  for (const code of template.content.querySelectorAll('code')) {
    const math = mathNodes.get(code.textContent ?? '')
    if (math) code.replaceWith(math)
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
