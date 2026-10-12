// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildSkillExtractionEvidence,
  hasSkillExtractionCandidates,
} from '../src/skill/extraction-evidence.ts'
import type { RecordingEventInput, RecordingTarget } from '../src/recording/schema.ts'

const target: RecordingTarget = {
  tag: 'button', selector: '#search', name: '查询', control: 'button',
}

function context(capturedAt: number) {
  return {
    capturedAt,
    tab: { id: 1, windowId: 1, title: '反馈后台', url: 'https://example.com/feedback?private=1' },
    frame: { id: 0, url: 'https://example.com/feedback?private=1' },
  }
}

function click(capturedAt: number, override: Partial<RecordingTarget> = {}): RecordingEventInput {
  return { ...context(capturedAt), kind: 'click', button: 0, target: { ...target, ...override } }
}

describe('skill extraction evidence', () => {
  it('preserves the complete ordered timeline with absolute and relative timing', () => {
    const events: RecordingEventInput[] = [
      click(200_000),
      click(1_000, { selector: '#old', name: '旧操作' }),
      {
        ...context(200_400), kind: 'network', method: 'POST', url: 'https://example.com/api/search?token=private',
        statusCode: 200, durationMs: 400, request: { auth: { kind: 'cookie' } }, trigger: { kind: 'click', target },
      },
    ]
    const evidence = buildSkillExtractionEvidence(events)
    expect(evidence.timeline).toHaveLength(3)
    expect(evidence.timeline.map((event) => event.capturedAt)).toEqual([1_000, 200_000, 200_400])
    expect(evidence.timeline.map((event) => event.intervalFromPreviousMs)).toEqual([0, 199_000, 400])
    expect(evidence.timeline[2]?.offsetMs).toBe(199_400)
    expect(evidence.window.durationMs).toBe(199_400)
  })

  it('keeps overwritten inputs and outcomes while removing literal values and URL secrets', () => {
    const field: RecordingTarget = { tag: 'input', selector: '#phone', name: '手机号', control: 'input' }
    const events: RecordingEventInput[] = [
      { ...context(1_000), kind: 'input', target: field, value: { kind: 'literal', value: 'first-private-value' } },
      { ...context(1_200), kind: 'change', target: field, value: { kind: 'literal', value: 'final-private-value' } },
      click(2_000),
      {
        ...context(2_300), kind: 'network', method: 'POST', url: 'https://example.com/api/customer/123456789?token=private',
        statusCode: 200, durationMs: 300, request: { auth: { kind: 'cookie' } }, trigger: { kind: 'click', target },
      },
    ]
    const evidence = buildSkillExtractionEvidence(events, '查询客户反馈')
    expect(evidence.timeline.map((event) => event.kind)).toEqual(['input', 'change', 'click', 'network'])
    expect(evidence.timeline[0]?.details).toMatchObject({
      value: { kind: 'literal-redacted', placeholder: '{{input}}', characterCount: 19 },
    })
    expect(evidence.timeline[3]?.details).toMatchObject({
      url: 'https://example.com/api/customer/:id', method: 'POST', statusCode: 200,
    })
    expect(hasSkillExtractionCandidates(evidence)).toBe(true)
    expect(JSON.stringify(evidence)).not.toMatch(/first-private-value|final-private-value|token=private|private=1/)
  })

  it('preserves failed attempts for model judgment instead of filtering them', () => {
    const events: RecordingEventInput[] = [
      click(1_000),
      {
        ...context(1_300), kind: 'network', method: 'POST', url: 'https://example.com/api/search',
        statusCode: 500, durationMs: 300, failed: true, request: { auth: { kind: 'cookie' } }, trigger: { kind: 'click', target },
      },
      click(2_000),
      {
        ...context(2_200), kind: 'network', method: 'POST', url: 'https://example.com/api/search',
        statusCode: 200, durationMs: 200, request: { auth: { kind: 'cookie' } }, trigger: { kind: 'click', target },
      },
    ]
    const evidence = buildSkillExtractionEvidence(events)
    expect(evidence.timeline).toHaveLength(4)
    expect(evidence.timeline[1]?.details).toMatchObject({ statusCode: 500, failed: true })
    expect(evidence.timeline[3]?.details).toMatchObject({ statusCode: 200 })
  })

  it('supplies redacted request contracts and response list paths to the model', () => {
    const events: RecordingEventInput[] = [{
      ...context(1_000), kind: 'network', method: 'POST', url: 'https://example.com/api/search',
      durationMs: 120, statusCode: 200,
      request: {
        auth: { kind: 'cookie' }, bodyEncoding: 'json', body: {
          product: { kind: 'fixed', valueType: 'string', value: 'mobile', source: { selectedLabels: ['移动端'] } },
          keyword: { kind: 'input', valueType: 'string', placeholder: '{{input}}', source: { name: '内容关键词' } },
          startTime: { kind: 'input', valueType: 'number', placeholder: '{{input}}', format: 'unix-milliseconds' },
        },
      },
    }, {
      ...context(1_150), kind: 'network-response', method: 'POST', url: 'https://example.com/api/search', statusCode: 200,
      response: {
        fields: [{ path: 'data.list', type: 'array' }, { path: 'data.list[].content', type: 'string' }],
        listPaths: ['data.list'],
      },
    }]
    const evidence = buildSkillExtractionEvidence(events)
    expect(evidence.timeline[0]?.details).toMatchObject({
      requestContract: { auth: { kind: 'cookie' }, body: { product: { value: 'mobile' }, keyword: { placeholder: '{{input}}' } } },
    })
    expect(evidence.timeline[1]?.details).toMatchObject({ responseListPaths: ['data.list'] })
  })
})
