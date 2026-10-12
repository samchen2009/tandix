// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadManagedSkills, parseManagedSkillEnvelope, readManagedSkill, saveManagedSkill,
  MANAGED_SKILLS_STORAGE_KEY } from '../src/skill/managed-skill.ts'
import { requestsSkillSave } from '../src/skill/save-intent.ts'

describe('Tandix-managed skills', () => {
  let store: Record<string, unknown>
  beforeEach(() => {
    store = {}
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, values) }),
    } } })
  })

  it('saves, verifies, and updates a skill in extension storage', async () => {
    const first = await saveManagedSkill({ name: '鸿蒙周报', description: '写鸿蒙周报时使用',
      instructions: '对照上周数据，核算差异。' }, 'session-one')
    expect((store[MANAGED_SKILLS_STORAGE_KEY] as unknown[])).toHaveLength(1)
    expect((await readManagedSkill('鸿蒙周报'))?.instructions).toBe('对照上周数据，核算差异。')
    const second = await saveManagedSkill({ name: '鸿蒙周报', description: '起草每周报告',
      instructions: '先读取资料，再核对数值。' }, 'session-two')
    expect(second.id).toBe(first.id)
    expect(await loadManagedSkills()).toHaveLength(1)
    expect((await readManagedSkill('鸿蒙周报'))?.instructions).toBe('先读取资料，再核对数值。')
  })

  it('rejects empty or oversized skill content without writing', async () => {
    await expect(saveManagedSkill({ name: 'x', description: 'y', instructions: '' }, 's'))
      .rejects.toThrow('Skill instructions')
    await expect(saveManagedSkill({ name: 'x'.repeat(81), description: 'y', instructions: 'z' }, 's'))
      .rejects.toThrow('Skill name')
    expect(store[MANAGED_SKILLS_STORAGE_KEY]).toBeUndefined()
  })

  it('keeps both skills when separate sessions save concurrently', async () => {
    await Promise.all([
      saveManagedSkill({ name: '周报', description: '写周报', instructions: '核对数据。' }, 's1'),
      saveManagedSkill({ name: '设计稿', description: '设计界面', instructions: '先收集需求。' }, 's2'),
    ])
    expect((await loadManagedSkills()).map((skill) => skill.name).sort()).toEqual(['周报', '设计稿'].sort())
  })

  it('accepts only a valid tagged assistant skill payload', () => {
    const input = { name: '鸿蒙周报', description: '写周报时使用', instructions: '核算差值。' }
    expect(parseManagedSkillEnvelope(`<tandix-skill-save-json>${JSON.stringify(input)}</tandix-skill-save-json>`)).toEqual(input)
    expect(parseManagedSkillEnvelope(JSON.stringify(input))).toBeNull()
    expect(parseManagedSkillEnvelope('<tandix-skill-save-json>{"name":"x"}</tandix-skill-save-json>')).toBeNull()
  })
})

describe('explicit skill save intent', () => {
  it('recognizes user requests without treating mentions or negation as authorization', () => {
    expect(requestsSkillSave('总结成技能保存下来')).toBe(true)
    expect(requestsSkillSave('把这套规则创建为一个 skill')).toBe(true)
    expect(requestsSkillSave('请不要保存技能，只帮我解释')).toBe(false)
    expect(requestsSkillSave('这个技能保存在哪里？')).toBe(false)
    expect(requestsSkillSave('技能保存成功了吗？')).toBe(false)
    expect(requestsSkillSave('用已有技能写周报')).toBe(false)
  })
})
