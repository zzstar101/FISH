import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  notificationDtoSchema,
  notificationListQuerySchema,
  notificationPayloadSchema,
  notificationTypeSchema,
  notificationUnreadCountSchema,
} from './schema'

const UUID = '0199a000-0000-7000-8000-000000000001'
const notificationId = encodePublicId(PUBLIC_ID_PREFIX.notification, UUID)
const matchId = encodePublicId(PUBLIC_ID_PREFIX.match, UUID)
const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, UUID)
const wishId = encodePublicId(PUBLIC_ID_PREFIX.wish, UUID)

const validDto = {
  id: notificationId,
  type: 'MATCH',
  payload: { matchId, listingId, wishId },
  readAt: null,
  createdAt: '2026-09-12T10:00:00.000Z',
} as const

describe('notificationListQuerySchema', () => {
  test('defaults limit to 20 and coerces it from the query string', () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(notificationListQuerySchema.parse({ limit: '3' })).toEqual({ limit: 3 })
  })

  test('rejects an out-of-range or non-numeric limit', () => {
    for (const limit of [0, 51, 'abc']) {
      expect(notificationListQuerySchema.safeParse({ limit }).success).toBe(false)
    }
    expect(notificationListQuerySchema.safeParse({ limit: 1 }).success).toBe(true)
    expect(notificationListQuerySchema.safeParse({ limit: 50 }).success).toBe(true)
  })

  test('rejects an unknown query parameter instead of dropping it', () => {
    expect(notificationListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false)
  })
})

describe('notificationPayloadSchema', () => {
  // 三个 id 都可选：它们指向的对象可能已被删除（#6 口径），缺了不该让整页打不开。
  test('accepts a partial or empty payload and strips unknown keys', () => {
    expect(notificationPayloadSchema.parse({})).toEqual({})
    expect(notificationPayloadSchema.parse({ listingId })).toEqual({ listingId })
    expect(notificationPayloadSchema.parse({ matchId, extra: true })).toEqual({ matchId })
  })

  // 值必须是字符串：store 的 SQL 谓词正是按这条判据把「键存在但不是字符串」的行挡在
  // SELECT 之外（`projectable`），谓词比契约严一格会藏掉合法行，松一格会让脏行把列表打成 500。
  test('rejects non-string IDs, wrong prefixes and bare UUIDs', () => {
    for (const matchId of [5, null, listingId, UUID]) {
      expect(notificationPayloadSchema.safeParse({ matchId }).success).toBe(false)
    }
  })
})

describe('notificationDtoSchema', () => {
  test('rejects a bare or wrong-prefix notification ID', () => {
    for (const id of [UUID, listingId]) {
      expect(notificationDtoSchema.safeParse({ ...validDto, id }).success).toBe(false)
    }
  })

  test('accepts readAt: null as 未读 and an ISO timestamp as 已读', () => {
    expect(notificationDtoSchema.parse(validDto).readAt).toBeNull()
    expect(
      notificationDtoSchema.parse({ ...validDto, readAt: '2026-09-12T09:30:00.000Z' }).readAt,
    ).toBe('2026-09-12T09:30:00.000Z')
    expect(notificationDtoSchema.safeParse({ ...validDto, readAt: 'yesterday' }).success).toBe(
      false,
    )
  })

  // 值集钉在契约里（store 的 type 谓词直接取 `notificationTypeSchema.options`）：
  // 加类型时扩枚举，而不是放宽这条校验。
  test('rejects a type outside the enum', () => {
    expect(notificationTypeSchema.options).toEqual([
      'MATCH',
      'TX',
      'MODERATION',
      'ACCOUNT',
      'DISPUTE',
    ])
    expect(notificationDtoSchema.safeParse({ ...validDto, type: 'PRICE_DROP' }).success).toBe(false)
  })
})

describe('notificationPayloadSchema（TX / MODERATION / ACCOUNT）', () => {
  const transactionId = encodePublicId(PUBLIC_ID_PREFIX.transaction, UUID)
  const conversationId = encodePublicId(PUBLIC_ID_PREFIX.conversation, UUID)

  test('accepts a TX payload with event and optional ids', () => {
    expect(
      notificationPayloadSchema.parse({
        event: 'PROPOSED',
        conversationId,
        listingId,
      }),
    ).toEqual({ event: 'PROPOSED', conversationId, listingId })
    expect(
      notificationPayloadSchema.parse({ event: 'COMPLETED', transactionId, conversationId }),
    ).toEqual({ event: 'COMPLETED', transactionId, conversationId })
  })

  test('rejects an unknown TX event, outcome or subject value', () => {
    for (const payload of [
      { event: 'PRICE_DROP' },
      { outcome: 'PENDING' },
      { subject: 'PASSWORD' },
    ]) {
      expect(notificationPayloadSchema.safeParse(payload).success).toBe(false)
    }
  })

  test('accepts MODERATION / ACCOUNT payloads keyed by outcome', () => {
    expect(notificationPayloadSchema.parse({ listingId, outcome: 'APPROVED' })).toEqual({
      listingId,
      outcome: 'APPROVED',
    })
    expect(
      notificationPayloadSchema.parse({ subject: 'VERIFICATION', outcome: 'REJECTED' }),
    ).toEqual({ subject: 'VERIFICATION', outcome: 'REJECTED' })
  })
})

describe('notificationPayloadSchema（DISPUTE，#465）', () => {
  const disputeId = encodePublicId(PUBLIC_ID_PREFIX.dispute, UUID)
  const transactionId = encodePublicId(PUBLIC_ID_PREFIX.transaction, UUID)

  test('accepts a DISPUTE payload keyed by disputeEvent, resolution only when 出结论', () => {
    expect(
      notificationPayloadSchema.parse({ disputeId, transactionId, disputeEvent: 'FILED' }),
    ).toEqual({ disputeId, transactionId, disputeEvent: 'FILED' })
    expect(
      notificationPayloadSchema.parse({
        disputeId,
        transactionId,
        disputeEvent: 'RESOLVED',
        resolution: 'UPHELD',
      }),
    ).toEqual({ disputeId, transactionId, disputeEvent: 'RESOLVED', resolution: 'UPHELD' })
  })

  test('rejects an unknown disputeEvent / resolution and a bare disputeId', () => {
    for (const payload of [
      { disputeId, disputeEvent: 'APPEALED' },
      // 实现早期叫 CREATED，plan 冻结为 FILED：旧名必须被拒（否则两个写入侧会各写一套）。
      { disputeId, disputeEvent: 'CREATED' },
      { disputeId, disputeEvent: 'RESOLVED', resolution: 'REFUNDED' },
      { disputeId: UUID, disputeEvent: 'FILED' },
    ]) {
      expect(notificationPayloadSchema.safeParse(payload).success).toBe(false)
    }
  })
})

describe('notificationUnreadCountSchema', () => {
  test('rejects a negative or non-integer count', () => {
    expect(notificationUnreadCountSchema.parse({ unreadCount: 0 })).toEqual({ unreadCount: 0 })
    expect(notificationUnreadCountSchema.safeParse({ unreadCount: -1 }).success).toBe(false)
    expect(notificationUnreadCountSchema.safeParse({ unreadCount: 1.5 }).success).toBe(false)
  })
})
