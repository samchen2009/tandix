export interface GoalState {
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
  budgetKind: 'tokens' | 'rounds'
  budgetUsed: number
  budgetLimit: number | null
  activation?: 'armed' | 'disarmed'
  blockedReason?: string
}

export interface GoalDraft {
  outcome: string
  verification: string
  constraints: string
  boundaries: string
  iterationPolicy: string
  blockedStop: string
  budgetLimit: number
}

export type GoalBackend = 'codex' | 'cursor' | 'dsh' | 'workbuddy'

export function buildGoalDraftPrompt(task: string, backend: GoalBackend): string {
  const budget = backend === 'codex'
    ? 'Recommend a positive token budget between 1000 and 200000.'
    : 'Recommend a positive maximum number of autonomous goal rounds between 1 and 256. This is not a token budget.'
  return [
    'Help the user turn the following task into a reviewable Goal draft. This is a planning-only turn: do not create a Goal, edit anything, send messages, or perform any other side-effecting action. Read-only inspection is allowed when needed to understand the task.',
    'Return exactly one JSON object, with no Markdown fence or commentary. Use the same language as the task for the field values.',
    'Schema: {"kind":"tandix.goal-draft/v2","outcome":"specific desired end state","verification":"concrete evidence that would prove completion","constraints":"quality, format, time or resource constraints","boundaries":"scope, approval points and important assumptions","iterationPolicy":"how to inspect results and adapt after each attempt","blockedStop":"when to stop and ask the user for input","budgetLimit":16}.',
    `${budget} Do not invent facts or permissions; put uncertainties and required confirmations in boundaries or blockedStop. The user will review and may edit every field before activation.`,
    `User task (JSON string): ${JSON.stringify(task.trim())}`,
  ].join('\n\n')
}

export function parseGoalDraft(text: string, backend: GoalBackend): GoalDraft | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const draft = value as Record<string, unknown>
    if (draft.kind !== 'tandix.goal-draft/v2') return null
    for (const field of ['outcome', 'verification', 'constraints', 'boundaries', 'iterationPolicy', 'blockedStop'] as const) {
      if (typeof draft[field] !== 'string' || draft[field].length > 3000
        || (field !== 'constraints' && field !== 'boundaries' && draft[field].trim() === '')) return null
    }
    const minimum = backend === 'codex' ? 1000 : 1
    const maximum = backend === 'codex' ? 200000 : 256
    if (!Number.isSafeInteger(draft.budgetLimit) || (draft.budgetLimit as number) < minimum
      || (draft.budgetLimit as number) > maximum) return null
    return {
      outcome: (draft.outcome as string).trim(),
      verification: (draft.verification as string).trim(),
      constraints: (draft.constraints as string).trim(),
      boundaries: (draft.boundaries as string).trim(),
      iterationPolicy: (draft.iterationPolicy as string).trim(),
      blockedStop: (draft.blockedStop as string).trim(),
      budgetLimit: draft.budgetLimit as number,
    }
  } catch { return null }
}

export function buildGoalObjective(draft: Omit<GoalDraft, 'budgetLimit'>): string {
  const lines = [
    `Outcome: ${draft.outcome.trim()}`,
    `Completion evidence: ${draft.verification.trim()}`,
  ]
  if (draft.constraints.trim() !== '') lines.push(`Constraints: ${draft.constraints.trim()}`)
  if (draft.boundaries.trim() !== '') lines.push(`Boundaries and approvals: ${draft.boundaries.trim()}`)
  lines.push(`Iteration policy: ${draft.iterationPolicy.trim()}`)
  lines.push(`Stop and ask for help when: ${draft.blockedStop.trim()}`)
  lines.push('Choose the tools and next steps based on evidence after each attempt. Do not report completion without checking the completion evidence.')
  return lines.join('\n\n')
}

export function buildGoalStartPrompt(task: string): string {
  return [
    'The user has reviewed and activated the Goal attached to this session. Begin working on it now.',
    `Original request (JSON string): ${JSON.stringify(task.trim())}`,
    'Use the active Goal as the completion contract. Choose the next actions from evidence, verify the stated completion criteria, and do not call the Goal complete merely because one turn ended or a tool failed. If a required permission or input is missing, report the blocker and what would unlock progress.',
  ].join('\n\n')
}

export function buildGoalContinuePrompt(): string {
  return 'Continue working toward the active Goal. First compare the latest evidence with its completion criteria, then choose the next useful action. If the Goal is already satisfied, verify that with concrete evidence; if blocked, explain the blocker and required input. Do not treat the end of a turn as completion.'
}
