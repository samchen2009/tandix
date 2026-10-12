// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { RECORDING_SCHEMA_VERSION, emptyRecordingSummary, type RecordingMetadata } from '../src/recording/schema.ts'
import { INITIAL_TEACH_STATE, reduceTeachState } from '../src/recording/state-machine.ts'

function recording(status: 'recording' | 'stopped'): RecordingMetadata {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    id: 'recording-1',
    product: { name: 'TraceForge', tagline: 'Turn browser traces into reliable agent tasks.' },
    status,
    title: 'Checkout trace',
    startedAt: 10,
    updatedAt: 20,
    ...(status === 'stopped' ? { endedAt: 20 } : {}),
    windowId: 1,
    tabIds: [2],
    startPage: { title: 'Shop', url: 'https://example.com/' },
    summary: { ...emptyRecordingSummary(), eventCount: 3 },
  }
}

describe('Teach state machine', () => {
  it('moves through arming, recording, stopping, and recorded', () => {
    const arming = reduceTeachState(INITIAL_TEACH_STATE, { type: 'START_REQUESTED' })
    const active = reduceTeachState(arming, { type: 'STARTED', recording: recording('recording') })
    const stopping = reduceTeachState(active, { type: 'STOP_REQUESTED' })
    const stopped = reduceTeachState(stopping, { type: 'STOPPED', recording: recording('stopped') })

    expect([arming.phase, active.phase, stopping.phase, stopped.phase]).toEqual([
      'arming', 'recording', 'stopping', 'recorded',
    ])
    expect(stopped.summary?.eventCount).toBe(3)
  })

  it('restores an in-progress recording after a service worker restart', () => {
    expect(reduceTeachState(INITIAL_TEACH_STATE, {
      type: 'RESTORED',
      recording: recording('recording'),
    }).phase).toBe('recording')
  })
})
