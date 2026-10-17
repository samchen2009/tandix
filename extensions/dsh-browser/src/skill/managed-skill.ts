/** Tandix-owned, instruction-only skills. Unlike browser recordings, these need no tab. */
import { loadPersistentSkills, persistSkill } from './persistent-store.ts'

export const MANAGED_SKILLS_STORAGE_KEY = 'tandix.managed-skills.v1'
const MAX_SKILLS = 100
let pendingWrite: Promise<void> = Promise.resolve()

export interface ManagedSkill {
  id: string
  name: string
  description: string
  instructions: string
  sourceSessionId: string
  createdAt: number
  updatedAt: number
}

export interface ManagedSkillInput {
  name: string
  description: string
  instructions: string
}

function field(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > limit) {
    throw new Error(`${label} must contain 1–${limit} characters`)
  }
  return normalized
}

export function validateManagedSkillInput(value: unknown): ManagedSkillInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Skill content must be an object')
  }
  const input = value as Record<string, unknown>
  return {
    name: field(input.name, 'Skill name', 80),
    description: field(input.description, 'Skill description', 500),
    instructions: field(input.instructions, 'Skill instructions', 30_000),
  }
}

/** A structured assistant response can be saved only after a user save request. */
export function parseManagedSkillEnvelope(text: string): ManagedSkillInput | null {
  const tagged = /<tandix-skill-save-json>\s*([\s\S]*?)\s*<\/tandix-skill-save-json>/iu.exec(text)
  if (tagged === null) return null
  try { return validateManagedSkillInput(JSON.parse(tagged[1]!)) }
  catch { return null }
}

function isManagedSkill(value: unknown): value is ManagedSkill {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const skill = value as Record<string, unknown>
  return typeof skill.id === 'string' && typeof skill.name === 'string'
    && typeof skill.description === 'string' && typeof skill.instructions === 'string'
    && typeof skill.sourceSessionId === 'string' && typeof skill.createdAt === 'number'
    && typeof skill.updatedAt === 'number'
}

export async function loadManagedSkills(): Promise<ManagedSkill[]> {
  const stored = await chrome.storage.local.get(MANAGED_SKILLS_STORAGE_KEY)
  const value: unknown = stored[MANAGED_SKILLS_STORAGE_KEY]
  const legacy = Array.isArray(value) ? value.filter(isManagedSkill) : []
  return (await loadPersistentSkills<ManagedSkill>('managed', MANAGED_SKILLS_STORAGE_KEY, legacy))
    .filter(isManagedSkill).sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function saveManagedSkill(value: unknown, sourceSessionId: string): Promise<ManagedSkill> {
  const input = validateManagedSkillInput(value)
  const previous = pendingWrite
  let release!: () => void
  pendingWrite = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    const skills = await loadManagedSkills()
    const existing = skills.find((item) => item.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())
    if (existing === undefined && skills.length >= MAX_SKILLS) throw new Error('Tandix skill limit reached')
    const now = Date.now()
    const saved: ManagedSkill = {
      ...input,
      id: existing?.id ?? crypto.randomUUID(),
      sourceSessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    return await persistSkill('managed', MANAGED_SKILLS_STORAGE_KEY, saved, [saved,
      ...skills.filter((item) => item.id !== existing?.id)])
  } finally { release() }
}

export async function readManagedSkill(name: string): Promise<ManagedSkill | undefined> {
  return (await loadManagedSkills()).find((item) => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())
}
