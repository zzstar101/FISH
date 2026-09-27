import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ApiError } from '../../lib/api-client'
import { findListingByNumber } from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const listingNo = '348572910465'
const listingId = 'lst_01jc000000e008000000000051'

describe('Web listing number lookup', () => {
  test('uses exact endpoint and returns canonical lst_ ID', async () => {
    const fetcher = mock(async (_input: RequestInfo | URL) => Response.json({ id: listingId }))
    globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect })
    expect(await findListingByNumber(listingNo)).toBe(listingId)
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/listings/by-number/${listingNo}`)
  })

  test('only 404 is an empty result, rate limit and unavailable source remain errors', async () => {
    for (const status of [404, 429, 503]) {
      globalThis.fetch = Object.assign(
        async () =>
          Response.json({ error: { code: 'LISTING_NOT_FOUND', message: '未找到' } }, { status }),
        { preconnect: originalFetch.preconnect },
      )
      if (status === 404) {
        expect(await findListingByNumber(listingNo)).toBeNull()
      } else {
        await expect(findListingByNumber(listingNo)).rejects.toMatchObject({
          status,
          name: 'ApiError',
        } satisfies Partial<ApiError>)
      }
    }
  })
})
