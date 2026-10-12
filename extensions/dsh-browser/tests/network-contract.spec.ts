// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { authenticationEvidence, requestEvidence } from '../src/recording/network-contract.ts'
import type { RecentFormValue } from '../src/recording/network-contract.ts'

const recent: RecentFormValue[] = [{
  capturedAt: 1,
  event: {
    kind: 'select', capturedAt: 1,
    target: { tag: 'select', selector: '#product', name: '产品', control: 'select' },
    value: { kind: 'literal', value: 'MOBILE' }, selectedLabels: ['移动端'],
  },
}, {
  capturedAt: 2,
  event: {
    kind: 'input', capturedAt: 2,
    target: { tag: 'input', selector: '#keyword', name: '内容关键词', control: 'input' },
    value: { kind: 'literal', value: '投屏' },
  },
}]

describe('network interface contract evidence', () => {
  it('maps select codes, runtime inputs and temporal formats without retaining secrets', () => {
    const body = new TextEncoder().encode(JSON.stringify({
      product: 'MOBILE', keyword: '投屏', description: 'not captured in DOM', startTime: 1_790_496_000_000, token: 'private-token',
    })).buffer
    const evidence = requestEvidence('https://example.com/search?page=1', { raw: [{ bytes: body }] }, recent)
    expect(evidence.query?.page).toMatchObject({ kind: 'fixed', value: '1' })
    expect(evidence.body?.product).toMatchObject({ kind: 'fixed', value: 'MOBILE', source: { selectedLabels: ['移动端'] } })
    expect(evidence.body?.keyword).toMatchObject({ kind: 'input', placeholder: '{{input}}', source: { name: '内容关键词' } })
    expect(evidence.body?.startTime).toMatchObject({ kind: 'input', format: 'unix-milliseconds' })
    expect(evidence.body?.description).toEqual({ kind: 'input', valueType: 'string', placeholder: '{{input}}' })
    expect(evidence.body?.token).toEqual({ kind: 'redacted', valueType: 'string', placeholder: '{{secret}}' })
    expect(JSON.stringify(evidence)).not.toMatch(/private-token|not captured in DOM/)
  })

  it('records only the authentication mechanism', () => {
    expect(authenticationEvidence([{ name: 'Cookie', value: 'session=private' }])).toEqual({ kind: 'cookie' })
    expect(authenticationEvidence([{ name: 'Authorization', value: 'Bearer private' }])).toEqual({ kind: 'bearer' })
    expect(JSON.stringify(authenticationEvidence([{ name: 'Cookie', value: 'session=private' }]))).not.toContain('private')
  })
})
