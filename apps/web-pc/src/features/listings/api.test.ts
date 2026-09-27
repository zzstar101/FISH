import { describe, expect, test } from 'bun:test'
import { listingFeedPath } from './api'

describe('listingFeedPath', () => {
  test('encodes keyword, category, sort, limit and cursor', () => {
    expect(
      listingFeedPath({
        q: '机械键盘',
        category: 'DIGITAL',
        sort: 'priceAsc',
        limit: 24,
        cursor: 'abc+/=',
      }),
    ).toBe(
      '/listings?q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98&category=DIGITAL&sort=priceAsc&limit=24&cursor=abc%2B%2F%3D',
    )
  })

  test('omits absent optional filters', () => {
    expect(listingFeedPath({ sort: 'newest' })).toBe('/listings?sort=newest')
  })
})
