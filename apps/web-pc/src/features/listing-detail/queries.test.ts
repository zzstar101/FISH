import { describe, expect, test } from 'bun:test'
import { listingDetailQueryKey } from './queries'

describe('listing detail query key', () => {
  test('keeps viewer-dependent detail data isolated per account', () => {
    expect(listingDetailQueryKey('listing-1', 'owner-a')).not.toEqual(
      listingDetailQueryKey('listing-1', 'owner-b'),
    )
    expect(listingDetailQueryKey('listing-1')).toEqual(listingDetailQueryKey('listing-1', null))
  })
})
