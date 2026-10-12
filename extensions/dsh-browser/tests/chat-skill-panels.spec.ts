// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunSkillsPanel } from '../src/panel/ChatSkillPanels.tsx'
import type { ChatSkill } from '../src/skill/chat-skill.ts'

const baseSkill: ChatSkill = {
  schemaVersion: 'tandix.agent-skill/v1', version: 1, id: 'browser-skill',
  name: '查询反馈', goal: '查询反馈列表', success: '列表完成刷新',
  steps: ['设置筛选条件', '点击查询'], parameters: [],
  allowedOrigins: ['https://example.com'], startUrl: 'https://example.com/feedback',
  sourceSessionId: 'session-1', createdAt: 1,
}

describe('skills tab execution modes', () => {
  let root: Root

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})) } } })
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function render(skill: ChatSkill, onRun = vi.fn(async () => {})): Promise<typeof onRun> {
    await act(async () => {
      root.render(createElement(RunSkillsPanel, {
        skills: [skill], locale: 'zh', canRun: true, onRun,
        onDelete: vi.fn(async () => {}), onImport: vi.fn(async () => {}),
      }))
    })
    return onRun
  }

  it('runs and offers a downloadable browser-only skill package', async () => {
    const onRun = await render(baseSkill)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.chat-skill-actions-footer button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['运行技能', '下载技能', '删除技能'])
    expect(document.querySelector<HTMLButtonElement>('.download-desktop-skill')?.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.download-desktop-skill')?.title).toContain('浏览器版技能包')
    expect(document.querySelector('.run-skill-detail')?.textContent).toContain('仅支持在网页助手的浏览器模式下执行')

    await act(async () => { buttons[0]!.click() })
    expect(onRun).toHaveBeenCalledWith(baseSkill, {})
  })

  it('describes the independent runner when a reviewed adapter exists', async () => {
    await render({
      ...baseSkill,
      id: 'portable-skill',
      desktopAdapter: {
        kind: 'http', auth: { kind: 'cookie-env', env: 'SERVICE_COOKIE' },
        requests: [{ name: '查询', method: 'GET', url: 'https://example.com/api/feedback', response: { listPath: 'data.list' } }],
      },
    })
    const download = document.querySelector<HTMLButtonElement>('.download-desktop-skill')
    expect(download?.textContent).toBe('下载技能')
    expect(download?.disabled).toBe(false)
    expect(download?.title).toContain('不依赖浏览器')
    expect(document.querySelector('.run-skill-detail')?.textContent).toContain('运行时不依赖网页助手扩展')
  })

  it('shows Tandix-saved instruction skills and passes their content to Chat', async () => {
    const skill = { id: 'managed-1', name: '鸿蒙周报', description: '起草周报时使用',
      instructions: '对照上周核对数据。', sourceSessionId: 'session-1', createdAt: 1, updatedAt: 2 }
    chrome.storage.local.get = vi.fn(async () => ({ 'tandix.managed-skills.v1': [skill] }))
    const onUseManagedSkill = vi.fn()
    await act(async () => {
      root.render(createElement(RunSkillsPanel, {
        skills: [baseSkill], locale: 'zh', canRun: true, onUseManagedSkill,
        onRun: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onImport: vi.fn(async () => {}),
      }))
    })
    const list = document.querySelector('.run-skills-list[aria-label="技能列表"]')
    expect(list?.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(list?.textContent).toContain('鸿蒙周报')
    expect(list?.textContent).toContain('查询反馈')
    expect(document.querySelector('.run-skills-browser-heading')?.textContent).toContain('2/2')
    expect(document.querySelector('.run-skill-detail')?.textContent).toContain('对照上周核对数据。')
    await act(async () => { document.querySelector<HTMLButtonElement>('.run-skill-detail button')?.click() })
    expect(onUseManagedSkill).toHaveBeenCalledWith(skill)
    await act(async () => { list?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click() })
    expect(document.querySelector('.run-skill-detail')?.textContent).toContain('列表完成刷新')
    const search = document.querySelector<HTMLInputElement>('.run-skills-search input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, '周报')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(list?.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(document.querySelector('.run-skills-browser-heading')?.textContent).toContain('1/2')
    expect(document.querySelector('.run-skill-detail')?.textContent).toContain('对照上周核对数据。')
  })

  it('shows safe defaults without persisting a user override', async () => {
    const onRun = await render({
      ...baseSkill,
      parameters: [{ name: 'keyword', label: '关键词', type: 'string', required: false, defaultValue: '投屏' }],
    })
    expect(document.querySelector<HTMLInputElement>('.chat-skill-field input')?.value).toBe('投屏')
    await act(async () => { document.querySelector<HTMLButtonElement>('.chat-skill-actions-footer .primary')!.click() })
    expect(onRun).toHaveBeenCalledWith(expect.anything(), {})
  })

  it('does not show Codex SKILL.md skills in the Tandix Skills tab', async () => {
    await act(async () => {
      root.render(createElement(RunSkillsPanel, {
        skills: [], locale: 'zh', canRun: true,
        onRun: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onImport: vi.fn(async () => {}),
      }))
    })
    expect(document.querySelector('.run-agent-skills')).toBeNull()
    expect(document.querySelector('.run-skills-workspace')?.textContent).not.toContain('SKILL.md')
    expect(document.querySelector('.run-skills-workspace')?.textContent).toContain('还没有技能')
    expect(document.querySelector('.run-skills-layout')).toBeNull()
  })
})
