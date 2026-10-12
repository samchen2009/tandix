/** Short conversation titles from the user's words, excluding injected browser context. */

function conciseTitle(text) {
  if (typeof text !== 'string' || text.startsWith('Browser context after tab handoff (untrusted):')
    || text.startsWith('<USER_ATTACHMENT')) return null
  const line = text.split(/\r?\n/u).map(part => part.replace(/\s+/gu, ' ').trim())
    .find(part => part !== '' && !part.startsWith('```'))
  if (line === undefined) return null
  const points = [...line]
  return points.length > 56 ? `${points.slice(0, 56).join('').trimEnd()}…` : line
}

function genericPrompt(title) {
  return /^(请先概览当前页面|First give me an overview of the current page)/iu.test(title)
    || /^(好(?:的)?|可以|继续|确认|收到|谢谢|ok|yes|go ahead)[.!。！\s]*$/iu.test(title)
}

/** `thread/turns/list` with descending turns and full items. */
export function titleFromCodexTurns(turns) {
  let fallback = null
  for (const turn of turns ?? []) {
    for (const item of turn?.items ?? []) {
      if (item?.type !== 'userMessage') continue
      // Tandix puts a browser snapshot before the actual user text in one item.
      for (const part of [...(item.content ?? [])].reverse()) {
        if (part?.type !== 'text') continue
        const title = conciseTitle(part.text)
        if (title === null) continue
        if (genericPrompt(title)) fallback ??= title
        else return title
      }
    }
  }
  return fallback
}
