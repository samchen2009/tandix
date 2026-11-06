/** Stable backend IDs used by persisted preferences and bridge status frames. */
export const AGENT_CHOICES = ['auto', 'codex', 'cursor', 'workbuddy', 'kimi', 'qwen', 'opencode', 'gemini', 'dsh'] as const
export type AgentPreference = typeof AGENT_CHOICES[number]
export type AgentBackend = Exclude<AgentPreference, 'auto'>

export function agentPreference(value: unknown): AgentPreference {
  return AGENT_CHOICES.includes(value as AgentPreference) ? value as AgentPreference : 'auto'
}

export function agentBackend(value: unknown): AgentBackend {
  const preference = agentPreference(value)
  return preference === 'auto' ? 'dsh' : preference
}

export const EXTRA_AGENT_SETUP = {
  kimi: { label: 'Kimi Code', launch: 'kimi acp', login: 'kimi' },
  qwen: { label: 'Qwen Code', launch: 'qwen --acp', login: 'qwen' },
  opencode: { label: 'OpenCode', launch: 'opencode acp', login: 'opencode auth login' },
  gemini: { label: 'Gemini CLI', launch: 'gemini --acp', login: 'gemini' },
} as const

export function extraAgentSetup(backend: AgentBackend) {
  return backend in EXTRA_AGENT_SETUP ? EXTRA_AGENT_SETUP[backend as keyof typeof EXTRA_AGENT_SETUP] : null
}

export function supportsTaskGoals(backend: AgentBackend): boolean {
  return backend === 'codex' || backend === 'dsh'
}

export function agentLabel(value: AgentPreference, locale: 'zh' | 'en'): string {
  return value === 'auto' ? (locale === 'zh' ? '自动选择' : 'Automatic')
    : value === 'codex' ? 'Codex' : value === 'cursor' ? 'Cursor' : value === 'workbuddy' ? 'WorkBuddy' : extraAgentSetup(value)?.label ?? 'dsh'
}
