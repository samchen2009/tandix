import {
  RECORDING_SCHEMA_VERSION,
  emptyRecordingSummary,
  summarizeEvent,
  type BrowserRecording,
  type RecordingEvent,
  type RecordingEventInput,
  type RecordingMetadata,
} from './schema.ts'

const DB_NAME = 'traceforge-recordings'
const DB_VERSION = 1
const RECORDINGS = 'recordings'
const EVENTS = 'events'

export interface RecordingStore {
  create(recording: RecordingMetadata): Promise<void>
  append(recordingId: string, input: RecordingEventInput): Promise<RecordingMetadata>
  finish(recordingId: string, endedAt: number): Promise<RecordingMetadata>
  addTab(recordingId: string, tabId: number): Promise<RecordingMetadata>
  active(): Promise<RecordingMetadata | null>
  latest(): Promise<RecordingMetadata | null>
  get(recordingId: string): Promise<BrowserRecording | null>
}

/** Short-lived buffer for the always-on Chat recap. Nothing is written to disk. */
export class InMemoryRecentRecordingStore implements RecordingStore {
  private recording: BrowserRecording | null = null

  async create(recording: RecordingMetadata): Promise<void> {
    this.recording = { ...recording, events: [] }
  }

  async append(recordingId: string, input: RecordingEventInput): Promise<RecordingMetadata> {
    const current = this.recording
    if (current === null || current.id !== recordingId || current.status !== 'recording') throw new Error('Recording is not active')
    const event: RecordingEvent = {
      ...input, id: crypto.randomUUID(), recordingId, sequence: current.summary.eventCount + 1,
    } as RecordingEvent
    const tabIds = current.tabIds.includes(event.tab.id) ? current.tabIds : [...current.tabIds, event.tab.id]
    this.recording = {
      ...current,
      tabIds,
      updatedAt: Math.max(current.updatedAt, event.capturedAt),
      summary: summarizeEvent({ ...current, tabIds }, event),
      events: [...current.events, event].filter((item) => item.capturedAt >= Date.now() - 10 * 60_000).slice(-200),
    }
    return this.recording
  }

  async finish(recordingId: string, endedAt: number): Promise<RecordingMetadata> {
    const current = this.recording
    if (current === null || current.id !== recordingId) throw new Error('Recording not found')
    this.recording = {
      ...current, status: 'stopped', endedAt, updatedAt: endedAt,
      summary: { ...current.summary, durationMs: Math.max(0, endedAt - current.startedAt) },
    }
    return this.recording
  }

  async addTab(recordingId: string, tabId: number): Promise<RecordingMetadata> {
    const current = this.recording
    if (current === null || current.id !== recordingId) throw new Error('Recording not found')
    if (!current.tabIds.includes(tabId)) {
      this.recording = { ...current, tabIds: [...current.tabIds, tabId], summary: { ...current.summary, tabCount: current.tabIds.length + 1 } }
    }
    return this.recording!
  }

  async active(): Promise<RecordingMetadata | null> {
    return this.recording?.status === 'recording' ? this.recording : null
  }

  async latest(): Promise<RecordingMetadata | null> {
    return this.recording
  }

  async get(recordingId: string): Promise<BrowserRecording | null> {
    return this.recording?.id === recordingId ? this.recording : null
  }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => { resolve(value.result) }
    value.onerror = () => { reject(value.error ?? new Error('IndexedDB request failed')) }
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onabort = () => { reject(transaction.error ?? new Error('IndexedDB transaction aborted')) }
    transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB transaction failed')) }
  })
}

export function newRecording(tab: chrome.tabs.Tab, now = Date.now()): RecordingMetadata {
  if (tab.id === undefined) throw new Error('The active tab has no id')
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    product: { name: 'Tandix', tagline: 'Ask on the page. Act on the page. Save what works as a skill.' },
    status: 'recording',
    title: `Trace ${new Date(now).toLocaleString()}`,
    startedAt: now,
    updatedAt: now,
    windowId: tab.windowId,
    tabIds: [tab.id],
    startPage: { title: tab.title ?? '', url: tab.url ?? '' },
    summary: emptyRecordingSummary(),
  }
}

export class IndexedDbRecordingStore implements RecordingStore {
  private database: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (this.database !== null) return this.database
    this.database = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, DB_VERSION)
      opening.onupgradeneeded = () => {
        const database = opening.result
        if (!database.objectStoreNames.contains(RECORDINGS)) {
          database.createObjectStore(RECORDINGS, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(EVENTS)) {
          const events = database.createObjectStore(EVENTS, { keyPath: 'id' })
          events.createIndex('recordingId', 'recordingId', { unique: false })
          events.createIndex('recordingSequence', ['recordingId', 'sequence'], { unique: true })
        }
      }
      opening.onsuccess = () => { resolve(opening.result) }
      opening.onerror = () => { reject(opening.error ?? new Error('Unable to open Tandix recordings')) }
    })
    return this.database
  }

  async create(recording: RecordingMetadata): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(RECORDINGS, 'readwrite')
    transaction.objectStore(RECORDINGS).put(recording)
    await transactionDone(transaction)
  }

  async append(recordingId: string, input: RecordingEventInput): Promise<RecordingMetadata> {
    const database = await this.open()
    const transaction = database.transaction([RECORDINGS, EVENTS], 'readwrite')
    const recordings = transaction.objectStore(RECORDINGS)
    const metadata = await request(recordings.get(recordingId) as IDBRequest<RecordingMetadata | undefined>)
    if (metadata === undefined || metadata.status !== 'recording') {
      transaction.abort()
      throw new Error('Recording is not active')
    }
    const event: RecordingEvent = {
      ...input,
      id: crypto.randomUUID(),
      recordingId,
      sequence: metadata.summary.eventCount + 1,
    } as RecordingEvent
    const tabIds = metadata.tabIds.includes(event.tab.id) ? metadata.tabIds : [...metadata.tabIds, event.tab.id]
    const next = {
      ...metadata,
      tabIds,
      updatedAt: Math.max(metadata.updatedAt, event.capturedAt),
      summary: summarizeEvent({ ...metadata, tabIds }, event),
    }
    transaction.objectStore(EVENTS).put(event)
    recordings.put(next)
    await transactionDone(transaction)
    return next
  }

  async finish(recordingId: string, endedAt: number): Promise<RecordingMetadata> {
    const database = await this.open()
    const transaction = database.transaction(RECORDINGS, 'readwrite')
    const store = transaction.objectStore(RECORDINGS)
    const metadata = await request(store.get(recordingId) as IDBRequest<RecordingMetadata | undefined>)
    if (metadata === undefined) {
      transaction.abort()
      throw new Error('Recording not found')
    }
    const next: RecordingMetadata = {
      ...metadata,
      status: 'stopped',
      endedAt,
      updatedAt: endedAt,
      summary: { ...metadata.summary, durationMs: Math.max(0, endedAt - metadata.startedAt) },
    }
    store.put(next)
    await transactionDone(transaction)
    return next
  }

  async addTab(recordingId: string, tabId: number): Promise<RecordingMetadata> {
    const database = await this.open()
    const transaction = database.transaction(RECORDINGS, 'readwrite')
    const store = transaction.objectStore(RECORDINGS)
    const metadata = await request(store.get(recordingId) as IDBRequest<RecordingMetadata | undefined>)
    if (metadata === undefined) {
      transaction.abort()
      throw new Error('Recording not found')
    }
    const next = metadata.tabIds.includes(tabId)
      ? metadata
      : { ...metadata, tabIds: [...metadata.tabIds, tabId], summary: { ...metadata.summary, tabCount: metadata.tabIds.length + 1 } }
    store.put(next)
    await transactionDone(transaction)
    return next
  }

  async active(): Promise<RecordingMetadata | null> {
    const all = await this.allMetadata()
    return all.filter((recording) => recording.status === 'recording').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  async latest(): Promise<RecordingMetadata | null> {
    return (await this.allMetadata()).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  async get(recordingId: string): Promise<BrowserRecording | null> {
    const database = await this.open()
    const transaction = database.transaction([RECORDINGS, EVENTS], 'readonly')
    const metadata = await request(transaction.objectStore(RECORDINGS).get(recordingId) as IDBRequest<RecordingMetadata | undefined>)
    if (metadata === undefined) return null
    const events = await request(transaction.objectStore(EVENTS).index('recordingId').getAll(recordingId) as IDBRequest<RecordingEvent[]>)
    await transactionDone(transaction)
    events.sort((a, b) => a.sequence - b.sequence)
    return { ...metadata, events }
  }

  private async allMetadata(): Promise<RecordingMetadata[]> {
    const database = await this.open()
    const transaction = database.transaction(RECORDINGS, 'readonly')
    const all = await request(transaction.objectStore(RECORDINGS).getAll() as IDBRequest<RecordingMetadata[]>)
    await transactionDone(transaction)
    return all
  }
}
