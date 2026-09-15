import { describe, expect, test } from 'bun:test'
import {
  meetupCodeResponseSchema,
  meetupCodeVerifyInputSchema,
  meetupCodeVerifyResponseSchema,
  TransactionErrorCodeSchema,
  transactionAcceptInputSchema,
  transactionDtoSchema,
  transactionListQuerySchema,
  transactionProposalInputSchema,
  transactionRejectInputSchema,
  transactionStatusSchema,
  transactionSystemEventSchema,
} from './schema'

const conversationId = '1d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f'

describe('meetupCodeVerifyInputSchema', () => {
  test('accepts either a six-digit code or an opaque QR payload', () => {
    expect(meetupCodeVerifyInputSchema.parse({ code: '482913' })).toEqual({ code: '482913' })
    expect(
      meetupCodeVerifyInputSchema.parse({ qrPayload: 'fish://meetup/v1/opaque-token' }),
    ).toEqual({ qrPayload: 'fish://meetup/v1/opaque-token' })
  })

  test('rejects malformed, empty, or ambiguous verification input', () => {
    expect(meetupCodeVerifyInputSchema.safeParse({ code: '12345' }).success).toBe(false)
    expect(
      meetupCodeVerifyInputSchema.safeParse({ code: '123456', qrPayload: 'extra' }).success,
    ).toBe(false)
    expect(meetupCodeVerifyInputSchema.safeParse({ qrPayload: '   ' }).success).toBe(false)
  })
})

describe('meetupCodeResponseSchema', () => {
  test('requires a six-digit code and an expiry timestamp', () => {
    const parsed = meetupCodeResponseSchema.parse({
      challengeId: conversationId,
      code: '482913',
      qrPayload: 'fish://meetup/v1/opaque-token',
      expiresAt: '2026-09-15T12:10:00.000Z',
    })
    expect(parsed.code).toBe('482913')
  })
})

describe('meetupCodeVerifyResponseSchema', () => {
  test('contains the updated transaction and verification side', () => {
    const transaction = {
      id: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      conversationId,
      listingId: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      buyerId: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      sellerId: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      role: 'buyer',
      listing: {
        id: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'RESERVED',
        coverUrl: null,
      },
      counterpart: {
        id: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        nickname: '卖家',
        avatarUrl: null,
      },
      amountCents: 16000,
      status: 'PENDING_MEETUP',
      buyerConfirmedAt: '2026-09-15T12:00:00.000Z',
      sellerConfirmedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: '2026-09-15T11:00:00.000Z',
      updatedAt: '2026-09-15T12:00:00.000Z',
    }
    expect(
      meetupCodeVerifyResponseSchema.parse({ transaction, verifiedRole: 'buyer', completed: false })
        .completed,
    ).toBe(false)
  })
})

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
    id: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
    listingId: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
    buyerId: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
    sellerId: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
    role: 'buyer',
    listing: {
      id: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'RESERVED',
      coverUrl: null,
    },
    counterpart: {
      id: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
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
        transactionId: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
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

describe('TransactionErrorCodeSchema', () => {
  test('rejects an unknown code', () => {
    expect(TransactionErrorCodeSchema.safeParse('TX_GONE_WRONG').success).toBe(false)
  })
})
