import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  meetupTokenRedeemInputSchema,
  meetupTokenResponseSchema,
  meetupTokenStatusResponseSchema,
  meetupTokenVerifyCodeInputSchema,
  meetupVerificationResponseSchema,
  TransactionErrorCodeSchema,
  transactionAcceptInputSchema,
  transactionDtoSchema,
  transactionListQuerySchema,
  transactionProposalInputSchema,
  transactionRejectInputSchema,
  transactionStatusSchema,
  transactionSystemEventSchema,
} from './schema'

const conversationId = encodePublicId(
  PUBLIC_ID_PREFIX.conversation,
  '01930000-0000-7000-8000-0000000000c1',
)

describe('transactionProposalInputSchema', () => {
  test('accepts a valid proposal', () => {
    const input = { conversationId, amountCents: 16000 }
    expect(transactionProposalInputSchema.parse(input)).toEqual(input)
  })

  test('rejects a non-uuid conversationId and extra fields', () => {
    expect(
      transactionProposalInputSchema.safeParse({ conversationId: 'nope', amountCents: 1 }).success,
    ).toBe(false)
    expect(
      transactionProposalInputSchema.safeParse({ conversationId, amountCents: 1, listingId: 'x' })
        .success,
    ).toBe(false)
  })

  test('rejects a negative or over-cap amount (复用 #6 的 PriceCentsSchema)', () => {
    expect(
      transactionProposalInputSchema.safeParse({ conversationId, amountCents: -1 }).success,
    ).toBe(false)
    expect(
      transactionProposalInputSchema.safeParse({ conversationId, amountCents: 10_000_001 }).success,
    ).toBe(false)
  })

  test('accepts 0 (0 元送)', () => {
    expect(transactionProposalInputSchema.parse({ conversationId, amountCents: 0 })).toEqual({
      conversationId,
      amountCents: 0,
    })
  })
})

describe('transactionAcceptInputSchema', () => {
  test('accepts a valid accept payload', () => {
    expect(transactionAcceptInputSchema.parse({ conversationId, amountCents: 15000 })).toEqual({
      conversationId,
      amountCents: 15000,
    })
  })

  test('rejects a missing amount (提案不落库，接受必须重传成交价)', () => {
    expect(transactionAcceptInputSchema.safeParse({ conversationId }).success).toBe(false)
  })
})

describe('transactionRejectInputSchema', () => {
  test('accepts a bare conversationId and rejects extras', () => {
    expect(transactionRejectInputSchema.parse({ conversationId })).toEqual({ conversationId })
    expect(transactionRejectInputSchema.safeParse({ conversationId, amountCents: 1 }).success).toBe(
      false,
    )
  })
})

describe('transactionListQuerySchema', () => {
  test('applies limit default and coerces query strings', () => {
    expect(transactionListQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(transactionListQuerySchema.parse({ limit: '5', role: 'buyer' })).toEqual({
      limit: 5,
      role: 'buyer',
    })
  })

  test('rejects unknown role/status and limit over 50', () => {
    expect(transactionListQuerySchema.safeParse({ role: 'admin' }).success).toBe(false)
    expect(transactionListQuerySchema.safeParse({ status: 'REQUESTED' }).success).toBe(false)
    expect(transactionListQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
  })
})

describe('transactionStatusSchema', () => {
  test('has exactly the three DB enum values', () => {
    expect(transactionStatusSchema.options).toEqual(['PENDING_MEETUP', 'COMPLETED', 'CANCELLED'])
  })
})

describe('transactionDtoSchema', () => {
  const base = {
    id: encodePublicId(PUBLIC_ID_PREFIX.transaction, '01930000-0000-7000-8000-0000000000e1'),
    conversationId,
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b1'),
    buyerId: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a1'),
    sellerId: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a2'),
    role: 'buyer',
    listing: {
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b1'),
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'RESERVED',
      coverUrl: null,
    },
    counterpart: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a2'),
      nickname: '卖家小王',
      avatarUrl: null,
    },
    amountCents: 16000,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
  }

  test('parses a live transaction with null confirm timestamps', () => {
    const dto = {
      ...base,
      status: 'PENDING_MEETUP',
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      completedAt: null,
      cancelledAt: null,
    }
    const parsed = transactionDtoSchema.parse(dto)
    expect(parsed.status).toBe('PENDING_MEETUP')
    expect(parsed.completedAt).toBeNull()
    expect(parsed.listing.title).toBe('K380 键盘')
    expect(parsed.counterpart.nickname).toBe('卖家小王')
  })

  test('parses a completed transaction with all timestamps', () => {
    const dto = {
      ...base,
      status: 'COMPLETED',
      buyerConfirmedAt: '2026-09-12T11:00:00.000Z',
      sellerConfirmedAt: '2026-09-12T11:01:00.000Z',
      completedAt: '2026-09-12T11:01:00.000Z',
      cancelledAt: null,
    }
    expect(transactionDtoSchema.parse(dto).status).toBe('COMPLETED')
  })

  test('rejects COMPLETED without completedAt and CANCELLED without cancelledAt (DB CHECK 同源)', () => {
    const timestamps = {
      buyerConfirmedAt: '2026-09-12T11:00:00.000Z',
      sellerConfirmedAt: '2026-09-12T11:01:00.000Z',
      completedAt: null,
      cancelledAt: null,
    }
    expect(
      transactionDtoSchema.safeParse({ ...base, status: 'COMPLETED', ...timestamps }).success,
    ).toBe(false)
    expect(
      transactionDtoSchema.safeParse({
        ...base,
        status: 'CANCELLED',
        buyerConfirmedAt: null,
        sellerConfirmedAt: null,
        completedAt: null,
        cancelledAt: null,
      }).success,
    ).toBe(false)
    // 反向：非终态携带终态时间戳同样拒绝
    expect(
      transactionDtoSchema.safeParse({
        ...base,
        status: 'PENDING_MEETUP',
        buyerConfirmedAt: null,
        sellerConfirmedAt: null,
        completedAt: '2026-09-12T11:01:00.000Z',
        cancelledAt: null,
      }).success,
    ).toBe(false)
  })

  test('rejects an unknown status', () => {
    const dto = {
      ...base,
      status: 'REQUESTED',
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      completedAt: null,
      cancelledAt: null,
    }
    expect(transactionDtoSchema.safeParse(dto).success).toBe(false)
  })

  test('rejects an invalid embedded listing status', () => {
    const dto = {
      ...base,
      status: 'PENDING_MEETUP',
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      completedAt: null,
      cancelledAt: null,
    }
    expect(
      transactionDtoSchema.safeParse({ ...dto, listing: { ...dto.listing, status: 'GONE' } })
        .success,
    ).toBe(false)
  })
})

describe('transactionSystemEventSchema', () => {
  test('parses all three event kinds', () => {
    expect(
      transactionSystemEventSchema.parse({ type: 'tx.proposal', amountCents: 16000 }).type,
    ).toBe('tx.proposal')
    expect(
      transactionSystemEventSchema.parse({
        type: 'tx.accepted',
        transactionId: encodePublicId(
          PUBLIC_ID_PREFIX.transaction,
          '01930000-0000-7000-8000-0000000000e1',
        ),
        amountCents: 16000,
      }).type,
    ).toBe('tx.accepted')
    expect(transactionSystemEventSchema.parse({ type: 'tx.rejected' }).type).toBe('tx.rejected')
  })

  test('rejects unknown or malformed events', () => {
    expect(transactionSystemEventSchema.safeParse({ type: 'tx.cancelled' }).success).toBe(false)
    expect(
      transactionSystemEventSchema.safeParse({ type: 'tx.proposal', amountCents: 'cheap' }).success,
    ).toBe(false)
  })
})

describe('meetup token schemas', () => {
  const transactionId = encodePublicId(
    PUBLIC_ID_PREFIX.transaction,
    '01930000-0000-7000-8000-0000000000e1',
  )
  const verifiedAt = '2026-09-12T10:10:00.000Z'

  test('accepts an issued token response without exposing hashes or expiry', () => {
    // #147：凭证随交易生命周期（PENDING_MEETUP 内长期有效），响应不再有 expiresAt。
    expect(
      meetupTokenResponseSchema.parse({
        transactionId,
        code: '012345',
        qrPayload: 'fish://meetup/redeem?t=opaque-token',
      }),
    ).toMatchObject({ transactionId, code: '012345' })
    expect(
      meetupTokenResponseSchema.safeParse({
        transactionId,
        code: '01234',
        qrPayload: 'fish://meetup/redeem?t=opaque-token',
        codeHash: 'must-not-leak',
      }).success,
    ).toBe(false)
    expect(
      meetupTokenResponseSchema.safeParse({
        transactionId,
        code: '012345',
        qrPayload: 'fish://meetup/redeem?t=opaque-token',
        expiresAt: verifiedAt,
      }).success,
    ).toBe(false)
  })

  test('validates code and QR redemption inputs strictly', () => {
    expect(meetupTokenVerifyCodeInputSchema.safeParse({ code: '012345' }).success).toBe(true)
    expect(meetupTokenVerifyCodeInputSchema.safeParse({ code: '12345a' }).success).toBe(false)
    expect(meetupTokenRedeemInputSchema.safeParse({ qrToken: 'opaque-token' }).success).toBe(true)
    expect(meetupTokenRedeemInputSchema.safeParse({ qrToken: '' }).success).toBe(false)
    expect(
      meetupTokenRedeemInputSchema.safeParse({ qrToken: 'opaque-token', transactionId }).success,
    ).toBe(false)
  })

  test('parses status and successful verification responses', () => {
    expect(
      meetupTokenStatusResponseSchema.parse({
        transactionId,
        status: 'ISSUED',
        consumedAt: null,
        consumedBy: null,
      }).status,
    ).toBe('ISSUED')
    expect(
      meetupVerificationResponseSchema.parse({
        transactionId,
        verified: true,
        verifiedBy: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a1'),
        verifiedAt,
        nextAction: 'CONFIRM_DELIVERY',
      }).nextAction,
    ).toBe('CONFIRM_DELIVERY')
  })
})

describe('TransactionErrorCodeSchema', () => {
  test('accepts meetup token errors and rejects an unknown code', () => {
    // #147：长期凭证下 EXPIRED 不再是可达路径，契约同步删除（不留兼容死枚举）。
    expect(TransactionErrorCodeSchema.safeParse('MEETUP_TOKEN_EXPIRED').success).toBe(false)
    expect(TransactionErrorCodeSchema.safeParse('MEETUP_TOKEN_LOCKED').success).toBe(true)
    expect(TransactionErrorCodeSchema.safeParse('TX_GONE_WRONG').success).toBe(false)
  })
})
