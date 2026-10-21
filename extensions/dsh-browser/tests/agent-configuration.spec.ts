// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentConfiguration, dshConfiguration, type AgentConfigurationSnapshot } from '../src/panel/AgentConfiguration.tsx'
import type { PanelApi } from '../src/panel/api.ts'

let root: Root
beforeEach(() => { document.body.innerHTML = '<div id="root"></div>'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); root = createRoot(document.querySelector('#root')!) })
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks() })
const snapshot = (sessionId: string, model: string): AgentConfigurationSnapshot => ({ backend: 'codex', sessionId, source: 'session', modelId: model, modelLabel: model })

it('dsh distinguishes the next session selection, global default and last used model', () => {
  const defaults = { namespaces: [{ ns: 'agent-default-model', value: { model: 'default-model', provider: 'p', apiKey: 'private' } }] }
  const selected = dshConfiguration('s', { next: { model: 'next-model', reasoningEffort: 'high' }, lastUsed: { model: 'previous-model' } }, defaults)
  expect(selected).toMatchObject({ source: 'session', modelId: 'next-model', reasoningEffort: 'high', lastUsed: 'previous-model' })
  expect(dshConfiguration('s', null, defaults)).toMatchObject({ source: 'default', modelId: 'default-model' })
  expect(dshConfiguration('s', null, {})).toMatchObject({ source: 'unavailable', modelId: null })
  expect(JSON.stringify(selected)).not.toContain('private')
})
it('late configuration replies never replace the newly selected session', async () => {
  let resolveOld: ((value: AgentConfigurationSnapshot) => void) | undefined
  const rpc = vi.fn((_: string, payload: any) => payload.sessionId === 'old'
    ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(snapshot('new', 'new-model')))
  const api = { rpc } as unknown as PanelApi
  const render = (id: string) => root.render(createElement(AgentConfiguration, { api, backend: 'codex', sessionId: id, connected: true, working: false, selection: null, revision: 0, locale: 'zh' }))
  await act(async () => render('old'))
  await act(async () => render('new'))
  expect(document.querySelector('.model-name')?.textContent).toBe('new-model')
  await act(async () => resolveOld?.(snapshot('old', 'old-model')))
  expect(document.querySelector('.model-name')?.textContent).toBe('new-model')
})
it('a disconnected panel clears its previous model and reports failures without guessing', async () => {
  const api = { rpc: vi.fn(async () => snapshot('s', 'live-model')) } as unknown as PanelApi
  const render = (connected: boolean) => root.render(createElement(AgentConfiguration, { api, backend: 'codex', sessionId: 's', connected, working: false, selection: null, revision: 0, locale: 'zh' }))
  await act(async () => render(true))
  expect(document.querySelector('.model-name')?.textContent).toBe('live-model')
  await act(async () => render(false))
  expect(document.querySelector('.model-name')?.textContent).toBe('未连接')
  api.rpc = vi.fn(async () => { throw new Error('unsupported RPC') })
  await act(async () => render(true))
  expect(document.querySelector('.model-name')?.textContent).toBe('配置未提供')
})
it('Cursor auto and saved configuration are labelled explicitly in the popover', async () => {
  const api = { rpc: vi.fn(async () => ({ backend: 'cursor', sessionId: 's', source: 'last-known', modelId: 'default', modelLabel: 'auto' })) } as unknown as PanelApi
  await act(async () => root.render(createElement(AgentConfiguration, { api, backend: 'cursor', sessionId: 's', connected: true, working: false, selection: null, revision: 0, locale: 'zh' })))
  await act(async () => document.querySelector<HTMLButtonElement>('.model-trigger')!.click())
  expect(document.querySelector('.config-source')?.textContent).toContain('历史配置')
  expect(document.querySelector('.agent-config-popover')?.textContent).toContain('实际调用的模型可能不会返回')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('.agent-config-popover')).toBeNull()
})
it('a runtime response belonging to another session is rejected', async () => {
  const api = { rpc: vi.fn(async () => snapshot('foreign', 'wrong-model')) } as unknown as PanelApi
  await act(async () => root.render(createElement(AgentConfiguration, { api, backend: 'codex', sessionId: 'owned', connected: true, working: false, selection: null, revision: 0, locale: 'zh' })))
  expect(document.body.textContent).not.toContain('wrong-model')
  expect(document.querySelector('.model-name')?.textContent).toBe('配置未提供')
})

const renderEditor = async (api: PanelApi, extra: Record<string, unknown> = {}) => {
  await act(async () => root.render(createElement(AgentConfiguration, { api, backend: 'codex', sessionId: 's', connected: true, working: false, selection: null, revision: 0, locale: 'zh', ...extra })))
  await act(async () => document.querySelector<HTMLButtonElement>('.model-trigger')!.click())
}
const select = async (label: string, value: string) => act(async () => {
  const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }))
})
it('applies model and reasoning to the current chat and shows confirmation only after success', async () => {
  let complete: ((value: unknown) => void) | undefined
  const rpc = vi.fn(async (method: string) => {
    if (method === 'agent.models') return { models: [{ id: 'old', label: 'Old', efforts: ['low'], defaultEffort: 'low' }, { id: 'new', label: 'New', efforts: ['high'], defaultEffort: 'high' }] }
    if (method === 'agent.configuration.set') return new Promise(resolve => { complete = resolve })
    return snapshot('s', 'old')
  })
  const onBusyChange = vi.fn()
  await renderEditor({ rpc } as unknown as PanelApi, { onBusyChange })
  await select('设置模型', JSON.stringify(['', 'new']))
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="设置推理强度"]')?.value).toBe('high')
  await act(async () => document.querySelector<HTMLButtonElement>('.model-settings-save')!.click())
  expect(rpc).toHaveBeenCalledWith('agent.configuration.set', { sessionId: 's', model: 'new', reasoningEffort: 'high' })
  expect(document.querySelector('.model-settings-save')?.textContent).toBe('正在应用…')
  expect(document.querySelector('.model-save-success')).toBeNull()
  await act(async () => complete?.({ ...snapshot('s', 'new'), saved: true, source: 'next-turn', reasoningEffort: 'high' }))
  expect(document.querySelector('.model-save-success')?.textContent).toContain('下一条消息')
  expect(document.querySelector('.model-name')?.textContent).toBe('new')
  expect(onBusyChange.mock.calls).toEqual([[true], [false]])
})
it('keeps model providers distinct for dsh and uses its native session setter', async () => {
  const onModelSelected = vi.fn()
  const rpc = vi.fn(async (method: string, payload: any) => {
    if (method === 'settings.describe') return { namespaces: [{ ns: 'agent-default-model', value: { provider: 'p1', model: 'shared' } }] }
    if (method === 'session.modelCatalog') return { routableProviders: ['p1', 'p2'], groups: ['p1', 'p2'].map(id => ({ id, models: [{ id: 'shared', name: 'Shared' }] })) }
    if (method === 'session.selectModel') return { selected: { provider: payload.provider, model: payload.model } }
    throw new Error('Unexpected request')
  })
  await renderEditor({ rpc } as unknown as PanelApi, { backend: 'dsh', onModelSelected })
  await select('设置模型', JSON.stringify(['p2', 'shared']))
  await act(async () => document.querySelector<HTMLButtonElement>('.model-settings-save')!.click())
  expect(rpc).toHaveBeenCalledWith('session.selectModel', { sessionId: 's', provider: 'p2', model: 'shared' })
  expect(onModelSelected).toHaveBeenCalledWith({ provider: 'p2', model: 'shared' })
  expect(rpc.mock.calls.some(([method]) => method.startsWith('settings.') && method !== 'settings.describe')).toBe(false)
})
it('reports rejected settings and disables applying during a running turn', async () => {
  const rpc = vi.fn(async (method: string) => {
    if (method === 'agent.models') return { models: [{ id: 'old', label: 'Old', efforts: [] }] }
    if (method === 'agent.configuration.set') throw new Error('Runtime refused the selection')
    return snapshot('s', 'old')
  })
  const api = { rpc } as unknown as PanelApi
  await renderEditor(api)
  await act(async () => document.querySelector<HTMLButtonElement>('.model-settings-save')!.click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Runtime refused')
  expect(document.querySelector('.model-save-success')).toBeNull()
  await act(async () => root.render(createElement(AgentConfiguration, { api, backend: 'codex', sessionId: 's', connected: true, working: true, selection: null, revision: 0, locale: 'zh' })))
  expect(document.querySelector<HTMLButtonElement>('.model-settings-save')?.disabled).toBe(true)
})

it('always exposes the settings entry even while the catalog is unavailable', async () => {
  const onConfigure = vi.fn()
  const rpc = vi.fn(async (method: string) => {
    if (method === 'agent.models') throw new Error('Catalog unavailable')
    return snapshot('s', 'old')
  })
  await renderEditor({ rpc } as unknown as PanelApi, { onConfigure })
  const configure = document.querySelector<HTMLButtonElement>('.configure-model-button')!
  expect(configure.textContent).toBe('设置模型')
  expect(configure.disabled).toBe(false)
  await act(async () => configure.click())
  expect(onConfigure).toHaveBeenCalledOnce()
})
