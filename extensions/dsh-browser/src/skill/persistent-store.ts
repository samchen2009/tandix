/** Chrome uses the user-level native library; extension storage is a migration source/cache. */
const HOST = 'io.traceforge.bridge'
type Collection = 'managed' | 'chat'
interface Page<T> {
  type: 'skills.result'
  ok: boolean
  message?: string
  storeId: string
  revision: number
  skills?: T[]
  skill?: T
  next?: number | null
}

function nativeAvailable(): boolean {
  // Firefox has no installed Tandix companion. Keep its existing browser-local library.
  return !/^moz-extension:/u.test(chrome.runtime?.getURL?.('') ?? '')
    && typeof chrome.runtime?.sendNativeMessage === 'function'
}

async function request<T>(collection: Collection, body: Record<string, unknown>): Promise<Page<T>> {
  let response: Page<T> | undefined
  try { response = await chrome.runtime.sendNativeMessage(HOST, { type: 'skills', collection, ...body }) as Page<T> }
  catch (cause) {
    throw new Error(`无法连接 Tandix 技能存储，请更新本机 companion 后重试。 / Cannot connect to Tandix skill storage: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (response?.type !== 'skills.result' || response.ok !== true) {
    throw new Error(response?.message ?? 'Please update the Tandix companion to enable persistent skill storage.')
  }
  return response
}

async function cache(key: string, skills: unknown[]): Promise<void> {
  const stored = await chrome.storage.local.get(key)
  // Avoid onChanged -> load -> cache -> onChanged refresh loops.
  if (JSON.stringify(stored[key]) === JSON.stringify(skills)) return
  await chrome.storage.local.set({ [key]: skills })
}

async function pages<T>(collection: Collection, first?: Page<T>): Promise<{ storeId: string; skills: T[] }> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await readPages(collection, attempt === 0 ? first : undefined) }
    catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !error.message.includes('changed during reading')) throw error
    }
  }
}

async function readPages<T>(collection: Collection, first?: Page<T>): Promise<{ storeId: string; skills: T[] }> {
  const page = first ?? await request<T>(collection, { action: 'list' })
  const skills = [...page.skills!]
  let next = page.next
  while (next !== null && next !== undefined) {
    const following = await request<T>(collection, { action: 'list', offset: next, revision: page.revision })
    skills.push(...following.skills!)
    next = following.next
  }
  return { storeId: page.storeId, skills }
}

export async function loadPersistentSkills<T>(collection: Collection, key: string, legacy: T[]): Promise<T[]> {
  if (!nativeAvailable()) return legacy
  const receiptKey = `${key}.native-store`
  const first = await request<T>(collection, { action: 'list' })
  const receipt = await chrome.storage.local.get(receiptKey)
  if (receipt[receiptKey] !== first.storeId) {
    // Bound each native request below Chrome's frame limit, including multi-byte text.
    let batch: T[] = []
    let size = 0
    for (const skill of legacy) {
      const bytes = new TextEncoder().encode(JSON.stringify(skill)).length + 1
      if (batch.length > 0 && size + bytes > 400 * 1024) {
        await request(collection, { action: 'import', skills: batch }); batch = []; size = 0
      }
      batch.push(skill); size += bytes
    }
    if (batch.length > 0) await request(collection, { action: 'import', skills: batch })
  }
  const result = await pages<T>(collection, receipt[receiptKey] === first.storeId || legacy.length === 0 ? first : undefined)
  // Record migration only after the complete authoritative library has been read.
  try {
    if (receipt[receiptKey] !== result.storeId) await chrome.storage.local.set({ [receiptKey]: result.storeId })
    await cache(key, result.skills)
  } catch (error) { console.warn('Tandix skill cache update failed', error) }
  return result.skills
}

export async function persistSkill<T>(collection: Collection, key: string, skill: T, localNext: T[]): Promise<T> {
  if (!nativeAvailable()) { await cache(key, localNext); return skill }
  const response = await request<T>(collection, { action: 'upsert', skill })
  // A cache failure must not turn a successful durable save into a reported failure.
  try { await cache(key, (await pages<T>(collection)).skills) }
  catch (error) { console.warn('Tandix skill cache update failed', error) }
  return response.skill!
}

export async function removePersistentSkill<T>(collection: Collection, key: string, id: string, localNext: T[]): Promise<T[]> {
  if (!nativeAvailable()) { await cache(key, localNext); return localNext }
  await request(collection, { action: 'delete', id })
  const result = await pages<T>(collection)
  try { await cache(key, result.skills) } catch (error) { console.warn('Tandix skill cache update failed', error) }
  return result.skills
}
