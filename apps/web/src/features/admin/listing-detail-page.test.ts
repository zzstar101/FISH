import { expect, test } from 'bun:test'
import type { AdminListingDetail } from '@fish/contracts/admin/schema'
import { listingGovernanceActions } from './listing-detail-page'

const statuses = ['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'] as const satisfies ReadonlyArray<
  AdminListingDetail['status']
>

test('治理下架按审核状态而非交易/卖家状态开放', () => {
  for (const status of statuses) {
    const actions = listingGovernanceActions({
      status,
      moderationStatus: 'APPROVED',
      governanceDelistedAt: null,
    })
    expect(actions.map((spec) => spec.action)).toEqual(['delist-listing'])
  }
})

test('待审和审核屏蔽不能走治理下架；只有治理下架标记才能恢复', () => {
  for (const moderationStatus of ['REVIEW', 'BLOCKED'] as const) {
    expect(
      listingGovernanceActions({ status: 'ACTIVE', moderationStatus, governanceDelistedAt: null }),
    ).toEqual([])
  }
  expect(
    listingGovernanceActions({
      status: 'OFFLINE',
      moderationStatus: 'BLOCKED',
      governanceDelistedAt: '2026-09-26T00:00:00.000Z',
    }).map((spec) => spec.action),
  ).toEqual(['restore-listing'])
})
