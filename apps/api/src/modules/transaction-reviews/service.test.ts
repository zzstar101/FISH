import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MediaStorage } from '../uploads/storage'
import { createTransactionReviewService, TransactionReviewServiceError } from './service'
import type { MyReviewRow, ReviewTimelineRow, TransactionReviewsStore } from './store'

const uuid = (n: number) => `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const TXN_ID = uuid(0xa1)
const TXN_PUBLIC_ID = encodePublicId(PUBLIC_ID_PREFIX.transaction, TXN_ID)
const BUYER_ID = uuid(0x01)
const SELLER_ID = uuid(0x02)

const storage: MediaStorage = {
  publicUrl: (key: string) => `https://cdn.example/${key}`,
  presignPut: () => ({
    url: 'https://upload.example/put',
    headers: {},
    expiresAt: '2026-10-01T12:10:00.000Z',
  }),
  stat: async () => null,
  readMediaBytes: async () => null,
  writeMediaBytes: async () => {},
}

function reviewRow(overrides: Partial<MyReviewRow> = {}): MyReviewRow {
  return {
    id: uuid(0xb1),
    rating: 'POSITIVE',
    body: '很愉快',
    createdAt: '2026-10-01T12:00:00.000Z',
    createdAtCursor: '2026-10-01T12:00:00.000000Z',
    imageKeys: [],
    ...overrides,
  }
}

function timelineRow(overrides: Partial<ReviewTimelineRow['transaction']> = {}): ReviewTimelineRow {
  return {
    ...reviewRow(),
    transaction: {
      id: TXN_ID,
      conversationId: uuid(0xc1),
      listingId: uuid(0xd1),
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      amountCents: 16000,
      status: 'COMPLETED',
      buyerConfirmedAt: '2026-10-01T11:00:00.000Z',
      sellerConfirmedAt: '2026-10-01T11:01:00.000Z',
      completedAt: '2026-10-01T11:02:00.000Z',
      cancelledAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T11:02:00.000Z',
      listingTitle: '九成新显示器',
      listingPriceCents: 16000,
      listingStatus: 'SOLD',
      coverObjectKey: null,
      counterpartId: SELLER_ID,
      counterpartNickname: '卖家',
      counterpartAvatarUrl: null,
      ...overrides,
    },
  }
}

/**
 * 状态化假 store：`existing` 是「我已经评过」的行；`insertResult` 模拟唯一索引的两种结局
 * （行 = 插入成功，null = 撞 `(transaction_id, author_id)` 唯一约束）。
 */
function fakeStore(
  overrides: {
    transactionStatus?: string
    participant?: boolean
    existing?: MyReviewRow | null
    insertResult?: MyReviewRow | null
    deleted?: number
    timeline?: ReviewTimelineRow[]
    total?: number
  } = {},
): TransactionReviewsStore {
  const participant = overrides.participant ?? true
  const status = overrides.transactionStatus ?? 'COMPLETED'
  return {
    transactionForParticipant: async () => (participant ? { id: TXN_ID, status } : null),
    findMyReview: async () => overrides.existing ?? null,
    insertReviewWithImages: async (input) =>
      overrides.insertResult === undefined
        ? reviewRow({ imageKeys: input.imageKeys })
        : overrides.insertResult,
    deleteOwnReview: async () => overrides.deleted ?? 1,
    listReviewsOf: async () => [],
    listByAuthor: async () => overrides.timeline ?? [],
    countByAuthor: async () => overrides.total ?? 0,
  }
}

function serviceErrorOf(promise: Promise<unknown>): Promise<TransactionReviewServiceError> {
  return promise.then(
    () => {
      throw new Error('预期抛 TransactionReviewServiceError，实际成功返回')
    },
    (error) => {
      if (!(error instanceof TransactionReviewServiceError)) throw error
      return error
    },
  )
}

describe('评价边（favorites 同款单资源三方法）', () => {
  test('非参与者与不存在同码 404（不泄漏交易存在性）', async () => {
    const service = createTransactionReviewService({
      store: fakeStore({ participant: false }),
      storage,
    })
    for (const action of [
      () => service.getMyReview(BUYER_ID, TXN_ID),
      () => service.createReview(BUYER_ID, TXN_ID, { rating: 'POSITIVE' }),
      () => service.deleteMyReview(BUYER_ID, TXN_ID),
      () => service.listReviewsOf(BUYER_ID, TXN_ID),
    ]) {
      const error = await serviceErrorOf(action())
      expect(error.status).toBe(404)
      expect(error.code).toBe('TRANSACTION_NOT_FOUND')
    }
  })

  test('只有 COMPLETED 可评（PENDING_MEETUP / CANCELLED 都 409）', async () => {
    const service = createTransactionReviewService({
      store: fakeStore({ transactionStatus: 'PENDING_MEETUP' }),
      storage,
    })
    const error = await serviceErrorOf(
      service.createReview(BUYER_ID, TXN_ID, { rating: 'NEGATIVE' }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('TRANSACTION_NOT_COMPLETED')
  })

  test('重复评价 409（并发撞唯一索引也归到这里，不静默 200）', async () => {
    const service = createTransactionReviewService({
      store: fakeStore({ insertResult: null }),
      storage,
    })
    const error = await serviceErrorOf(
      service.createReview(BUYER_ID, TXN_ID, { rating: 'POSITIVE' }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('TRANSACTION_REVIEW_EXISTS')
  })

  test('正文命中敏感词 422（BLOCK 与 REVIEW 都拒绝，与 comments 同一规则库）', async () => {
    const service = createTransactionReviewService({
      store: fakeStore(),
      storage,
      moderation: { moderate: () => ({ decision: 'BLOCK', matches: [] }) } as never,
    })
    const error = await serviceErrorOf(
      service.createReview(BUYER_ID, TXN_ID, { rating: 'POSITIVE', body: '加微信聊聊' }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('REVIEW_CONTENT_BLOCKED')
  })

  test('空串评语归一为 null 落库；正文过审才插行', async () => {
    let inserted: { body: string | null } | null = null
    const store = fakeStore()
    store.insertReviewWithImages = async (input) => {
      inserted = { body: input.body }
      return reviewRow()
    }
    const service = createTransactionReviewService({ store, storage })
    await service.createReview(BUYER_ID, TXN_ID, { rating: 'NEUTRAL', body: '   ' })
    expect((inserted as { body: string | null } | null)?.body).toBeNull()
  })

  test('GET 边：没评过 → 404 REVIEW_NOT_FOUND；评过 → DTO', async () => {
    const none = createTransactionReviewService({ store: fakeStore(), storage })
    const miss = await serviceErrorOf(none.getMyReview(BUYER_ID, TXN_ID))
    expect(miss.code).toBe('REVIEW_NOT_FOUND')

    const mine = createTransactionReviewService({
      store: fakeStore({ existing: reviewRow({ imageKeys: ['transaction-review-media/k.jpg'] }) }),
      storage,
    })
    const dto = await mine.getMyReview(BUYER_ID, TXN_ID)
    expect(dto.transactionId).toBe(TXN_PUBLIC_ID)
    expect(dto.images[0]?.url).toBe('https://cdn.example/transaction-review-media/k.jpg')
  })

  test('DELETE 幂等：store 的删除行数原样回传（0 = 本来就没有）', async () => {
    const service = createTransactionReviewService({
      store: fakeStore({ deleted: 0 }),
      storage,
    })
    expect(await service.deleteMyReview(BUYER_ID, TXN_ID)).toEqual({ deleted: 0 })
  })
})

describe('时间线（/me/comments?kind=review 借道的 listMine）', () => {
  test('多取一行判 hasMore，游标取自最后一条已返回的行（rvw_ 前缀 + source=review）', async () => {
    const store = fakeStore({
      timeline: [timelineRow({ id: uuid(0xb1) }), timelineRow({ id: uuid(0xb2) })],
      total: 5,
    })
    // limit=1：取回 2 行 → hasMore；页内只留 1 行。
    const page = await createTransactionReviewService({ store, storage }).listMine(BUYER_ID, {
      limit: 1,
      cursor: null,
    })
    expect(page.total).toBe(5)
    expect(page.items.length).toBe(1)
    expect(page.nextCursor).not.toBeNull()

    const decoded = JSON.parse(Buffer.from(page.nextCursor ?? '', 'base64url').toString('utf8'))
    expect(decoded.source).toBe('review')
    expect(decoded.id.startsWith('rvw_')).toBe(true)
  })

  test('时间线行的 transaction 是查看者视角 DTO 源（role=buyer、counterpart=卖家）', async () => {
    const store = fakeStore({ timeline: [timelineRow()], total: 1 })
    const page = await createTransactionReviewService({ store, storage }).listMine(BUYER_ID, {
      limit: 10,
      cursor: null,
    })
    const item = page.items[0]
    expect(item?.transaction.role).toBe('buyer')
    expect(item?.transaction.counterpart.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID))
    expect(item?.transaction.listing.id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.listing, timelineRow().transaction.listingId),
    )
  })
})

describe('#475 配图写入口', () => {
  const MEDIA = '01930000-0000-7000-8000-0000000000d1'
  const MEDIA2 = '01930000-0000-7000-8000-0000000000d2'
  const USER_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, BUYER_ID)
  const keyOf = (mediaId: string) =>
    `reviews/${USER_PUBLIC}/${encodePublicId(PUBLIC_ID_PREFIX.media, mediaId)}.png`

  /** 只有 keyOf(MEDIA) 是「已 confirm 的合法对象」；其余 stat 一律 null（不可引用）。 */
  const imageStorage: MediaStorage = {
    ...storage,
    statStrict: async (key) =>
      key === keyOf(MEDIA) ? { size: 1024, contentType: 'image/png' } : null,
  }

  test('合法 final 键按下标落 sort_order，DTO images 按序回 URL', async () => {
    const service = createTransactionReviewService({
      store: fakeStore(),
      storage: imageStorage,
    })
    const dto = await service.createReview(BUYER_ID, TXN_ID, {
      rating: 'POSITIVE',
      imageObjectKeys: [keyOf(MEDIA)],
    })
    expect(dto.images).toEqual([{ url: `https://cdn.example/${keyOf(MEDIA)}` }])
  })

  test('引用校验 stat 抛运行错误 → 503 REVIEW_MEDIA_UNAVAILABLE（#483 审查响应）', async () => {
    const outageStorage: MediaStorage = {
      ...imageStorage,
      statStrict: async () => {
        throw new Error('minio down')
      },
    }
    const service = createTransactionReviewService({
      store: fakeStore(),
      storage: outageStorage,
    })
    const error = await serviceErrorOf(
      service.createReview(BUYER_ID, TXN_ID, {
        rating: 'POSITIVE',
        imageObjectKeys: [keyOf(MEDIA)],
      }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('跨用户键 / 他人 listing 键 / chat-media 键 / 未确认键 → 422 REVIEW_IMAGE_INVALID（同码）', async () => {
    const service = createTransactionReviewService({
      store: fakeStore(),
      storage: imageStorage,
    })
    const otherPublic = encodePublicId(
      PUBLIC_ID_PREFIX.user,
      '01930000-0000-7000-8000-0000000000c1',
    )
    const bad = [
      `reviews/${otherPublic}/${encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA)}.png`,
      `listings/${USER_PUBLIC}/${encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA)}.jpg`,
      `chat-media/cnv_01jc000000e008000000000021/${USER_PUBLIC}/${encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA)}.webp`,
      keyOf(MEDIA2), // 形状合法但从未 confirm（stat null）
    ]
    for (const key of bad) {
      const error = await serviceErrorOf(
        service.createReview(BUYER_ID, TXN_ID, { rating: 'POSITIVE', imageObjectKeys: [key] }),
      )
      expect(error.status).toBe(422)
      expect(error.code).toBe('REVIEW_IMAGE_INVALID')
    }
  })

  test('重复键 → 422 VALIDATION_FAILED（details 指向 imageObjectKeys）', async () => {
    const service = createTransactionReviewService({ store: fakeStore(), storage: imageStorage })
    const error = await serviceErrorOf(
      service.createReview(BUYER_ID, TXN_ID, {
        rating: 'POSITIVE',
        imageObjectKeys: [keyOf(MEDIA), keyOf(MEDIA)],
      }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.details?.[0]?.field).toBe('imageObjectKeys')
  })

  test('超过上限（>3）→ 422 VALIDATION_FAILED', async () => {
    const service = createTransactionReviewService({ store: fakeStore(), storage: imageStorage })
    const error = await serviceErrorOf(
      service.createReview(BUYER_ID, TXN_ID, {
        rating: 'POSITIVE',
        imageObjectKeys: [keyOf(MEDIA), keyOf(MEDIA2), keyOf(MEDIA), keyOf(MEDIA2)],
      }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('VALIDATION_FAILED')
  })

  test('未带配图 → store 收到空数组（旧行为不变）', async () => {
    const received: { keys: string[] | null } = { keys: null }
    const store = fakeStore()
    store.insertReviewWithImages = async (input) => {
      received.keys = input.imageKeys
      return reviewRow()
    }
    const service = createTransactionReviewService({ store, storage: imageStorage })
    await service.createReview(BUYER_ID, TXN_ID, { rating: 'POSITIVE' })
    expect(received.keys).toEqual([])
  })
})
