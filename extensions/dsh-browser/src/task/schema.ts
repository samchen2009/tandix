/** Future compiler output contract. Phase one defines it but does not compile arbitrary sites yet. */

export const TASK_SPEC_SCHEMA_VERSION = 'traceforge.task/v1' as const

export type TaskParameter = {
  name: string
  type: 'string' | 'secret' | 'number' | 'boolean'
  required: boolean
  description?: string
  default?: string | number | boolean
}

export type TaskStep =
  | { id: string; action: 'navigate'; url: string }
  | { id: string; action: 'click'; selector: string; description?: string }
  | { id: string; action: 'fill'; selector: string; value: string; sensitive?: boolean }
  | { id: string; action: 'select'; selector: string; value: string }
  | { id: string; action: 'press'; selector?: string; key: string }
  | { id: string; action: 'submit'; selector: string }
  | { id: string; action: 'verify'; assertion: TaskAssertion }

export type TaskAssertion =
  | { kind: 'url'; matches: string }
  | { kind: 'element'; selector: string; state: 'visible' | 'hidden' | 'enabled' | 'disabled' }
  | { kind: 'text'; selector?: string; contains: string }

export interface TaskSpec {
  schemaVersion: typeof TASK_SPEC_SCHEMA_VERSION
  id: string
  name: string
  description: string
  source: { recordingId: string; compiler: string; compiledAt: number }
  parameters: TaskParameter[]
  preconditions: TaskAssertion[]
  steps: TaskStep[]
  success: TaskAssertion[]
  policy: {
    allowedOrigins: string[]
    timeoutMs: number
    repair: 'disabled' | 'agent'
  }
}
