import { describe, expect, test } from 'bun:test'
import { parseSearchParams } from './search-params'

describe('parseSearchParams', () => {
  test('keeps valid filters and trims the keyword', () => {
    expect(parseSearchParams({ q: '  K380  ', category: 'DIGITAL', sort: 'priceAsc' })).toEqual({
      q: 'K380',
      category: 'DIGITAL',
      sort: 'priceAsc',
    })
  })

  test('drops invalid filters and caps the keyword at 50 characters', () => {
    expect(
      parseSearchParams({ q: 'x'.repeat(60), category: 'NOT_A_CATEGORY', sort: 'random' }),
    ).toEqual({ q: 'x'.repeat(50), category: undefined, sort: undefined })
  })

  test('treats blank or missing keywords as absent', () => {
    expect(parseSearchParams({ q: '   ' })).toEqual({
      q: undefined,
      category: undefined,
      sort: undefined,
    })
  })
})
