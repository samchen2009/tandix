import type { TokenizerAndRendererExtension, Tokens } from 'marked'

type MathToken = Tokens.Generic & { text: string; displayMode: boolean }

function token(raw: string, text: string, displayMode: boolean): MathToken {
  return { type: displayMode ? 'displayMath' : 'inlineMath', raw, text: text.trim(), displayMode }
}

/** Find a closing delimiter without treating escaped dollars as delimiters. */
function delimited(source: string, open: string, close: string, displayMode: boolean): MathToken | undefined {
  if (!source.startsWith(open)) return
  for (let end = open.length; end < source.length; end++) {
    if (!displayMode && /[\r\n]/.test(source[end])) return
    if (source[end] === '\\' && !source.startsWith(close, end)) {
      end++
      continue
    }
    if (!source.startsWith(close, end)) continue
    const text = source.slice(open.length, end)
    // Keep prices such as "$20 and $30" and whitespace-padded dollars as text.
    if (open === '$' && (!text || /^\s|\s$/.test(text) || /\d/.test(source[end + 1] ?? ''))) return
    if (!text.trim()) return
    return token(source.slice(0, end + close.length), text, displayMode)
  }
}

function displayMath(source: string): MathToken | undefined {
  const indent = /^ {0,3}/.exec(source)![0]
  const rest = source.slice(indent.length)
  for (const [open, close] of [['\\[', '\\]'], ['$$', '$$']]) {
    const math = delimited(rest, open, close, true)
    if (!math) continue
    const ending = /^[ \t]*(?:\r?\n|$)/.exec(rest.slice(math.raw.length))
    if (ending) return { ...math, raw: indent + math.raw + ending[0] }
  }

  // Some model outputs lose the backslashes on \[ and \], and add a
  // single continuation backslash to each line. Only repair standalone
  // bracket blocks containing TeX commands; ordinary brackets stay Markdown.
  const legacy = /^\[\\?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\][ \t]*(?:\r?\n|$)/.exec(rest)
  if (!legacy || !/\\[a-zA-Z]+/.test(legacy[1])) return
  const text = legacy[1]
    .replace(/(?<!\\)\\[ \t]*(?=\r?\n|$)/g, '')
    .replace(/(?<!\\)\\=/g, '=')
  return token(indent + legacy[0], text, true)
}

/** Tokenize before Markdown escapes TeX, while leaving code tokens untouched. */
export function mathExtensions(render: (text: string, displayMode: boolean) => string): TokenizerAndRendererExtension[] {
  return [
    {
      name: 'displayMath',
      level: 'block',
      start(source) {
        return /^ {0,3}(?:\\\[|\$\$|\[\\?[ \t]*$)/m.exec(source)?.index
      },
      tokenizer(source) { return displayMath(source) },
      renderer(math) { return render(math.text, true) + '\n' },
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(source) { return /\\[([]|\$/.exec(source)?.index },
      tokenizer(source) {
        if (this.lexer.state.inRawBlock) return
        for (const [open, close, displayMode] of [
          ['\\(', '\\)', false], ['\\[', '\\]', true], ['$$', '$$', true], ['$', '$', false],
        ] as const) {
          const math = delimited(source, open, close, displayMode)
          if (math) return { ...math, type: 'inlineMath' }
        }
      },
      renderer(math) { return render(math.text, math.displayMode) },
    },
  ]
}
