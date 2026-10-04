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

  // #451：只有字面量 `"true"` 打开「免费送」筛选。
  // `"false"` 与垃圾值一律回退成「不过滤」—— web-pc 没有「只看非免费送」那一档，
  // 若把 `"false"` 解成 `free = false`，会出现「chip 未选中、列表却在筛非免费送」的矛盾界面。
  test('only the literal "true" turns the free filter on', () => {
    expect(parseSearchParams({ free: 'true' }).free).toBe(true)
    expect(parseSearchParams({ free: 'false' }).free).toBeUndefined()
    expect(parseSearchParams({ free: '' }).free).toBeUndefined()
    expect(parseSearchParams({ free: 1 }).free).toBeUndefined()
  })
})
