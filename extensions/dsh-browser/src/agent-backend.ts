/** Stable backend IDs used by persisted preferences and bridge status frames. */
export const AGENT_CHOICES = ['auto', 'codex', 'cursor', 'workbuddy', 'dsh'] as const
export type AgentPreference = typeof AGENT_CHOICES[number]
export type AgentBackend = Exclude<AgentPreference, 'auto'>

export function agentPreference(value: unknown): AgentPreference {
  return AGENT_CHOICES.includes(value as AgentPreference) ? value as AgentPreference : 'auto'
}

export function agentBackend(value: unknown): AgentBackend {
  return value === 'codex' || value === 'cursor' || value === 'workbuddy' ? value : 'dsh'
}

export function agentLabel(value: AgentPreference, locale: 'zh' | 'en'): string {
  return value === 'auto' ? (locale === 'zh' ? '自动选择' : 'Automatic')
    : value === 'codex' ? 'Codex' : value === 'cursor' ? 'Cursor' : value === 'workbuddy' ? 'WorkBuddy' : 'dsh'
}
