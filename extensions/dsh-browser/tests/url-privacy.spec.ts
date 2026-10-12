// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeUrlForModel } from '../src/security/url-privacy.ts'

describe('model-facing URL privacy', () => {
  it('removes credentials, query parameters, and fragments', () => {
    expect(sanitizeUrlForModel('https://alice:secret@example.com/detail?uniqueId=private#section'))
      .toBe('https://example.com/detail')
  })

  it('masks UUID, long numeric, and token-like path identifiers', () => {
    expect(sanitizeUrlForModel('https://example.com/item/38b3a76b-816a-4239-8e9b-2a5d5d9d21bf/123456'))
      .toBe('https://example.com/item/:id/:id')
    expect(sanitizeUrlForModel('https://example.com/download/customer_20260928_private_token'))
      .toBe('https://example.com/download/:id')
  })

  it('resolves relative links without preserving their query data', () => {
    expect(sanitizeUrlForModel('/search?q=private', 'https://example.com/current'))
      .toBe('https://example.com/search')
  })

  it('rejects executable URL schemes', () => {
    expect(sanitizeUrlForModel('javascript:alert(1)')).toBe('')
  })
})
