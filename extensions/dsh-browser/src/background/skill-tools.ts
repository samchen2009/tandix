import type { ToolAnswer, ToolCall } from './tools.ts'
import { loadManagedSkills, readManagedSkill, saveManagedSkill } from '../skill/managed-skill.ts'

/** An explicit composer request grants one skill save in its owning session. */
export class SkillToolService {
  private readonly saveGrants = new Map<string, number>()

  authorizeSave(sessionId: string): void {
    this.saveGrants.set(sessionId, Date.now() + 30 * 60_000)
  }

  revokeSave(sessionId: string): void {
    this.saveGrants.delete(sessionId)
  }

  async dispatch(call: ToolCall, signal: AbortSignal, commitAction: () => void): Promise<ToolAnswer> {
    if (signal.aborted) return { ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } }
    if (call.name === 'tandix_skill_list') {
      const skills = await loadManagedSkills()
      return { ok: true, result: { text: JSON.stringify(skills.map(({ name, description, updatedAt }) =>
        ({ name, description, updatedAt }))) } }
    }
    if (call.name === 'tandix_skill_read') {
      if (typeof call.args.name !== 'string') return { ok: false, error: { code: 'action-failed', message: 'Skill name is required' } }
      const skill = await readManagedSkill(call.args.name)
      return skill === undefined
        ? { ok: false, error: { code: 'action-failed', message: 'Tandix skill not found' } }
        : { ok: true, result: { text: JSON.stringify({ name: skill.name, description: skill.description,
          instructions: skill.instructions }) } }
    }
    if (call.name !== 'tandix_skill_save') return { ok: false, error: { code: 'action-failed', message: 'Unknown Tandix skill tool' } }
    const sessionId = call.sessionId
    if (sessionId === undefined || (this.saveGrants.get(sessionId) ?? 0) < Date.now()) {
      return { ok: false, error: { code: 'action-failed', message: 'Saving a Tandix skill requires a recent explicit user request to save a skill' } }
    }
    const saved = await saveManagedSkill(call.args, sessionId)
    commitAction()
    const verified = await readManagedSkill(saved.name)
    if (verified?.id !== saved.id) throw new Error('Skill storage verification failed')
    this.saveGrants.delete(sessionId)
    return { ok: true, result: { text: JSON.stringify({ saved: true, name: saved.name,
      id: saved.id, location: 'Tandix > Skills > Tandix skills' }) } }
  }
}
