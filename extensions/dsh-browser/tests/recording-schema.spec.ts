// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseDomCaptureEvent, parseNetworkResponseCapture, REDACTED_VALUE } from '../src/recording/schema.ts'

describe('TraceForge recording schema boundary', () => {
  it('normalizes secret values without accepting page-provided placeholders', () => {
    const event = parseDomCaptureEvent({
      kind: 'input',
      capturedAt: 123,
      target: { tag: 'INPUT', selector: '#password', name: 'Password' },
      value: { kind: 'secret', parameter: ' account password ', placeholder: 'raw secret' },
    })

    expect(event).toMatchObject({
      kind: 'input',
      target: { tag: 'input', selector: '#password' },
      value: { kind: 'secret', parameter: 'account password', placeholder: REDACTED_VALUE },
    })
    expect(JSON.stringify(event)).not.toContain('raw secret')
  })

  it('rejects malformed targets and unknown event kinds', () => {
    expect(parseDomCaptureEvent({ kind: 'click', target: { tag: 'button' } })).toBeNull()
    expect(parseDomCaptureEvent({ kind: 'cookie', target: { tag: 'button', selector: '#ok' } })).toBeNull()
  })

  it('accepts only bounded, value-free response schema evidence', () => {
    expect(parseNetworkResponseCapture({
      recordingId: 'recording-1', capturedAt: 123, url: 'https://example.com/api', method: 'post', statusCode: 200,
      fields: [{ path: 'data.list', type: 'array', value: 'must-not-cross' }, { path: 'data.list[].title', type: 'string' }],
      listPaths: ['data.list'],
    })).toEqual({
      recordingId: 'recording-1', capturedAt: 123, url: 'https://example.com/api', method: 'POST', statusCode: 200,
      fields: [{ path: 'data.list', type: 'array' }, { path: 'data.list[].title', type: 'string' }],
      listPaths: ['data.list'],
    })
  })
})
