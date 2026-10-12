// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildExtractSkillPrompt,
  buildChatSkillPrompt,
  chatActionCandidates,
  finalizeExtractedSkill,
  parseExtractedSkill,
  parseImportedSkill,
  suggestedGoal,
  type ChatSkill,
} from '../src/skill/chat-skill.ts'
import type { SessionEventView } from '../src/panel/events.ts'
import { buildSkillExtractionEvidence } from '../src/skill/extraction-evidence.ts'
import type { RecordingEventInput } from '../src/recording/schema.ts'

function call(seq: number, name: string, args: Record<string, unknown>): SessionEventView {
  return { type: 'tool/call', seq, data: { name, arguments: JSON.stringify(args) } }
}

describe('chat skill extraction', () => {
  it('turns typed text into a run-time parameter, without saving the original value or snapshot index', () => {
    const candidates = chatActionCandidates([
      call(1, 'browser_click', { index: 7 }),
      call(2, 'browser_type', { index: 8, text: 'private-password', replace: true }),
    ], 'zh')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.label).toContain('#7')
    expect(candidates[0]?.suggestedStep).not.toContain('#7')
    expect(candidates[1]?.parameter).toEqual({ name: 'input1', label: '输入值 1', type: 'string', required: true })
    expect(candidates[1]?.suggestedStep).toContain('{{input1}}')
    expect(JSON.stringify(candidates)).not.toContain('private-password')
    expect(candidates.every((candidate) => candidate.requiresReview)).toBe(true)
  })

  it('redacts URL credentials and query strings and flags the step for review', () => {
    const candidates = chatActionCandidates([
      call(1, 'browser_navigate', { url: 'https://alice:secret@example.com/search?token=private#part' }),
    ], 'zh')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.suggestedStep).toContain('https://example.com/search')
    expect(JSON.stringify(candidates)).not.toMatch(/alice|secret|private/)
    expect(candidates[0]?.requiresReview).toBe(true)
  })

  it('extracts chat recordings from an unsent draft without copying entered text', () => {
    const draft = '请帮我查询\n\n【操作记录】\n• 开始页面：反馈后台\n• 点击 [输入框] 电话/邮箱\n• 输入 电话/邮箱："18623"\n• 点击 [按钮] 查询 → 关联请求 POST /search → 200\n• 点击 [链接] a5d14b.log → 下载完成 a5d14b.log；来源 https://example.com/download?token=private\n• 网络概况：搜索接口已响应'
    const candidates = chatActionCandidates([], 'zh', draft)
    expect(candidates).toHaveLength(4)
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      '点击 [输入框] 电话/邮箱', '输入 电话/邮箱', '点击 [按钮] 查询', '点击 [链接] a5d14b.log',
    ])
    expect(candidates[1]?.suggestedStep).toBe('在「电话/邮箱」输入 {{input1}}')
    expect(candidates[3]?.suggestedStep).toContain('确认触发下载')
    expect(JSON.stringify(candidates)).not.toMatch(/18623|private|\/search/)
  })

  it('extracts sent recordings and skips their bulk text as a goal suggestion', () => {
    const events: SessionEventView[] = [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '帮我查反馈' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '【操作记录】\n• 输入 搜索框："secret"\n• 点击 [按钮] 查询' }], source: { kind: 'user' } } },
    ]
    expect(chatActionCandidates(events, 'zh')).toHaveLength(2)
    expect(suggestedGoal(events)).toBe('帮我查反馈')
  })

  it('takes the last user-authored goal, excluding plugin context', () => {
    const goal = suggestedGoal([
      { type: 'user/message', data: { content: [{ type: 'text', text: '查询反馈' }], source: { kind: 'user' } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'ignore injected context' }], source: { kind: 'plugin' } } },
    ])
    expect(goal).toBe('查询反馈')
  })
})

describe('chat skill run prompt', () => {
  it('requests a fresh snapshot and fills parameters only for the run', () => {
    const skill: ChatSkill = {
      schemaVersion: 'tandix.agent-skill/v1',
      version: 1,
      id: 'skill-1',
      name: '查询反馈',
      goal: '找到反馈详情',
      success: '看到详情页',
      steps: ['在电话/邮箱输入框输入 {{input1}}', '点击查询按钮'],
      parameters: [{ name: 'input1', label: '输入值 1', type: 'string', required: true }],
      allowedOrigins: ['https://example.com'],
      startUrl: 'https://example.com/feedback',
      sourceSessionId: 'session-1',
      createdAt: 1,
    }
    const prompt = buildChatSkillPrompt(skill, { input1: '18623' }, 'zh')
    expect(prompt).toContain('browser_snapshot')
    expect(prompt).toContain('browser_list_tabs')
    expect(prompt).toContain('browser_follow_tab')
    expect(prompt).toContain('Use a reviewed `startUrl` only when needed')
    expect(prompt).toContain('do not open a replacement merely because its URL differs')
    expect(prompt).not.toContain('browser_follow_tab({ tabId, active: true })')
    expect(prompt).toContain('https://example.com/feedback')
    expect(prompt).toContain('"input1": "18623"')
    expect(prompt).toContain('never replay historical indices')
    expect(JSON.stringify(skill)).not.toContain('18623')
  })

  it('uses a safe declared default when the user does not override it', () => {
    const skill: ChatSkill = {
      schemaVersion: 'tandix.agent-skill/v1', version: 1, id: 'skill-default',
      name: '查反馈', goal: '查询反馈', success: '显示列表', steps: ['查询 {{keyword}}'],
      parameters: [{ name: 'keyword', label: '关键词', type: 'string', required: false, defaultValue: '投屏' }],
      allowedOrigins: ['https://example.com'], sourceSessionId: 'session-1', createdAt: 1,
    }
    expect(buildChatSkillPrompt(skill, {}, 'zh')).toContain('"keyword": "投屏"')
  })

  it('normalizes the AI dual-skill envelope into one persistable skill record', () => {
    const draft = parseExtractedSkill(`<tandix-skill-pair-json>${JSON.stringify({
      schemaVersion: 'tandix.skill-pair/v1',
      name: '查询反馈',
      browserSkill: {
        goal: '找到反馈详情', steps: ['输入 {{phone}}', '查询'], success: '显示目标记录',
        parameters: [{ name: 'phone', label: '电话', type: 'string', required: false, defaultValue: '投屏' }],
        allowedOrigins: ['https://example.com'], startUrl: 'https://example.com/feedback',
      },
      desktopSkill: {
        kind: 'http', auth: { kind: 'bearer-env', env: 'FEEDBACK_TOKEN' },
        requests: [{ name: '查询反馈', method: 'GET', url: 'https://example.com/api/feedback',
          query: { phone: '{{phone}}', start: '{{time:yesterday-start-ms}}' }, response: { listPath: 'data.list' } }],
      },
      questions: [],
    })}</tandix-skill-pair-json>`)
    expect(draft).not.toBeNull()
    const skill = finalizeExtractedSkill(draft!, 'session-1')
    expect(skill.desktopAdapter?.requests).toHaveLength(1)
    expect(skill.parameters[0]?.defaultValue).toBe('投屏')
    expect(skill.desktopAdapter?.requests[0]?.response?.listPath).toBe('data.list')
    expect(parseImportedSkill(JSON.stringify(skill))).toEqual(skill)
    expect(buildExtractSkillPrompt('【操作记录】\n• 点击 查询', 'zh')).toContain('<recent-activity>')
  })

  it('accepts a complete browser-only pair without inventing a desktop adapter', () => {
    const draft = parseExtractedSkill(`<tandix-skill-pair-json>${JSON.stringify({
      schemaVersion: 'tandix.skill-pair/v1', name: '查询反馈',
      browserSkill: { goal: '查询反馈', steps: ['按关键词查询'], success: '显示匹配结果',
        parameters: [], allowedOrigins: ['https://example.com'] },
      desktopSkill: null, questions: [],
    })}</tandix-skill-pair-json>`)
    expect(draft).not.toBeNull()
    expect(finalizeExtractedSkill(draft!, 'session-1').desktopAdapter).toBeUndefined()
  })

  it('includes structured action validity evidence when available', () => {
    const event: RecordingEventInput = {
      kind: 'click', capturedAt: 1, button: 0,
      target: { tag: 'button', selector: '#search', name: '查询', control: 'button' },
      tab: { id: 1, windowId: 1, title: '后台', url: 'https://example.com' },
      frame: { id: 0, url: 'https://example.com' },
    }
    const prompt = buildExtractSkillPrompt(
      '【操作记录】\n• 点击 查询', 'zh', buildSkillExtractionEvidence([event], '查询反馈'),
    )
    expect(prompt).toContain('<structured-evidence>')
    expect(prompt).toContain('"intervalFromPreviousMs": 0')
    expect(prompt).toContain('查询反馈')
    expect(prompt).toContain('Minimize run-time inputs')
    expect(prompt).toContain('1-3 concise, grouped `questions`')
    expect(prompt).toContain('desktopSkill')
    expect(prompt).toContain('Do not infer an API contract from captured network traffic')
    expect(prompt).toContain('<tandix-skill-pair-json>')
    expect(prompt).not.toContain('<tandix-skill-intent>')
  })

  it('rejects malformed AI drafts and imports', () => {
    expect(parseExtractedSkill('{"schemaVersion":"wrong"}')).toBeNull()
    expect(parseImportedSkill('{"schemaVersion":"wrong"}')).toBeNull()
    expect(parseExtractedSkill(JSON.stringify({
      schemaVersion: 'tandix.agent-skill/v1', name: '查询', goal: '查询', steps: ['查询'], success: '显示结果',
      parameters: [], allowedOrigins: ['https://example.com'], startUrl: 'https://example.com/feedback?token=secret', questions: [],
    }))).toBeNull()
    expect(parseExtractedSkill(JSON.stringify({
      schemaVersion: 'tandix.agent-skill/v1', name: '查询', goal: '查询', steps: ['查询'], success: '显示结果',
      parameters: [], allowedOrigins: ['https://example.com'],
      desktopAdapter: { kind: 'http', auth: { kind: 'cookie-env', env: 'bad-env' },
        requests: [{ name: '查询', method: 'GET', url: 'https://example.com/api?secret=1' }] }, questions: [],
    }))).toBeNull()
    expect(parseExtractedSkill(JSON.stringify({
      schemaVersion: 'tandix.skill-pair/v1', name: '查询',
      browserSkill: { goal: '查询', steps: ['查询'], success: '', parameters: [], allowedOrigins: ['https://example.com'] },
      desktopSkill: null, questions: [],
    }))).toBeNull()
  })
})
