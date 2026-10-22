// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/panel/markdown.ts'

describe('renderMarkdown', () => {
  it('renders common markdown constructs', () => {
    const html = renderMarkdown('# 标题\n\n**加粗** 和 `code`\n\n- 甲\n- 乙\n\n> 引用')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>甲</li>')
    expect(html).toContain('<blockquote>')
  })

  it('renders GFM tables and fenced code blocks', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('<pre><code')
    expect(html).toContain('const x = 1')
  })

  it('breaks single newlines into <br> (chat-style text)', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br>')
  })

  it('strips scripts and event handlers (XSS defense)', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src="x" onerror="alert(1)">\n\n**ok**')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).toContain('<strong>ok</strong>')
  })

  it('strips active and layout-altering raw HTML', () => {
    const html = renderMarkdown('<form action="https://evil.example"><button style="position:fixed;inset:0">伪装界面</button></form><img src="https://evil.example/leak">')
    expect(html).toContain('伪装界面')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.example')
  })

  it('opens http(s) links in a new tab and drops javascript: hrefs', () => {
    const html = renderMarkdown('[官网](https://deepseek.com) [坏链](javascript:alert(1)) [邮件](mailto:a@example.com) [相对路径](/panel)')
    expect(html).toContain('href="https://deepseek.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('mailto:')
    expect(html).not.toContain('href="/panel"')
  })

  it('handles empty and plain input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('plain text')).toContain('plain text')
  })

  it('turns assistant local file links into download actions without allowing file navigation', () => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown('[下载长图](/Users/me/workspace/output/数学学习-长图.png)', { artifactLinks: true })
    const link = root.querySelector('a')!
    expect(link.textContent).toBe('下载长图')
    expect(link.getAttribute('href')).toBe('#')
    expect(link.dataset.artifactPath).toBe('/Users/me/workspace/output/数学学习-长图.png')
    expect(link.hasAttribute('target')).toBe(false)
    expect(renderMarkdown('[文件](/Users/me/output.png)')).not.toContain('data-artifact-path')
  })

  it('supports encoded file paths, sandbox and relative output links while keeping raw HTML inert', () => {
    for (const href of ['file:///Users/me/output/long%20image.png', 'sandbox:/mnt/data/long.png', 'output/long.png', 'C:/work/output/long.png']) {
      expect(renderMarkdown(`[下载](${href})`, { artifactLinks: true })).toContain('data-artifact-path=')
    }
    const html = renderMarkdown('<a href="file:///etc/passwd" data-artifact-path="/etc/passwd">fake</a> [bad](javascript:alert(1))', { artifactLinks: true })
    expect(html).not.toContain('data-artifact-path')
    expect(html).not.toContain('file:///')
    expect(html).not.toContain('javascript:')
  })

  it('renders inline and display LaTeX without Markdown consuming commands', () => {
    const html = renderMarkdown(String.raw`行内 \(CH_3SH\) 和 $x^2$。
\[
M=16+4\times1+32=52\ \mathrm{g/mol}
\]
$$n=\frac{2.4}{52}\ \mathrm{mol}$$`)
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelectorAll('.katex')).toHaveLength(4)
    expect(root.querySelectorAll('.math-block')).toHaveLength(2)
    expect(root.querySelectorAll('math')).toHaveLength(4)
    expect(root.querySelector('annotation')?.textContent).toBe('CH_3SH')
    expect(root.querySelector('.mfrac')).not.toBeNull()
    expect(root.querySelector('.math-fallback')).toBeNull()
  })

  it('renders the reported Tandix chemistry output and repairs its continuation escapes', () => {
    const html = renderMarkdown(String.raw`\
以下按试卷给定的 **H＝1、C＝16、S＝32** 解答。
答案依次为：**第 1 题见方程式；第 2 题 B；第 3 题 D；第 4 题 C；第 5 题 1076 kJ；第 6 题 C；第 7 题 CD。**
**1．甲硫醇燃烧的热化学方程式**
先计算甲硫醇 CH₃SH 的摩尔质量：
[\
M=16+4\times1+32=52\ \mathrm{g/mol}\
]
2.4 g 甲硫醇的物质的量为：
[\
n=\frac{2.4}{52}\ \mathrm{mol}\
]
这部分甲硫醇燃烧放热 52.42 kJ，所以 **1 mol 甲硫醇完全燃烧**的放热量为：
[\
Q=\frac{52.42}{2.4/52}\
\=1135.77\ \mathrm{kJ}\
]`)
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelectorAll('.katex')).toHaveLength(3)
    expect(root.querySelectorAll('.math-block')).toHaveLength(3)
    expect(root.querySelector('.math-fallback')).toBeNull()
    const formulas = [...root.querySelectorAll('annotation')].map(node => node.textContent)
    expect(formulas).toEqual([
      String.raw`M=16+4\times1+32=52\ \mathrm{g/mol}`,
      String.raw`n=\frac{2.4}{52}\ \mathrm{mol}`,
      String.raw`Q=\frac{52.42}{2.4/52}
=1135.77\ \mathrm{kJ}`,
    ])
    expect(html).toContain('<strong>1 mol 甲硫醇完全燃烧</strong>')
  })

  it('supports standalone bare brackets with TeX and preserves aligned line breaks', () => {
    const html = renderMarkdown(String.raw`[
\begin{aligned}a&=1\\
b&=2\end{aligned}
]`)
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('math-fallback')
    expect(html).toContain(String.raw`a&amp;=1\\`)
  })

  it('supports chemistry notation, formulas in lists, and display formulas within prose', () => {
    const html = renderMarkdown(String.raw`- 反应：\(\ce{CH3SH + 3O2 -> CO2 + 2H2O + SO2}\)
- 结果：\[x=1\] 完成`)
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelectorAll('li .katex')).toHaveLength(2)
    expect(root.querySelector('.math-fallback')).toBeNull()
  })

  it('leaves code, currency, ordinary brackets and links unchanged', () => {
    const html = renderMarkdown(String.raw`价格 $20 和 $30，转义 \$40。 [官网](https://example.com)
普通 [方括号] 和
[
普通文本
]
行内代码：\`\(x^2\)\` 和 \`$x$\`

~~~tex
\[x^2\]
[\
\frac{1}{2}\
]
~~~

<pre><code>\(x\)</code></pre>` .replaceAll('\\`', '`'))
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$20 和 $30')
    expect(html).toContain('$40')
    expect(html).toContain('[方括号]')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain(String.raw`<code>\(x^2\)</code>`)
    expect(html).toContain('<code>$x$</code>')
  })

  it('keeps incomplete streamed math readable, then renders when closed', () => {
    const incomplete = String.raw`结果：\(\frac{1}{2}`
    expect(renderMarkdown(incomplete)).not.toContain('class="katex"')
    expect(renderMarkdown(incomplete + String.raw`\)`)).toContain('class="katex"')
    const malformed = renderMarkdown(String.raw`\(\frac{<img src=x onerror=alert(1)>}\)`)
    expect(malformed).toContain('math-fallback')
    expect(malformed).not.toContain('<img')
    expect(malformed).toContain('&lt;img')
  })

  it('does not enable HTML injection or resource-loading TeX commands', () => {
    const html = renderMarkdown(String.raw`\(\href{javascript:alert(1)}{click}\)
\(\includegraphics{https://evil.example/leak}\)
\(\htmlStyle{position:fixed;inset:0}{fake}\)
<span class="katex" style="position:fixed">raw html</span>
<svg onload="alert(1)"></svg>`)
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=')
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelector('[style*="position:fixed"]')).toBeNull()
    expect(html).not.toContain('onload')
    expect(html).toContain('raw html')
  })
})
