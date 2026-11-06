// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { AGENT_CHOICES, agentBackend, agentLabel, agentPreference, supportsTaskGoals } from '../src/agent-backend.ts'
import { agentApprovalFromFrame } from '../src/panel/events.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'

describe.each(['kimi', 'qwen', 'opencode', 'gemini'] as const)('%s backend', backend => {
  it('retains its identity from persisted preference through status and permission frames', () => {
    expect(AGENT_CHOICES).toContain(backend)
    expect(agentPreference(backend)).toBe(backend)
    expect(agentBackend(backend)).toBe(backend)
    const approval = agentApprovalFromFrame({ rpcId: 'approval', method: 'agent-approval/requested',
      payload: { backend, sessionId: 'owned', kind: 'permissions', permissions: { tool: 'edit' } } })
    expect(approval).toMatchObject({ backend, sessionId: 'owned', kind: 'permissions' })
    expect(PANEL_COPY.zh.settings.snapshotHint(32000, backend)).toContain(agentLabel(backend, 'zh'))
    expect(supportsTaskGoals(backend)).toBe(false)
  })
})

it('rejects unknown and automatic backends in permission requests', () => {
  for (const backend of ['auto', 'unknown', '__proto__', null]) {
    expect(agentApprovalFromFrame({ rpcId: 'approval', method: 'agent-approval/requested',
      payload: { backend, sessionId: 'owned' } })).toBeNull()
  }
})
