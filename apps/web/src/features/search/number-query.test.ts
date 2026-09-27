import { describe, expect, test } from 'bun:test'
import { isListingNumberQuery } from './number-query'

describe('search number routing', () => {
  test('only a complete 12-digit listing reference uses exact lookup', () => {
    expect(isListingNumberQuery(' 348572910465 ')).toBe(true)
    for (const keyword of ['034857291046', '34857291046', '3485729104656', '课本 348572910465']) {
      expect(isListingNumberQuery(keyword)).toBe(false)
    }
  })
})
