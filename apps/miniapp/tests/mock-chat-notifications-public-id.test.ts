import { expect, test } from 'bun:test'
import { notificationDtoSchema } from '@fish/contracts/notifications/schema'
import { isPublicId } from '@fish/shared/public-id'
import { findListing, notifications } from '../src/mock/api'
import { NOTIFICATIONS } from '../src/mock/discover'

test('演示通知与商品入口符合公开 ID 契约', () => {
  for (const item of NOTIFICATIONS) {
    expect(notificationDtoSchema.safeParse(item).success).toBe(true)
  }
  for (const item of notifications()) {
    if (item.target?.kind !== 'listing') continue
    expect(isPublicId('lst', item.target.listingId)).toBe(true)
    expect(findListing(item.target.listingId)).toBeDefined()
  }
})
