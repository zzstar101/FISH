import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { profileResponseSchema, profileUpdateRequestSchema } from './schema'

const me = {
  id: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a1'),
  nickname: '小明',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: '2026-09-12T00:00:00.000Z',
  phoneBound: false,
  maskedPhone: null,
}

const listingCard = {
  id: encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b1'),
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
  moderationStatus: null,
}

const wish = {
  id: encodePublicId(PUBLIC_ID_PREFIX.wish, '01930000-0000-7000-8000-0000000000d1'),
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
  id: encodePublicId(PUBLIC_ID_PREFIX.transaction, '01930000-0000-7000-8000-0000000000e1'),
  listingId: listingCard.id,
  role: 'buyer',
  listing: {
    id: listingCard.id,
    title: 'K380 键盘',
    priceCents: 16000,
    status: 'SOLD',
    coverUrl: null,
  },
  counterpart: {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a2'),
    nickname: '卖家小王',
    avatarUrl: null,
  },
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
    // 订单卡摘要：内嵌商品与对方用户（与 #11 冻结版同形）
    expect(parsed.transactions[0]?.listing.title).toBe('K380 键盘')
    expect(parsed.transactions[0]?.counterpart.nickname).toBe('卖家小王')
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

describe('profileUpdateRequestSchema（#86 B：编辑资料）', () => {
  test('只改昵称 / 只改头像 / 两者同改都接受', () => {
    expect(profileUpdateRequestSchema.parse({ nickname: '小鱼' })).toEqual({ nickname: '小鱼' })
    expect(profileUpdateRequestSchema.parse({ avatarObjectKey: 'listings/u/a.jpg' })).toEqual({
      avatarObjectKey: 'listings/u/a.jpg',
    })
    expect(
      profileUpdateRequestSchema.parse({ nickname: '小鱼', avatarObjectKey: 'listings/u/a.jpg' }),
    ).toEqual({ nickname: '小鱼', avatarObjectKey: 'listings/u/a.jpg' })
  })

  test('空对象被拒（没有语义的写入）', () => {
    const parsed = profileUpdateRequestSchema.safeParse({})
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('nickname 与 avatarObjectKey 至少要提供一项')
  })

  test('未知字段被拒，而不是静默丢弃（strictObject）', () => {
    expect(profileUpdateRequestSchema.safeParse({ nickname: '小鱼', campus: '肇庆' }).success).toBe(
      false,
    )
  })

  test('昵称沿用认证域口径：trim 后 1–20 字', () => {
    expect(profileUpdateRequestSchema.parse({ nickname: '  小鱼  ' }).nickname).toBe('小鱼')
    expect(profileUpdateRequestSchema.safeParse({ nickname: '   ' }).success).toBe(false)
    expect(profileUpdateRequestSchema.safeParse({ nickname: '鱼'.repeat(21) }).success).toBe(false)
  })

  test('头像 objectKey 不接受空白串或超长串', () => {
    expect(profileUpdateRequestSchema.safeParse({ avatarObjectKey: '   ' }).success).toBe(false)
    expect(profileUpdateRequestSchema.safeParse({ avatarObjectKey: 'a'.repeat(257) }).success).toBe(
      false,
    )
  })
})
