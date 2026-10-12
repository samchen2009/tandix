// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillToolService } from '../src/background/skill-tools.ts'

describe('Tandix skill tool authorization and receipt', () => {
  let store: Record<string, unknown>
  let tools: SkillToolService

  beforeEach(() => {
    store = {}
    tools = new SkillToolService()
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, values) }),
    } } })
  })

  it('does not save without an explicit same-session grant', async () => {
    const call = { id: 'call-1', name: 'tandix_skill_save', sessionId: 'session-two',
      args: { name: '周报', description: '写周报', instructions: '核对数据' } }
    tools.authorizeSave('session-one')
    const result = await tools.dispatch(call, new AbortController().signal, vi.fn())
    expect(result.ok).toBe(false)
    expect(store['tandix.managed-skills.v1']).toBeUndefined()
  })

  it('accepts a save during the prompt before its RPC acknowledgement, but not after revocation', async () => {
    const call = { id: 'call-early', name: 'tandix_skill_save', sessionId: 'session-one',
      args: { name: '周报', description: '写周报', instructions: '核对数据' } }
    tools.authorizeSave('session-one')
    expect((await tools.dispatch(call, new AbortController().signal, vi.fn())).ok).toBe(true)
    tools.authorizeSave('session-one')
    tools.revokeSave('session-one')
    expect((await tools.dispatch(call, new AbortController().signal, vi.fn())).ok).toBe(false)
  })

  it('saves once, verifies persistence, and makes the skill listable and readable', async () => {
    const call = { id: 'call-1', name: 'tandix_skill_save', sessionId: 'session-one',
      args: { name: '周报', description: '写周报', instructions: '核对数据' } }
    const commit = vi.fn()
    tools.authorizeSave('session-one')
    const saved = await tools.dispatch(call, new AbortController().signal, commit)
    expect(saved.ok).toBe(true)
    expect(JSON.parse((saved.result as { text: string }).text)).toMatchObject({
      saved: true, name: '周报', location: 'Tandix > Skills > Tandix skills',
    })
    expect(commit).toHaveBeenCalledOnce()
    const list = await tools.dispatch({ id: 'call-2', name: 'tandix_skill_list', args: {} }, new AbortController().signal, vi.fn())
    expect(JSON.parse((list.result as { text: string }).text)[0].name).toBe('周报')
    const read = await tools.dispatch({ id: 'call-3', name: 'tandix_skill_read', args: { name: '周报' } }, new AbortController().signal, vi.fn())
    expect(JSON.parse((read.result as { text: string }).text).instructions).toBe('核对数据')
    expect((await tools.dispatch(call, new AbortController().signal, vi.fn())).ok).toBe(false)
  })
})
