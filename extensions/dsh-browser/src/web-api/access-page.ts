import './access.css'

const requestId = new URLSearchParams(location.search).get('request')
const status = document.querySelector<HTMLElement>('#status')!
async function send(action: string, extra = {}): Promise<{ origins: string[]; requestedOrigin: string | null }> {
  const response = await chrome.runtime.sendMessage({ type: 'tandix-web-access', action, requestId, ...extra })
  if (!response?.ok) throw new Error(response?.error ?? '无法连接 Tandix 后台')
  return response.result
}
async function refresh(): Promise<void> {
  const state = await send('get')
  document.querySelector<HTMLElement>('#request')!.hidden = !state.requestedOrigin
  document.querySelector<HTMLElement>('#origin')!.textContent = state.requestedOrigin
  const list = document.querySelector('#origins')!
  list.replaceChildren()
  for (const origin of state.origins) {
    const item = document.createElement('li')
    const text = document.createElement('span'); text.textContent = origin
    const button = document.createElement('button'); button.textContent = '撤销'
    button.onclick = () => { void act(async () => { await send('revoke', { origin }); await refresh() }) }
    item.append(text, button); list.append(item)
  }
  if (!state.origins.length) list.textContent = '尚未授权任何站点。'
  if (requestId && !state.requestedOrigin) status.textContent ||= '此授权请求已处理或已过期。'
}
async function act(action: () => Promise<void>): Promise<void> {
  try { await action() } catch (error) { status.textContent = error instanceof Error ? error.message : '操作失败' }
}
for (const [selector, allow] of [['#allow', true], ['#deny', false]] as const) {
  document.querySelector<HTMLButtonElement>(selector)!.onclick = () => { void act(async () => {
    await send('decide', { allow }); status.textContent = allow ? '已授权，可返回原网页继续。' : '已拒绝。'; await refresh()
  }) }
}
void act(refresh)
