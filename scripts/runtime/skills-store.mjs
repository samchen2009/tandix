/** User-owned skill data, independent of the extension ID and installation tree. */
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SKILLS_DIRECTORY = join(homedir(), '.tandix', 'skills')
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PAGE_BYTES = 400 * 1024
const MAX_RECORD_BYTES = 256 * 1024

function validSkill(collection, skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)
    || typeof skill.id !== 'string' || !skill.id || skill.id.length > 200
    || typeof skill.name !== 'string' || !skill.name.trim() || skill.name.length > (collection === 'managed' ? 80 : 100)
    || typeof skill.sourceSessionId !== 'string' || !Number.isFinite(skill.createdAt)
    || Buffer.byteLength(JSON.stringify(skill)) > MAX_RECORD_BYTES) return false
  if (collection === 'managed') return typeof skill.description === 'string'
    && skill.description.trim().length > 0 && skill.description.length <= 500
    && typeof skill.instructions === 'string' && skill.instructions.trim().length > 0
    && skill.instructions.length <= 30_000 && Number.isFinite(skill.updatedAt)
  return skill.schemaVersion === 'tandix.agent-skill/v1' && skill.version === 1
    && typeof skill.goal === 'string' && typeof skill.success === 'string'
    && Array.isArray(skill.steps) && skill.steps.every(step => typeof step === 'string')
    && Array.isArray(skill.parameters) && Array.isArray(skill.allowedOrigins)
}

function emptyStore() {
  return { version: 1, storeId: randomUUID(), revision: 0, managed: [], chat: [], deleted: { managed: [], chat: [] } }
}

function readStore(path) {
  if (!existsSync(path)) return emptyStore()
  if (statSync(path).size > MAX_FILE_BYTES) throw new Error('Skill library exceeds the size limit.')
  let store
  try { store = JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw new Error(`Cannot read skill library: ${path}. Original data was preserved; inspect library.json.bak.`) }
  if (store?.version !== 1 || typeof store.storeId !== 'string' || !Number.isSafeInteger(store.revision)
    || !['managed', 'chat'].every(key => Array.isArray(store[key])
      && store[key].every(skill => validSkill(key, skill))
      && Array.isArray(store.deleted?.[key]) && store.deleted[key].every(id => typeof id === 'string'))) {
    throw new Error(`Invalid skill library: ${path}. Original data was preserved.`)
  }
  return store
}

function writeStore(path, store) {
  const content = JSON.stringify(store, null, 2) + '\n'
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Skill library exceeds the size limit.')
  const temporary = `${path}.${randomUUID()}.tmp`
  const backup = `${temporary}.bak`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
    if (existsSync(path)) {
      copyFileSync(path, backup)
      renameSync(backup, `${path}.bak`)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true }); rmSync(backup, { force: true })
  }
}

async function acquireLock(directory) {
  const lock = join(directory, '.library.lock')
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 })
      try { writeFileSync(join(lock, 'owner'), String(process.pid), { mode: 0o600 }) }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error }
      return () => rmSync(lock, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const pid = Number(readFileSync(join(lock, 'owner'), 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) }
          catch (error) { if (error.code === 'ESRCH') rmSync(lock, { recursive: true, force: true }) }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true })
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      if (Date.now() >= deadline) throw new Error('Skill library is busy. Please retry.')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

/** Fixed operations and a fixed directory; browser callers cannot supply file paths. */
export async function handleSkillsRequest(request, { directory = SKILLS_DIRECTORY } = {}) {
  const { collection, action } = request ?? {}
  if (!['managed', 'chat'].includes(collection) || !['list', 'import', 'upsert', 'delete'].includes(action)) {
    throw new Error('Unsupported skill storage request.')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const release = await acquireLock(directory)
  try {
    const path = join(directory, 'library.json')
    const fresh = !existsSync(path)
    const store = readStore(path)
    const skills = store[collection]
    let changed = fresh
    let saved
    if (action === 'import' || action === 'upsert') {
      const records = action === 'import' ? request.skills : [request.skill]
      if (!Array.isArray(records) || records.length > 100 || records.some(skill => !validSkill(collection, skill))) {
        throw new Error('Invalid skill content.')
      }
      for (const skill of records) {
        const index = skills.findIndex(entry => entry.id === skill.id || (collection === 'managed'
          && entry.name.toLowerCase() === skill.name.toLowerCase()))
        // Migration only fills gaps. An old extension cache must never overwrite edits or undo a deletion.
        if (action === 'import' && (index !== -1 || store.deleted[collection].includes(skill.id))) continue
        if (index === -1 && skills.length >= 100) throw new Error('Tandix skill limit reached')
        saved = collection === 'managed' && index !== -1
          ? { ...skill, id: skills[index].id, createdAt: skills[index].createdAt } : skill
        if (index !== -1) skills.splice(index, 1)
        skills.unshift(saved)
        store.deleted[collection] = store.deleted[collection].filter(id => id !== saved.id)
        changed = true
      }
    } else if (action === 'delete') {
      if (typeof request.id !== 'string' || !request.id || request.id.length > 200) throw new Error('Invalid skill ID.')
      store[collection] = skills.filter(skill => skill.id !== request.id)
      if (!store.deleted[collection].includes(request.id)) store.deleted[collection].push(request.id)
      changed = true
    }
    if (changed) { store.revision += 1; writeStore(path, store) }
    const result = { type: 'skills.result', ok: true, storeId: store.storeId, revision: store.revision }
    if (action !== 'list') return { ...result, ...(saved ? { skill: saved } : {}) }
    if (request.revision !== undefined && request.revision !== store.revision) throw new Error('Skill library changed during reading. Please retry.')
    const offset = request.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid skill page.')
    const page = []
    let bytes = 0
    for (const skill of store[collection].slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(skill)) + 1
      if (bytes + size > MAX_PAGE_BYTES) break
      page.push(skill); bytes += size
    }
    return { ...result, skills: page, next: offset + page.length < store[collection].length ? offset + page.length : null }
  } finally { release() }
}
