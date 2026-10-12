// @vitest-environment jsdom
// Codex plugin installation interactions.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexCapabilities } from '../src/panel/CodexCapabilities.tsx'
import type { PanelApi } from '../src/panel/api.ts'

const plugins = ['gmail', 'github'].map(name => ({
  id: name, name, marketplace: 'catalog', marketplacePath: null,
  remoteMarketplaceName: 'catalog', installed: false, enabled: false,
  availability: 'AVAILABLE', description: `${name} integration`,
}))

const inventory = {
  codexHome: '/tmp/codex', skills: [], skillErrors: [], mcpServers: [], plugins, errors: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('Codex plugin installation feedback', () => {
  let root: Root

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.restoreAllMocks()
  })

  async function render(install: (name: string) => Promise<unknown>): Promise<void> {
    const api = {
      rpc: vi.fn((method: string, payload?: { name?: string }) => method === 'codex.capabilities'
        ? Promise.resolve(inventory) : install(payload?.name ?? '')),
      onEvent: () => () => {},
    } as unknown as PanelApi
    await act(async () => { root.render(createElement(CodexCapabilities, {
      api, sessionId: 'session-one', locale: 'zh',
    })) })
  }

  it('animates only the selected plugin and keeps success visible after refresh', async () => {
    const gmail = deferred<unknown>()
    await render(name => name === 'gmail' ? gmail.promise : Promise.resolve({ appsNeedingAuth: [{}] }))

    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="安装 gmail"]')!.click() })
    const gmailRow = document.querySelector<HTMLElement>('.codex-plugin-item')!
    expect(gmailRow.getAttribute('aria-busy')).toBe('true')
    expect(gmailRow.querySelector('.codex-plugin-spinner')).not.toBeNull()
    expect(gmailRow.textContent).toContain('正在安装')
    expect(document.querySelector<HTMLButtonElement>('[aria-label="安装 github"]')?.disabled).toBe(false)

    await act(async () => { gmail.resolve({}); await gmail.promise })
    expect(gmailRow.textContent).toContain('安装完成')
    expect(gmailRow.querySelector('[aria-label="已安装"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[aria-label="安装 github"]')?.disabled).toBe(false)

    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="安装 github"]')!.click() })
    expect(document.querySelectorAll<HTMLElement>('.codex-plugin-item')[1]?.textContent).toContain('还需连接账号')
  })

  it('shows a local failure and lets that plugin retry', async () => {
    let attempts = 0
    await render(async name => {
      if (name === 'gmail' && ++attempts === 1) throw new Error('Network unavailable')
      return {}
    })

    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="安装 gmail"]')!.click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable')
    expect(document.querySelector<HTMLButtonElement>('[aria-label="重试安装 gmail"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[aria-label="安装 github"]')?.disabled).toBe(false)

    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="重试安装 gmail"]')!.click() })
    expect(document.querySelector('.codex-plugin-item [aria-label="已安装"]')).not.toBeNull()
  })

  it('opens Feishu device authorization without passing credentials or device codes through the panel', async () => {
    const createTab = vi.fn(async () => ({}))
    vi.stubGlobal('chrome', { tabs: { create: createTab } })
    const rpc = vi.fn(async (method: string) => {
      if (method === 'codex.capabilities') return { ...inventory, skills: [{
        name: 'lark-doc', description: 'Feishu Docs', path: '/skills/lark-doc/SKILL.md',
        scope: 'repo', enabled: true, pluginId: null,
      }] }
      if (method === 'codex.lark.status') return { state: 'login-required' }
      if (method === 'codex.lark.login.start') return {
        authorizationUrl: 'https://open.feishu.cn/auth/example',
        qrCodeDataUrl: 'data:image/png;base64,AQID', expiresIn: 600,
      }
      if (method === 'codex.lark.login.complete') return { state: 'connected', userName: 'Test User' }
      throw new Error(`Unexpected method ${method}`)
    })
    const api = { rpc, onEvent: () => () => {} } as unknown as PanelApi
    await act(async () => { root.render(createElement(CodexCapabilities, {
      api, sessionId: 'session-one', locale: 'zh',
    })) })

    await act(async () => { document.querySelector<HTMLButtonElement>('.codex-lark-login button')!.click() })
    expect(createTab).toHaveBeenCalledWith({ url: 'https://open.feishu.cn/auth/example' })
    expect(document.querySelector<HTMLImageElement>('.codex-lark-authorization img')?.src)
      .toBe('data:image/png;base64,AQID')
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('device_code')

    await act(async () => { document.querySelector<HTMLButtonElement>('.codex-lark-authorization button')!.click() })
    expect(document.querySelector('.codex-lark-login')?.textContent).toContain('已连接')
    expect(document.querySelector('.codex-lark-authorization')).toBeNull()
    vi.unstubAllGlobals()
  })
})
