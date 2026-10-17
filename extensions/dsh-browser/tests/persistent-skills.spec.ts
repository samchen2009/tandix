// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadManagedSkills, MANAGED_SKILLS_STORAGE_KEY, saveManagedSkill } from '../src/skill/managed-skill.ts'
import { CHAT_SKILLS_STORAGE_KEY, deleteChatSkill, loadChatSkills, type ChatSkill } from '../src/skill/chat-skill.ts'

const managed = { id: 'one', name: '周报', description: '每周使用', instructions: '核对资料', sourceSessionId: 's', createdAt: 1, updatedAt: 2 }
const chat: ChatSkill = { id: 'browser', name: '查询', schemaVersion: 'tandix.agent-skill/v1', version: 1,
  goal: '查询列表', success: '显示列表', steps: ['查询'], parameters: [], allowedOrigins: [], sourceSessionId: 's', createdAt: 1 }

describe('native skill persistence', () => {
  let local: Record<string, unknown>
  let library: Record<string, unknown[]>
  let deleted: Set<string>
  let native: ReturnType<typeof vi.fn>
  beforeEach(() => {
    local = {}; library = { managed: [], chat: [] }; deleted = new Set()
    native = vi.fn(async (_host: string, request: { action: string; collection: string; skills?: typeof managed[]; skill?: typeof managed; id?: string }) => {
      const records = library[request.collection] as typeof managed[]
      if (request.action === 'import') for (const record of request.skills!) {
        if (!deleted.has(record.id) && !records.some(skill => skill.id === record.id)) records.push(record)
      }
      if (request.action === 'upsert') library[request.collection] = [request.skill!, ...records.filter(skill => skill.id !== request.skill!.id)]
      if (request.action === 'delete') {
        library[request.collection] = records.filter(skill => skill.id !== request.id)
        deleted.add(request.id!)
      }
      return { type: 'skills.result', ok: true, storeId: 'stable-user-store', revision: 1,
        skills: [...library[request.collection]!], next: null, skill: request.skill }
    })
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://new-id/', sendNativeMessage: native }, storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: local[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(local, values) }),
    } } })
  })

  it('automatically migrates existing skills and restores them after extension storage is cleared', async () => {
    local[MANAGED_SKILLS_STORAGE_KEY] = [managed]
    expect(await loadManagedSkills()).toEqual([managed])
    expect(library.managed).toEqual([managed])
    local = {} // A new install path/ID starts with fresh Chrome storage.
    expect(await loadManagedSkills()).toEqual([managed])
    expect(local[MANAGED_SKILLS_STORAGE_KEY]).toEqual([managed])
  })

  it('migrates workflow skills and does not resurrect a deleted skill from stale cache', async () => {
    local[CHAT_SKILLS_STORAGE_KEY] = [chat]
    expect(await loadChatSkills()).toEqual([chat])
    expect(await deleteChatSkill(chat.id)).toEqual([])
    local = { [CHAT_SKILLS_STORAGE_KEY]: [chat] } // An older, unmigrated extension cache.
    expect(await loadChatSkills()).toEqual([])
  })

  it('fails a save when the durable write fails, preserving the legacy copy', async () => {
    local[MANAGED_SKILLS_STORAGE_KEY] = [managed]
    await loadManagedSkills()
    native.mockImplementation(async (_host: string, request: { action: string }) => request.action === 'upsert'
      ? { type: 'skills.result', ok: false, message: 'Disk full' }
      : { type: 'skills.result', ok: true, storeId: 'stable-user-store', revision: 1, skills: [managed], next: null })
    await expect(saveManagedSkill({ name: '周报', description: '用途', instructions: '新内容' }, 's')).rejects.toThrow('Disk full')
    expect(local[MANAGED_SKILLS_STORAGE_KEY]).toEqual([managed])
  })

  it('does not report an empty library when the companion is missing', async () => {
    native.mockRejectedValue(new Error('Native host not found'))
    await expect(loadManagedSkills()).rejects.toThrow('companion')
    expect(local[MANAGED_SKILLS_STORAGE_KEY]).toBeUndefined()
  })

  it('keeps native skills usable and saves durably when the browser cache is full', async () => {
    library.managed = [managed]
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('QUOTA_BYTES exceeded'))
    expect(await loadManagedSkills()).toEqual([managed])
    const saved = await saveManagedSkill({ name: '周报', description: '用途', instructions: '新内容' }, 's')
    expect(saved.instructions).toBe('新内容')
    expect(library.managed).toEqual([saved])
    warning.mockRestore()
  })

  it('does not repeatedly rewrite an unchanged cache or re-import it', async () => {
    library.managed = [managed]
    await loadManagedSkills()
    vi.mocked(chrome.storage.local.set).mockClear()
    native.mockClear()
    await loadManagedSkills()
    expect(native.mock.calls.every(([, request]) => request.action === 'list')).toBe(true)
    expect(vi.mocked(chrome.storage.local.set).mock.calls.some(([values]) => MANAGED_SKILLS_STORAGE_KEY in values)).toBe(false)
  })

  it('preserves Firefox browser-local behavior without a native host', async () => {
    chrome.runtime.getURL = () => 'moz-extension://id/'
    local[MANAGED_SKILLS_STORAGE_KEY] = [managed]
    expect(await loadManagedSkills()).toEqual([managed])
    expect(native).not.toHaveBeenCalled()
  })
})
