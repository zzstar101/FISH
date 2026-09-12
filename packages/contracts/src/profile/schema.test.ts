import { describe, expect, test } from 'bun:test'
import { profileResponseSchema, profileTransactionStatusSchema } from './schema'

const me = {
  id: '00000000-0000-4000-8000-0000000000a1',
  nickname: '小明',
  avatarUrl: null,
  campus: '肇庆',
  authStatus: 'VERIFIED',
  verifiedAt: '2026-09-12T00:00:00.000Z',
}

const listingCard = {
  id: '00000000-0000-4000-8000-0000000000b1',
  title: 'K380 键盘',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  status: 'OFFLINE', // 本人视角可见非在售状态
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-12T01:00:00.000Z',
}

const wish = {
  id: '00000000-0000-4000-8000-0000000000d1',
  userId: me.id,
  keyword: '机械键盘',
  category: 'DIGITAL',
  budgetMinCents: 10000,
  budgetMaxCents: 20000,
  description: null,
  acceptSimilar: true,
  status: 'ACTIVE',
  matchCount: 2,
  createdAt: '2026-09-12T02:00:00.000Z',
  updatedAt: '2026-09-12T02:00:00.000Z',
}

const transaction = {
  id: '00000000-0000-4000-8000-0000000000e1',
  listingId: listingCard.id,
  role: 'buyer',
  amountCents: 15000,
  status: 'COMPLETED',
  createdAt: '2026-09-12T03:00:00.000Z',
}

const profile = {
  user: me,
  stats: { activeListings: 1, activeWishes: 1, completedTransactions: 1 },
  listings: [listingCard],
  wishes: [wish],
  transactions: [transaction],
}

describe('profileResponseSchema', () => {
  test('parses the full aggregate', () => {
    const parsed = profileResponseSchema.parse(profile)
    expect(parsed.user.authStatus).toBe('VERIFIED')
    expect(parsed.stats).toEqual({ activeListings: 1, activeWishes: 1, completedTransactions: 1 })
    // 本人视角的商品可以是非在售状态（listings 契约的 ListingStatusSchema 收窄）
    expect(parsed.listings[0]?.status).toBe('OFFLINE')
    expect(parsed.wishes[0]?.matchCount).toBe(2)
    expect(parsed.transactions[0]?.role).toBe('buyer')
  })

  test('rejects an unknown transaction status or role', () => {
    expect(
      profileResponseSchema.safeParse({
        ...profile,
        transactions: [{ ...transaction, status: 'REQUESTED' }],
      }).success,
    ).toBe(false)
    expect(
      profileResponseSchema.safeParse({
        ...profile,
        transactions: [{ ...transaction, role: 'admin' }],
      }).success,
    ).toBe(false)
  })

  test('strips sensitive fields from the me block (MeSchema 非 strict，但永不透传学号)', () => {
    const parsed = profileResponseSchema.parse({
      ...profile,
      user: { ...me, studentNo: '202101000001' },
    })
    expect(Object.hasOwn(parsed.user, 'studentNo')).toBe(false)
  })
})

describe('profileTransactionStatusSchema', () => {
  test('mirrors the DB transaction_status enum values', () => {
    expect(profileTransactionStatusSchema.options).toEqual([
      'PENDING_MEETUP',
      'COMPLETED',
      'CANCELLED',
    ])
  })
})
