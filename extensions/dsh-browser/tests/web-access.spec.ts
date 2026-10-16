// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { WebAccess } from '../src/background/web-access.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('only the trusted extension page can grant access, and revocation cancels site clients', async () => {
  const listeners: Array<(message: unknown, sender: chrome.runtime.MessageSender, respond: (value: any) => void) => unknown> = []
  const stored: Record<string, unknown> = {}
  const create = vi.fn(async () => ({}))
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`,
      onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) } },
    storage: { local: { get: async () => stored, set: async (items: object) => { Object.assign(stored, items) } } },
    tabs: { create },
  })
  const revoke = vi.fn()
  const access = new WebAccess(revoke); access.install()
  expect(await access.allowed('https://app.example')).toBe(false)
  const authorization = access.authorize('https://app.example')
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  const url = new URL((create.mock.calls as any)[0][0].url)
  const requestId = url.searchParams.get('request')
  const fakeResponse = vi.fn()
  listeners[0]!({ type: 'tandix-web-access', action: 'decide', requestId, allow: true },
    { url: 'https://app.example/fake', id: 'extension' }, fakeResponse)
  expect(fakeResponse).not.toHaveBeenCalled()
  expect(await access.allowed('https://app.example')).toBe(false)
  const send = (action: string, params = {}) => new Promise<any>(resolve => listeners[0]!({ type: 'tandix-web-access', action, requestId, ...params },
    { url: url.href, id: 'extension' }, resolve))
  expect((await send('get')).result.requestedOrigin).toBe('https://app.example')
  expect((await send('decide', { allow: true })).ok).toBe(true)
  await expect(authorization).resolves.toBe(true)
  expect(await access.allowed('https://app.example')).toBe(true)
  expect(await access.allowed('https://other.app.example')).toBe(false)
  await send('revoke', { origin: 'https://app.example' })
  expect(revoke).toHaveBeenCalledWith('https://app.example')
  expect(await access.allowed('https://app.example')).toBe(false)
})
