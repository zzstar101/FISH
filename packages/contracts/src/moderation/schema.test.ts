import { expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { ModerationRecordSchema } from './schema'

const uuid = '01930000-0000-7000-8000-0000000000a1'
const record = {
  id: encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, uuid),
  listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, uuid),
  sellerId: encodePublicId(PUBLIC_ID_PREFIX.user, uuid),
  action: 'REVIEW',
  titleSnapshot: '旧商品',
  descriptionSnapshot: '',
  decision: 'REVIEW',
  matchedRules: [],
  matchedTermsMasked: [],
  ruleVersion: 'v1',
  createdAt: '2026-09-26T00:00:00.000Z',
}

test('审核资源公开契约只接受各字段对应的规范 TypeID', () => {
  expect(ModerationRecordSchema.safeParse(record).success).toBe(true)
  expect(ModerationRecordSchema.safeParse({ ...record, id: uuid }).success).toBe(false)
  expect(ModerationRecordSchema.safeParse({ ...record, sellerId: record.listingId }).success).toBe(
    false,
  )
})
