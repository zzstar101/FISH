import { expect, mock, test } from 'bun:test'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'

const NUMBER = '709541826303'
const ID = 'lst_01jc000000e00800000000000p'
const paths: string[] = []
let response: unknown = { id: ID }
let failure: Error | null = null

class FakeApiError extends Error {
  readonly status: number
  constructor(status: number) {
    super('lookup failed')
    this.status = status
  }
}

mock.module('@/lib/request', () => ({
  apiRequest: async (path: string) => {
    paths.push(path)
    if (failure) throw failure
    return response
  },
  isApiError: (error: unknown) => error instanceof FakeApiError,
}))

const { findListingByNumber } = await import('@/features/listing/api')

test('exact number lookup returns the public listing ID, without a feed search', async () => {
  paths.length = 0
  response = { id: ID }
  failure = null
  expect(await findListingByNumber(NUMBER)).toBe(ID)
  expect(paths).toEqual([LISTING_ROUTES.byNumber(NUMBER)])
})

test('a missing number stays missing and does not fall back to keyword search', async () => {
  paths.length = 0
  failure = new FakeApiError(404)
  expect(await findListingByNumber(NUMBER)).toBeNull()
  expect(paths).toEqual([LISTING_ROUTES.byNumber(NUMBER)])
})

test('rate limiting propagates to the caller instead of looking like an empty result', async () => {
  paths.length = 0
  failure = new FakeApiError(429)
  await expect(findListingByNumber(NUMBER)).rejects.toMatchObject({ status: 429 })
  expect(paths).toEqual([LISTING_ROUTES.byNumber(NUMBER)])
})
