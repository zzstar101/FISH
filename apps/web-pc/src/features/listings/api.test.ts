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

  // #451：契约的 `free` 只接受 `true` / `false` 两个字面量（`z.enum(...)`），
  // 拼成 `1` / `on` 之类会被 422 拒。
  test('encodes the free filter as a literal', () => {
    expect(listingFeedPath({ sort: 'newest', free: true })).toBe('/listings?free=true&sort=newest')
    expect(listingFeedPath({ sort: 'newest', free: false })).toBe(
      '/listings?free=false&sort=newest',
    )
  })
})
