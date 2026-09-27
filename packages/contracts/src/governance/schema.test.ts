import { expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { GovernanceResultSchema } from './schema'

const uuid = '01930000-0000-7000-8000-000000000011'

test('governance result target requires the matching public resource ID', () => {
  const result = {
    action: 'LISTING_DELISTED',
    targetType: 'LISTING',
    targetId: encodePublicId(PUBLIC_ID_PREFIX.listing, uuid),
    listingStatus: 'OFFLINE',
    restriction: null,
  }
  expect(GovernanceResultSchema.safeParse(result).success).toBe(true)
  for (const invalid of [uuid, encodePublicId(PUBLIC_ID_PREFIX.userRestriction, uuid)]) {
    expect(GovernanceResultSchema.safeParse({ ...result, targetId: invalid }).success).toBe(false)
  }
})
