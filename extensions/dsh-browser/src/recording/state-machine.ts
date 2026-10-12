import type { RecordingMetadata, RecordingSummary } from './schema.ts'

export type TeachPhase = 'idle' | 'arming' | 'recording' | 'stopping' | 'recorded' | 'error'

export interface TeachState {
  phase: TeachPhase
  recordingId?: string
  title?: string
  startedAt?: number
  summary?: RecordingSummary
  error?: string
}

export type TeachTransition =
  | { type: 'START_REQUESTED' }
  | { type: 'STARTED'; recording: RecordingMetadata }
  | { type: 'EVENT_APPENDED'; recording: RecordingMetadata }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOPPED'; recording: RecordingMetadata }
  | { type: 'RESTORED'; recording: RecordingMetadata | null }
  | { type: 'FAILED'; message: string }
  | { type: 'RESET' }

export const INITIAL_TEACH_STATE: TeachState = { phase: 'idle' }

function fromRecording(recording: RecordingMetadata, phase: 'recording' | 'recorded'): TeachState {
  return {
    phase,
    recordingId: recording.id,
    title: recording.title,
    startedAt: recording.startedAt,
    summary: recording.summary,
  }
}

/** Pure state machine shared by the background service and tests. */
export function reduceTeachState(state: TeachState, transition: TeachTransition): TeachState {
  switch (transition.type) {
    case 'START_REQUESTED':
      return state.phase === 'recording' ? state : { phase: 'arming' }
    case 'STARTED':
    case 'EVENT_APPENDED':
      return fromRecording(transition.recording, 'recording')
    case 'STOP_REQUESTED':
      return state.phase === 'recording' ? { ...state, phase: 'stopping' } : state
    case 'STOPPED':
      return fromRecording(transition.recording, 'recorded')
    case 'RESTORED':
      return transition.recording === null
        ? INITIAL_TEACH_STATE
        : fromRecording(transition.recording, transition.recording.status === 'recording' ? 'recording' : 'recorded')
    case 'FAILED':
      return { ...state, phase: 'error', error: transition.message }
    case 'RESET':
      return INITIAL_TEACH_STATE
  }
}
