// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { buildGoalContinuePrompt, buildGoalDraftPrompt, buildGoalObjective, buildGoalStartPrompt, parseGoalDraft } from '../src/panel/goal.ts'

describe('backend-neutral Goal objective', () => {
  it('asks the agent to propose a reviewable draft without starting work', () => {
    const prompt = buildGoalDraftPrompt('  编辑飞书周报  ', 'codex')
    expect(prompt).toContain('planning-only turn')
    expect(prompt).toContain('do not create a Goal')
    expect(prompt).toContain('编辑飞书周报')
  })

  it('accepts a structured draft and rejects malformed or unbounded suggestions', () => {
    const draft = { kind: 'tandix.goal-draft/v2', outcome: '完成周报', verification: '重新读取文档',
      constraints: '', boundaries: '只修改指定文档', iterationPolicy: '每轮检查文档', blockedStop: '缺少权限时停下', budgetLimit: 30000 }
    expect(parseGoalDraft(JSON.stringify(draft), 'codex')).toEqual({ outcome: '完成周报',
      verification: '重新读取文档', constraints: '', boundaries: '只修改指定文档',
      iterationPolicy: '每轮检查文档', blockedStop: '缺少权限时停下', budgetLimit: 30000 })
    expect(parseGoalDraft(JSON.stringify({ ...draft, budgetLimit: 5000000 }), 'codex')).toBeNull()
    expect(parseGoalDraft(JSON.stringify({ ...draft, verification: '' }), 'codex')).toBeNull()
    expect(parseGoalDraft(JSON.stringify({ ...draft, budgetLimit: 16 }), 'dsh')).not.toBeNull()
    expect(parseGoalDraft(JSON.stringify({ ...draft, budgetLimit: 30000 }), 'dsh')).toBeNull()
    expect(buildGoalDraftPrompt('任务', 'dsh')).toContain('not a token budget')
  })

  it('preserves the six goal fields while leaving tool selection to the agent', () => {
    const objective = buildGoalObjective({ outcome: '  Edit the report  ', verification: '  Reread the final document  ',
      constraints: 'No broken links', boundaries: '  Only edit this document  ',
      iterationPolicy: 'Inspect after each change', blockedStop: 'Ask after failed access' })
    expect(objective).toContain('Outcome: Edit the report')
    expect(objective).toContain('Completion evidence: Reread the final document')
    expect(objective).toContain('Constraints: No broken links')
    expect(objective).toContain('Boundaries and approvals: Only edit this document')
    expect(objective).toContain('Iteration policy: Inspect after each change')
    expect(objective).toContain('Stop and ask for help when: Ask after failed access')
    expect(objective).toContain('Choose the tools and next steps based on evidence')
    expect(objective).not.toContain('browser_snapshot')
  })

  it('does not add empty optional constraints', () => {
    expect(buildGoalObjective({ outcome: 'A', verification: 'B', constraints: ' ', boundaries: ' ',
      iterationPolicy: 'Inspect', blockedStop: 'If blocked' })).not.toContain('Constraints:')
  })

  it('starts the reviewed Goal with the original task and an evidence check', () => {
    const prompt = buildGoalStartPrompt('  编辑飞书周报  ')
    expect(prompt).toContain('编辑飞书周报')
    expect(prompt).toContain('Begin working on it now')
    expect(prompt).toContain('do not call the Goal complete merely because one turn ended or a tool failed')
  })

  it('uses an evidence audit when a still-active Goal is continued manually', () => {
    const prompt = buildGoalContinuePrompt()
    expect(prompt).toContain('latest evidence')
    expect(prompt).toContain('Do not treat the end of a turn as completion')
  })
})
