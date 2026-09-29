import { describe, expect, test } from 'bun:test'
import type { ListingFeedQuery, ListingStatus } from '@fish/contracts/listings/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { ModerationDecision } from '../moderation/types'
import type { ConfirmedImageLookup } from '../uploads/media-objects'
import type { MediaStorage } from '../uploads/storage'
import type { ListingCardSeller } from './card'
import { encodeCursor } from './cursor'
import { createListingService, ListingServiceError } from './service'
import type {
  CreateListingRecord,
  FeedCriteria,
  ListingImageRow,
  ListingRow,
  ListingStore,
  ListingUpdateTarget,
  SellerRow,
  UpdateListingFields,
} from './store'

// —— 夹具：id 用合法的 UUIDv7（契约里 id 是 z.uuid()，随手编的会被拒）——
const SELLER_ID = '01930000-0000-7000-8000-00000000000a'
const OTHER_ID = '01930000-0000-7000-8000-00000000000b'
const LISTING_ID = '01930000-0000-7000-8000-000000000011'

const CREATED_AT = new Date('2026-09-12T03:40:10.000Z')

function listingRow(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: LISTING_ID,
    listingNo: 638_294_017_526n,
    sellerId: SELLER_ID,
    title: '罗技 K380 键盘',
    description: '宿舍用了一学期，功能正常。',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    moderationStatus: 'APPROVED',
    moderationReason: null,
    moderationRuleVersion: null,
    moderatedAt: null,
    governanceDelistedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

function sellerRow(overrides: Partial<SellerRow> = {}): SellerRow {
  return {
    id: SELLER_ID,
    studentNo: '202101000001',
    passwordHash: 'not-a-real-hash',
    nickname: '阿岚',
    avatarUrl: null,
    // #287：users 新增可空 signature 列，oldest fixture 也带默认值。
    signature: null,
    authStatus: 'VERIFIED',
    verifiedAt: CREATED_AT,
    campusEmail: null,
    phone: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    // #73：users.role 新增 NOT NULL DEFAULT 'USER'，oldest fixture 也带默认值。
    role: 'USER',
    ...overrides,
  }
}

const CREATED_AT_CURSOR = '2026-09-12T03:40:10.000000Z'

/** #191：feed 行 join users 带出的卖家公开投影源列（与 `store.listFeed` 的 select 同形状）。 */
const FEED_SELLER: ListingCardSeller = {
  id: SELLER_ID,
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'VERIFIED',
}

/** store 的 feed 行现在多带一个微秒精度的 `createdAtCursor`（游标用）与卖家公开投影源列（#191）。 */
function feedEntry(
  listing: ListingRow,
  coverObjectKey: string | null,
  seller: Partial<ListingCardSeller> = {},
) {
  return {
    listing,
    createdAtCursor: CREATED_AT_CURSOR,
    coverObjectKey,
    seller: { ...FEED_SELLER, ...seller },
  }
}

function imageRow(sortOrder: number, objectKey: string): ListingImageRow {
  return {
    id: `01930000-0000-7000-8000-0000000001${sortOrder.toString().padStart(2, '0')}`,
    listingId: LISTING_ID,
    objectKey,
    sortOrder,
    createdAt: CREATED_AT,
  }
}

/** `updateListingAtomic` 交给 `apply` 的"锁内当前行"。 */
function updateTarget(overrides: Partial<ListingUpdateTarget> = {}): ListingUpdateTarget {
  return {
    sellerId: SELLER_ID,
    status: 'ACTIVE',
    title: '罗技 K380 键盘',
    description: '宿舍用了一学期，功能正常。',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    urgent: false,
    negotiable: true,
    free: false,
    moderationStatus: 'APPROVED',
    governanceDelistedAt: null,
    objectKeys: [],
    ...overrides,
  }
}

function fakeStore(overrides: Partial<ListingStore> = {}): ListingStore {
  return {
    legacyUserIds: async () => [],
    createListingAtomic: async () => ({ kind: 'created', listingId: LISTING_ID }),
    enqueueMatchJob: async () => {},
    findDetail: async () => ({
      listing: listingRow(),
      seller: sellerRow(),
      images: [imageRow(0, `listings/${SELLER_ID}/cover.jpg`)],
    }),
    findState: async () => ({
      sellerId: SELLER_ID,
      status: 'ACTIVE',
      priceCents: 16000,
      free: false,
      governanceDelistedAt: null,
    }),
    listImageKeys: async () => [],
    listFeed: async () => [],
    updateListingAtomic: async (input) => {
      input.apply(input, updateTarget())
      return { kind: 'updated' }
    },
    setStatus: async () => true,
    deleteListingAtomic: async () => ({ kind: 'deleted' }),
    ...overrides,
  }
}

function fakeStorage(overrides: Partial<MediaStorage> = {}): MediaStorage {
  return {
    presignPut: () => ({
      url: 'https://s3.test/put?sig=x',
      headers: {},
      expiresAt: '2026-09-12T03:50:10.000Z',
    }),
    stat: async () => ({ size: 1024, contentType: 'image/jpeg' }),
    publicUrl: (key) => `https://cdn.test/${key}`,
    ...overrides,
  }
}

type InternalFeedQuery = Omit<ListingFeedQuery, 'sellerId'> & { sellerId?: string }
function feedQuery(overrides: Partial<InternalFeedQuery> = {}): InternalFeedQuery {
  return { sort: 'newest', limit: 20, ...overrides }
}

const validCreate = {
  title: '罗技 K380 键盘',
  description: '宿舍用了一学期，功能正常。',
  priceCents: 16000,
  category: 'DIGITAL' as const,
  condition: 'GOOD' as const,
  urgent: false,
  negotiable: false,
  free: false,
  objectKeys: [`listings/${SELLER_ID}/01930000-0000-7000-8000-0000000000f1.jpg`],
}

// —— #286：新形态对象键（`listings/{usr_…}/{med_…}.jpg`）与确认表 ——
const IMAGE_PREFIX = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID)}/`
const CONFIRMED_KEY = `${IMAGE_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c1')}.jpg`
const STAGING_KEY = `listing-media/${encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c2')}.jpg`
// 机器结论 REVIEW 的图固化在私有前缀（#286 复审 blocker 2），人工放行后才搬到 IMAGE_PREFIX。
const REVIEW_PREFIX = `listing-review-media/${encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID)}/`
const REVIEW_KEY = `${REVIEW_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c3')}.jpg`

/**
 * `listing_media_objects` 的只读夹具：只认列出来的 final 键，并记下被问过哪些键。
 * `settled` 模拟人工结算结论（#286 复审 blocker 1），有效结论 = `settled ?? decision`。
 */
function fakeImages(
  rows: {
    finalKey: string
    userId?: string
    decision: ModerationDecision
    settled?: ModerationDecision
  }[] = [],
): ConfirmedImageLookup & { asked: string[] } {
  const asked: string[] = []
  const lookup = (finalKey: string) => rows.find((entry) => entry.finalKey === finalKey) ?? null
  const effectiveOf = (row: { decision: ModerationDecision; settled?: ModerationDecision }) =>
    row.settled ?? row.decision
  return {
    asked,
    findConfirmedFinalKey: async (finalKey) => {
      asked.push(finalKey)
      const row = lookup(finalKey)
      // 与 SQL 实现一致：有效结论为 BLOCK 的行不返回（调用方据此拒绝引用）。
      if (!row || effectiveOf(row) === 'BLOCK') return null
      return { userId: row.userId ?? SELLER_ID, finalKey, moderationDecision: effectiveOf(row) }
    },
    findByFinalKey: async (finalKey) => {
      asked.push(finalKey)
      const row = lookup(finalKey)
      if (!row) return null
      return {
        userId: row.userId ?? SELLER_ID,
        finalKey,
        moderationDecision: row.decision,
        settledDecision: row.settled ?? null,
      }
    },
  }
}

/** 收集 create 落库的那条记录（`moderationStatus` / `moderation.decision` 是断言重点）。 */
function captureCreate(records: CreateListingRecord[]): Partial<ListingStore> {
  return {
    createListingAtomic: async (record) => {
      records.push(record)
      return { kind: 'created', listingId: LISTING_ID }
    },
  }
}

async function expectServiceError(run: () => Promise<unknown>): Promise<ListingServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ListingServiceError) return error
    throw error
  }
  throw new Error('期望抛出 ListingServiceError，但没有')
}

describe('listFeed', () => {
  test('defaults to ACTIVE and returns an opaque next cursor only when there is more', async () => {
    const seen: FeedCriteria[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async (criteria) => {
          seen.push(criteria)
          // limit + 1 行：store 约定多取一行用于判断"还有没有下一页"
          return [
            feedEntry(listingRow(), `listings/${SELLER_ID}/cover.jpg`),
            feedEntry(
              listingRow({
                id: '01930000-0000-7000-8000-000000000012',
                createdAt: new Date('2026-09-12T03:40:09.000Z'),
              }),
              null,
            ),
          ]
        },
      }),
    })

    const response = await service.listFeed(null, feedQuery({ limit: 1 }))

    expect(seen[0]?.status).toBe('ACTIVE')
    expect(seen[0]?.limit).toBe(1)
    expect(response.items).toHaveLength(1)
    expect(response.items[0]?.coverUrl).toBe(`https://cdn.test/listings/${SELLER_ID}/cover.jpg`)
    expect(response.nextCursor).not.toBeNull()
  })

  test('returns a null cursor and a null cover when the page ends', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async () => [feedEntry(listingRow(), null)],
      }),
    })

    const response = await service.listFeed(null, feedQuery())
    expect(response.nextCursor).toBeNull()
    expect(response.items[0]?.coverUrl).toBeNull()
  })

  // #191：卡片内嵌卖家公开子集——join 结果同源投影，匿名读与本人视角都带；
  // id 编码成 usr_ 公开前缀，nickname / authStatus 取真实列，头像脏值经 publicAvatarUrl 降级。
  test('embeds the public seller subset on every card, including anonymous reads', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async () => [
          feedEntry(listingRow({ sellerId: SELLER_ID }), null, {
            avatarUrl: 'https://cdn.test/avatars/legacy/a.jpg',
          }),
        ],
      }),
    })

    const response = await service.listFeed(null, feedQuery())
    expect(response.items[0]?.seller).toEqual({
      id: encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID),
      nickname: '阿岚',
      avatarUrl: 'https://cdn.test/avatars/legacy/a.jpg',
      authStatus: 'VERIFIED',
    })
  })

  // 决策 C：一条脏数据不该让整个首页 500。
  test('skips rows that cannot be mapped to the contract instead of failing the whole feed', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async () => [
          feedEntry(listingRow({ priceCents: 999_999_999 }), null),
          feedEntry(listingRow({ id: '01930000-0000-7000-8000-000000000012' }), null),
        ],
      }),
    })

    const response = await service.listFeed(null, feedQuery())
    expect(response.items).toHaveLength(1)
    expect(response.items[0]?.id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-000000000012'),
    )
  })

  test('rejects reading another seller listings by status', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const error = await expectServiceError(() =>
      service.listFeed(SELLER_ID, feedQuery({ sellerId: OTHER_ID, status: 'SOLD' })),
    )

    expect(error.status).toBe(403)
    expect(error.code).toBe('NOT_LISTING_OWNER')
  })

  test('passes an own sellerId and status filter through to the store', async () => {
    const seen: FeedCriteria[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async (criteria) => {
          seen.push(criteria)
          return []
        },
      }),
    })

    await service.listFeed(SELLER_ID, feedQuery({ sellerId: SELLER_ID, status: 'OFFLINE' }))
    expect(seen[0]?.status).toBe('OFFLINE')
    expect(seen[0]?.sellerId).toBe(SELLER_ID)
    // F4：本人查询自己的商品时，显式包含未通过审核的（REVIEW / BLOCKED），供前端展示"审核中"等状态。
    expect(seen[0]?.includeUnapproved).toBe(true)
  })

  // 回归（评审 F-A）：F4 的修复必须让**实际请求形状**返回 REVIEW 行，而不只是把 flag 传下去。
  // 前端「我发布的」是 `?sellerId=me`（不带 status）；旧实现把缺省 status 当成 ACTIVE，
  // 而 REVIEW 行是 OFFLINE，于是 flag 为 true 也照样被过滤掉（真库实测 0 条）。
  test('seller own query without status keeps the status filter open so REVIEW rows can surface', async () => {
    const seen: FeedCriteria[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async (criteria) => {
          seen.push(criteria)
          return []
        },
      }),
    })

    await service.listFeed(SELLER_ID, feedQuery({ sellerId: SELLER_ID }))

    expect(seen[0]?.includeUnapproved).toBe(true)
    // 关键：不能把缺省值钉成 ACTIVE，否则 OFFLINE 的 REVIEW 行永远拿不到。
    expect(seen[0]?.status).toBeUndefined()
  })

  // #74：本人列表里的 REVIEW 行与"自己下架"的行都是 `OFFLINE`，只有审核态能把它们分开。
  // 本人视角带真实值、公开视角恒 null（不向买家泄漏平台内部状态）。
  test('carries the moderation status on the seller own cards and keeps it null for everyone else', async () => {
    const reviewRow = listingRow({ status: 'OFFLINE', moderationStatus: 'REVIEW' })
    const store = fakeStore({ listFeed: async () => [feedEntry(reviewRow, null)] })
    const service = createListingService({ storage: fakeStorage(), store })

    const own = await service.listFeed(SELLER_ID, feedQuery({ sellerId: SELLER_ID }))
    expect(own.items[0]?.moderationStatus).toBe('REVIEW')

    const anonymous = await service.listFeed(null, feedQuery())
    expect(anonymous.items[0]?.moderationStatus).toBeNull()
  })

  /*
   * 治理下架在库里与「引擎/人工终审的 BLOCKED」同形（`OFFLINE` + `BLOCKED`），
   * 客户端只靠 `moderationStatus` 分不出「平台下架了你的商品」与「你的内容没过审」——
   * 两者的可做动作完全不同（前者等服务端，后者改内容重审）。所以本人视角要多带一个
   * `governanceDelisted`；公开 Feed / 查他人一律 null（那是平台内部状态，与审核态同一取向）。
   */
  test('carries the governance flag to the seller own cards only', async () => {
    const delistedRow = listingRow({
      status: 'OFFLINE',
      moderationStatus: 'BLOCKED',
      governanceDelistedAt: CREATED_AT,
    })
    const store = fakeStore({ listFeed: async () => [feedEntry(delistedRow, null)] })
    const service = createListingService({ storage: fakeStorage(), store })

    const own = await service.listFeed(SELLER_ID, feedQuery({ sellerId: SELLER_ID }))
    expect(own.items[0]?.governanceDelisted).toBe(true)

    // 同一条商品在公开 Feed 里连审核态都不给，治理标记同理
    const anonymous = await service.listFeed(null, feedQuery())
    expect(anonymous.items[0]?.governanceDelisted).toBeNull()
  })

  /*
   * 未通过原因（Owner 2026-09-28：「不过审要在编辑区上方用红字标注原因」）。
   * 三个口径都要锁：只给本人、只在真的被拒时给、`REVIEW` 不给。
   */
  test('carries the rejection reason to the seller own cards, and only when blocked', async () => {
    const blockedRow = listingRow({
      status: 'OFFLINE',
      moderationStatus: 'BLOCKED',
      moderationReason: 'PROHIBITED_CONTENT',
    })
    const store = fakeStore({ listFeed: async () => [feedEntry(blockedRow, null)] })
    const service = createListingService({ storage: fakeStorage(), store })

    const own = await service.listFeed(SELLER_ID, feedQuery({ sellerId: SELLER_ID }))
    expect(own.items[0]?.moderationReason).toBe('PROHIBITED_CONTENT')

    // 公开 Feed 连审核态都不给，原因同理
    const anonymous = await service.listFeed(null, feedQuery())
    expect(anonymous.items[0]?.moderationReason).toBeNull()
  })

  test('does not leak a reason for a listing that is only under review', async () => {
    // REVIEW 是"还没结论"：把机器规则码当原因摆出来会让卖家以为已经判了、去改一个没问题的字段
    const reviewRow = listingRow({
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
      moderationReason: 'CONTENT_REQUIRES_REVIEW',
    })
    const store = fakeStore({ listFeed: async () => [feedEntry(reviewRow, null)] })
    const service = createListingService({ storage: fakeStorage(), store })

    const own = await service.listFeed(SELLER_ID, feedQuery({ sellerId: SELLER_ID }))
    expect(own.items[0]?.moderationStatus).toBe('REVIEW')
    expect(own.items[0]?.moderationReason).toBeNull()
  })

  // 反向保证：公开 Feed（没有 sellerId）仍必须显式限定 ACTIVE，不能顺手把过滤打开。
  test('public feed still pins the status filter to ACTIVE', async () => {
    const seen: FeedCriteria[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async (criteria) => {
          seen.push(criteria)
          return []
        },
      }),
    })

    await service.listFeed(null, feedQuery())

    expect(seen[0]?.status).toBe('ACTIVE')
    expect(seen[0]?.includeUnapproved).toBe(false)
  })

  // 回归（评审 D3）：`status` 不带 `sellerId` 时，service 层也要拒绝。
  // 契约只在 schema refine 里写这条，router 之外绕进本函数就能拿到全站 OFFLINE/SOLD。
  test('rejects a status filter without sellerId even when bypassing the schema', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const error = await expectServiceError(() =>
      service.listFeed(null, feedQuery({ status: 'OFFLINE' })),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('VALIDATION_FAILED')
  })

  test('does not request unapproved listings for the public feed', async () => {
    const seen: FeedCriteria[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        listFeed: async (criteria) => {
          seen.push(criteria)
          return []
        },
      }),
    })

    await service.listFeed(null, feedQuery())
    // 公开 Feed 不需要未审核商品：includeUnapproved 为 false（store 视为未开启，照样加 APPROVED 过滤）。
    expect(seen[0]?.includeUnapproved).toBe(false)
  })

  test('rejects a cursor that does not match the requested sort', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    // 价格游标（数字）用在 newest 排序上
    const priceCursor = encodeCursor({ sortKey: 16000, id: LISTING_ID })

    const error = await expectServiceError(() =>
      service.listFeed(null, feedQuery({ cursor: priceCursor })),
    )
    expect(error.status).toBe(422)
    expect(error.details?.[0]?.field).toBe('cursor')
  })

  test('rejects a forged cursor', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const error = await expectServiceError(() =>
      service.listFeed(null, feedQuery({ cursor: 'not-a-cursor' })),
    )
    expect(error.status).toBe(422)
  })
})

describe('getDetail', () => {
  test('marks the owner and builds absolute image URLs', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findDetail: async () => ({
          listing: listingRow(),
          seller: sellerRow(),
          images: [
            imageRow(0, `listings/${SELLER_ID}/a.jpg`),
            imageRow(1, `listings/${SELLER_ID}/b.jpg`),
          ],
        }),
      }),
    })

    const detail = await service.getDetail(SELLER_ID, LISTING_ID)
    expect(detail.listingNo).toBe('638294017526')
    expect(detail.isOwner).toBe(true)
    expect(detail.images.map((image) => image.url)).toEqual([
      `https://cdn.test/listings/${SELLER_ID}/a.jpg`,
      `https://cdn.test/listings/${SELLER_ID}/b.jpg`,
    ])
    expect(detail.seller).toEqual({
      id: encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID),
      nickname: '阿岚',
      avatarUrl: null,
      authStatus: 'VERIFIED',
    })
  })

  test('returns 404 for a missing listing', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ findDetail: async () => null }),
    })
    expect((await expectServiceError(() => service.getDetail(null, LISTING_ID))).status).toBe(404)
  })

  // 契约 §2.2：OFFLINE 对非卖家 404 而不是 403（403 等于确认"这个 id 存在且是别人的"）。
  test('hides an offline listing from everyone but the owner', async () => {
    const offline = fakeStore({
      findDetail: async () => ({
        listing: listingRow({ status: 'OFFLINE' }),
        seller: sellerRow(),
        images: [],
      }),
    })
    const service = createListingService({ storage: fakeStorage(), store: offline })

    expect((await expectServiceError(() => service.getDetail(OTHER_ID, LISTING_ID))).status).toBe(
      404,
    )
    expect((await expectServiceError(() => service.getDetail(null, LISTING_ID))).status).toBe(404)

    const ownerView = await service.getDetail(SELLER_ID, LISTING_ID)
    expect(ownerView.status).toBe('OFFLINE')
  })

  // #74：REVIEW 的详情对本人可见（否则用户无从得知商品在审核中），审核态只给本人。
  test('shows the moderation status to the owner and null to everyone else', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findDetail: async () => ({
          listing: listingRow({ status: 'OFFLINE', moderationStatus: 'REVIEW' }),
          seller: sellerRow(),
          images: [],
        }),
      }),
    })

    expect((await service.getDetail(SELLER_ID, LISTING_ID)).moderationStatus).toBe('REVIEW')

    // 公开/他人视角看不到未过审商品（404），也就不会泄漏审核态。
    expect((await expectServiceError(() => service.getDetail(OTHER_ID, LISTING_ID))).status).toBe(
      404,
    )
    expect((await expectServiceError(() => service.getDetail(null, LISTING_ID))).status).toBe(404)
  })

  test('详情也带治理标记，且只在本人视角非 null', async () => {
    const delisted = listingRow({
      status: 'OFFLINE',
      moderationStatus: 'BLOCKED',
      governanceDelistedAt: CREATED_AT,
    })
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findDetail: async () => ({ listing: delisted, seller: sellerRow(), images: [] }),
      }),
    })

    // 本人：两个内部状态都给（治理标记优先于审核态由客户端判读，服务端只如实投影）
    const own = await service.getDetail(SELLER_ID, LISTING_ID)
    expect(own.governanceDelisted).toBe(true)
    expect(own.moderationStatus).toBe('BLOCKED')

    // 他人 / 匿名：这条商品是 OFFLINE + BLOCKED，本来就连详情都看不到（404）
    expect((await expectServiceError(() => service.getDetail(OTHER_ID, LISTING_ID))).status).toBe(
      404,
    )
    expect((await expectServiceError(() => service.getDetail(null, LISTING_ID))).status).toBe(404)
  })

  test('keeps the moderation status null for another viewer of an approved listing', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const detail = await service.getDetail(OTHER_ID, LISTING_ID)
    expect(detail.moderationStatus).toBeNull()
  })

  test('公开卖家信息包含 authStatus 但不包含 verifiedAt / campusEmail 等敏感字段（#68）', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const detail = await service.getDetail(null, LISTING_ID)
    expect(detail.seller.authStatus).toBe('VERIFIED')
    expect('verifiedAt' in detail.seller).toBe(false)
    expect('campusEmail' in detail.seller).toBe(false)
    expect('studentNo' in detail.seller).toBe(false)
  })

  /*
   * 卖家本人视角的 `objectKey` / 图片结论（Owner 2026-09-28：被拒商品要能带着原图回出物页改）。
   * 三条口径：非本人不给、BLOCK 的图不给（不可再引用）、台账缺失不给（结论未知）。
   */
  test('exposes the objectKey and image decision to the owner only', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([
        { finalKey: CONFIRMED_KEY, decision: 'ALLOW' },
        { finalKey: REVIEW_KEY, decision: 'REVIEW' },
      ]),
      store: fakeStore({
        findDetail: async () => ({
          listing: listingRow(),
          seller: sellerRow(),
          images: [imageRow(0, CONFIRMED_KEY), imageRow(1, REVIEW_KEY)],
        }),
      }),
    })

    const owner = await service.getDetail(SELLER_ID, LISTING_ID)
    expect(owner.images.map((image) => image.objectKey)).toEqual([CONFIRMED_KEY, REVIEW_KEY])
    expect(owner.images.map((image) => image.moderationStatus)).toEqual(['APPROVED', 'REVIEW'])

    // 非本人（匿名）：同一件商品只给 url —— 存储布局不进公开读协议
    const anon = await service.getDetail(null, LISTING_ID)
    expect(anon.images.map((image) => image.objectKey)).toEqual([undefined, undefined])
    expect(anon.images.map((image) => image.moderationStatus)).toEqual([undefined, undefined])
  })

  test('withholds the objectKey of an image that was settled to BLOCK', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      // 人工结算成 BLOCK 的图仍躺在商品图片组里，但不可再引用：带着它提交会被
      // `IMAGE_CONTENT_BLOCKED` 拒掉，所以不能让客户端以为可以原样保留
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'REVIEW', settled: 'BLOCK' }]),
      store: fakeStore({
        findDetail: async () => ({
          listing: listingRow({ status: 'OFFLINE', moderationStatus: 'BLOCKED' }),
          seller: sellerRow(),
          images: [imageRow(0, CONFIRMED_KEY), imageRow(1, `listings/${SELLER_ID}/old.jpg`)],
        }),
      }),
    })

    const owner = await service.getDetail(SELLER_ID, LISTING_ID)
    expect(owner.images[0]?.objectKey).toBeUndefined()
    expect(owner.images[0]?.moderationStatus).toBeUndefined()
    // 存量键（没有台账行）结论未知，**但可以原样保留**：写路径对 storedKeys 里的老键豁免
    // 「审没审过」那一层，所以键照给、只是不给结论
    expect(owner.images[1]?.objectKey).toBe(`listings/${SELLER_ID}/old.jpg`)
    expect(owner.images[1]?.moderationStatus).toBeUndefined()
  })

  // #47：封面只认 0 号图，不能退化成「最小 sort_order」。store 按 `ORDER BY sort_order ASC`
  // 返回（store.ts:231），所以只有 1 号图时 `images[0]` 会是一张非封面图，而 feed / profile /
  // matching / conversations / transactions 五处同口径都返回 null —— 同一份数据两个结论。
  // 触发形状（有图但没有 sort_order = 0）DB 拦不住：只约束 `sort_order >= 0` 与
  // `(listing_id, sort_order)` 唯一，migration / 脚本 / 直连写入即可造成。
  test('covers only the sort_order = 0 image, and keeps every image in the gallery', async () => {
    const withoutCoverImage = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findDetail: async () => ({
          listing: listingRow(),
          seller: sellerRow(),
          images: [
            imageRow(1, `listings/${SELLER_ID}/b.jpg`),
            imageRow(2, `listings/${SELLER_ID}/c.jpg`),
          ],
        }),
      }),
    })

    const detail = await withoutCoverImage.getDetail(null, LISTING_ID)
    expect(detail.coverUrl).toBeNull()
    // 画廊不受封面口径影响：详情页读的是 images[]（detail-page.tsx 按 sortOrder 渲染）。
    expect(detail.images.map((image) => image.url)).toEqual([
      `https://cdn.test/listings/${SELLER_ID}/b.jpg`,
      `https://cdn.test/listings/${SELLER_ID}/c.jpg`,
    ])

    // 对照组：0 号图存在时封面就是它 —— 否则「一律返回 null」也能让上面那条通过。
    const withCoverImage = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findDetail: async () => ({
          listing: listingRow(),
          seller: sellerRow(),
          images: [
            imageRow(0, `listings/${SELLER_ID}/cover.jpg`),
            imageRow(1, `listings/${SELLER_ID}/b.jpg`),
          ],
        }),
      }),
    })

    const withCover = await withCoverImage.getDetail(null, LISTING_ID)
    expect(withCover.coverUrl).toBe(`https://cdn.test/listings/${SELLER_ID}/cover.jpg`)
  })
})

describe('createListing', () => {
  test('rejects object keys that belong to someone else', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, {
        ...validCreate,
        objectKeys: [`listings/${OTHER_ID}/a.jpg`],
      }),
    )

    expect(error.status).toBe(422)
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
  })

  test('旧用户重键后可保留本人的历史图片键，非本人旧键仍拒绝', async () => {
    const oldId = '11111111-1111-4111-8111-111111111111'
    const ownKey = `listings/${oldId}/01930000-0000-4000-8000-0000000000f2.webp`
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        legacyUserIds: async (current) => (current === SELLER_ID ? [oldId] : []),
      }),
    })
    const updated = await service.updateListing(SELLER_ID, LISTING_ID, { objectKeys: [ownKey] })
    expect(updated.images).toHaveLength(1)
    const invalid = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, {
        objectKeys: [`listings/${OTHER_ID}/old.webp`],
      }),
    )
    expect(invalid.code).toBe('IMAGE_REFERENCE_INVALID')
  })

  test('rejects object keys that were never uploaded', async () => {
    const service = createListingService({
      storage: fakeStorage({ stat: async () => null }),
      store: fakeStore(),
    })
    const error = await expectServiceError(() => service.createListing(SELLER_ID, validCreate))
    expect(error.code).toBe('UPLOAD_OBJECT_MISSING')
  })

  // presign 的签名只管 host，mime/大小必须在服务端对真实对象校验（契约 §7.7）。
  test('rejects objects whose real size or mime type is not allowed', async () => {
    const oversize = createListingService({
      storage: fakeStorage({
        stat: async () => ({ size: 6 * 1024 * 1024, contentType: 'image/jpeg' }),
      }),
      store: fakeStore(),
    })
    expect(
      (await expectServiceError(() => oversize.createListing(SELLER_ID, validCreate))).code,
    ).toBe('IMAGE_REFERENCE_INVALID')

    const wrongType = createListingService({
      storage: fakeStorage({ stat: async () => ({ size: 1024, contentType: 'text/plain' }) }),
      store: fakeStore(),
    })
    expect(
      (await expectServiceError(() => wrongType.createListing(SELLER_ID, validCreate))).code,
    ).toBe('IMAGE_REFERENCE_INVALID')
  })

  test('blocks prohibited content before upload validation and records the decision', async () => {
    const records: string[] = []
    const service = createListingService({
      storage: fakeStorage({
        stat: async () => {
          throw new Error('should not inspect uploads')
        },
      }),
      store: fakeStore({
        recordModeration: async (input) => {
          records.push(`${input.action}:${input.decision}`)
        },
      }),
    })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, title: '毒品交易' }),
    )

    expect(error.code).toBe('LISTING_CONTENT_BLOCKED')
    expect(records).toEqual(['CREATE:BLOCK'])
  })

  // #74：BLOCK 要给可定位到输入框的字段级错误，但**不下发命中词或词库**。
  // 这里同时命中 BLOCK（毒品）与 REVIEW（加微信）规则，只有前者能出现在 details 里。
  test('reports the blocked field without leaking the matched terms', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, {
        ...validCreate,
        description: '出售毒品，加微信联系',
      }),
    )

    expect(error.details).toEqual([{ field: 'description', message: '描述包含平台禁止发布的内容' }])
    const serialized = JSON.stringify(error.details)
    expect(serialized).not.toContain('毒品')
    expect(serialized).not.toContain('加微信')
  })

  test('reports both fields when the title and the description are blocked', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, title: '毒品', description: '枪支' }),
    )

    expect(error.details?.map((detail) => detail.field).sort()).toEqual(['description', 'title'])
  })

  test('creates review listings offline and does not expose them in the public feed', async () => {
    let received: CreateListingRecord | undefined
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        createListingAtomic: async (record) => {
          received = record
          return { kind: 'created', listingId: LISTING_ID }
        },
      }),
    })

    const result = await service.createListing(SELLER_ID, {
      ...validCreate,
      description: '加微信联系',
    })

    expect(received?.moderationStatus).toBe('REVIEW')
    expect(result.detail.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID))
  })

  test('reports created=true and returns the detail', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const result = await service.createListing(SELLER_ID, validCreate)

    expect(result.created).toBe(true)
    expect(result.detail.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID))
  })

  test('returns the existing listing and re-enqueues the match job on a duplicate submit', async () => {
    const enqueued: string[] = []
    const received: { record?: CreateListingRecord } = {}
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        createListingAtomic: async (record) => {
          received.record = record
          return { kind: 'duplicate', listingId: LISTING_ID }
        },
        enqueueMatchJob: async (listingId) => {
          enqueued.push(listingId)
        },
      }),
      now: () => new Date('2026-09-12T03:40:10.000Z'),
    })

    const result = await service.createListing(SELLER_ID, validCreate)

    expect(result.created).toBe(false)
    // 去重窗口 = now - 5s（与 #7 已合并的实现同一个窗口）
    expect(received.record?.duplicateWindowStart.toISOString()).toBe('2026-09-12T03:40:05.000Z')
    expect(enqueued).toEqual([LISTING_ID])
  })
})

describe('updateListing', () => {
  test('rejects edits from anyone but the owner', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ updateListingAtomic: async () => ({ kind: 'not-owner' }) }),
    })
    const error = await expectServiceError(() =>
      service.updateListing(OTHER_ID, LISTING_ID, { title: '新标题' }),
    )
    expect(error.status).toBe(403)
  })

  test('rejects edits while RESERVED or SOLD (transaction-owned states)', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      // 锁内读到 RESERVED / SOLD → store 直接回 `locked`，service 不再做二次读。
      store: fakeStore({ updateListingAtomic: async () => ({ kind: 'locked' }) }),
    })
    for (const _status of ['RESERVED', 'SOLD'] as ListingStatus[]) {
      expect(
        (
          await expectServiceError(() =>
            service.updateListing(SELLER_ID, LISTING_ID, { title: '新' }),
          )
        ).status,
      ).toBe(409)
    }
  })

  // 契约 §7.1：判定标准是"合并后的最终状态"，所以"只改价格"也要看库里当前的 free。
  test('enforces free ⟹ price 0 against the merged final state', async () => {
    const freeListing = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        // 合并校验在 `apply` 里抛：store 的回调在真实实现中也会把它带出事务。
        updateListingAtomic: async (input) => {
          input.apply(input, updateTarget({ priceCents: 0, free: true }))
          return { kind: 'updated' }
        },
      }),
    })
    const error = await expectServiceError(() =>
      freeListing.updateListing(SELLER_ID, LISTING_ID, { priceCents: 5000 }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.details?.[0]?.field).toBe('priceCents')
  })

  test('passes only real columns to the store and replaces images when keys are given', async () => {
    const received: { fields?: UpdateListingFields; objectKeys?: string[] } = {}
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget())
          if (plan.kind === 'write') received.fields = plan.fields
          if (input.objectKeys) received.objectKeys = input.objectKeys
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, {
      title: '新标题',
      objectKeys: [`listings/${SELLER_ID}/01930000-0000-7000-8000-0000000000f3.jpg`],
    })

    expect(received.fields).toMatchObject({ title: '新标题', moderationStatus: 'APPROVED' })
    // `objectKeys` 不是 `listings` 的列，绝不能出现在 `fields` 里。
    expect(received.fields).not.toHaveProperty('objectKeys')
    expect(received.objectKeys).toEqual([
      `listings/${SELLER_ID}/01930000-0000-7000-8000-0000000000f3.jpg`,
    ])
  })

  // 并发：锁内读到的行已经是 RESERVED / SOLD（#11 的交易流程）——这必须是 409 而不是 404。
  // 重点在于判定用的就是**锁内那一行**：旧实现是第一次读过之后、UPDATE 没命中再复读，
  // 两次读之间可以变。
  test('reports 409 when the row read inside the lock is RESERVED / SOLD', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ updateListingAtomic: async () => ({ kind: 'locked' }) }),
    })

    const error = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, { title: '新标题' }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('LISTING_NOT_EDITABLE')
  })

  // 并发极端情况：两个 PATCH 各自通过"合并后状态"校验，落库时撞上 DB 的
  // listings_free_price_cents_zero。契约把这种最终状态定为 422，而不是 500。
  test('maps a DB check violation to 422 instead of 500', async () => {
    // 形状照抄实测到的 Bun PostgresError：SQLSTATE 在 errno 上，约束名在 constraint 上，
    // 并被 Drizzle 包进 cause。映射按约束名精确匹配（见 isFreePriceConstraintViolation）。
    const pgError = Object.assign(new Error('Failed query: update "listings"'), {
      errno: '23514',
      code: 'ERR_POSTGRES_SERVER_ERROR',
      constraint: 'listings_free_price_cents_zero',
    })
    const wrapped = new Error('DrizzleQueryError', { cause: pgError })

    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListingAtomic: async () => {
          throw wrapped
        },
      }),
    })

    const error = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, { priceCents: 5000 }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.details?.[0]?.field).toBe('priceCents')
  })

  // 反向保证：只有那条约束才映射成 422，别的错误必须照旧上抛（否则等于把所有写入故障
  // 都伪装成"价格填错了"，比 500 更难查）。
  test('rethrows unrelated database errors instead of pretending they are validation failures', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListingAtomic: async () => {
          throw Object.assign(new Error('boom'), {
            errno: '23514',
            constraint: 'listings_some_other_check',
          })
        },
      }),
    })

    await expect(
      service.updateListing(SELLER_ID, LISTING_ID, { priceCents: 5000 }),
    ).rejects.toThrow('boom')
  })

  test('returns 404 when the listing disappears before the transaction reads it', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ updateListingAtomic: async () => ({ kind: 'not-found' }) }),
    })
    expect(
      (
        await expectServiceError(() =>
          service.updateListing(SELLER_ID, LISTING_ID, { title: '新标题' }),
        )
      ).status,
    ).toBe(404)
  })

  // 回归（评审 blocker 1 的 service 一半）：审核必须跑在**锁内读到的那一行**上。
  // store 把当前行交给 `apply`，service 必须用它的 title/description 去合并 —— 而不是任何
  // 事务外的预读。这里让锁内的行已经是"待审内容 + REVIEW"，断言只改价格的 PATCH 也会
  // 重新产出 REVIEW（而不是写回 APPROVED）。真正的行锁行为由 store.test.ts 的真库并发用例覆盖。
  test('re-moderates against the row handed over by the locked transaction', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListingAtomic: async (input) => {
          const plan = await input.apply(
            input,
            updateTarget({ title: '加微信联系', moderationStatus: 'REVIEW', status: 'OFFLINE' }),
          )
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { priceCents: 17000 })

    // 即使本请求只改价格，也不能把已有审核结论冲成 APPROVED。
    expect(plans[0]).toMatchObject({ moderationStatus: 'REVIEW', status: 'OFFLINE' })
  })

  // #74：编辑路径的 BLOCK 原因由锁内 `apply` 算出，`rejected` 结果本身不携带它，
  // service 必须在回调里接住——断言它确实带到了 422 响应（且不含命中词）。
  test('reports the blocked field computed inside the locked transaction', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListingAtomic: async (input) => {
          await input.apply(input, updateTarget())
          return { kind: 'rejected' }
        },
      }),
    })

    const error = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, { description: '出售毒品' }),
    )

    expect(error.code).toBe('LISTING_CONTENT_BLOCKED')
    expect(error.details).toEqual([{ field: 'description', message: '描述包含平台禁止发布的内容' }])
  })
})

// —— #286：新形态对象键必须先在上传确认表里落地，才允许被 Listing 引用 ——
describe('image confirmation', () => {
  test('rejects a staging key because the image has not been confirmed yet', async () => {
    let statCalled = false
    const service = createListingService({
      storage: fakeStorage({
        stat: async () => {
          statCalled = true
          return { size: 1024, contentType: 'image/jpeg' }
        },
      }),
      store: fakeStore(),
    })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, objectKeys: [STAGING_KEY] }),
    )

    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(error.details).toEqual([
      { field: 'objectKeys', message: '图片尚未通过审核，请使用上传确认后返回的图片标识' },
    ])
    expect(statCalled).toBe(false)
  })

  test('rejects a final key when no confirmation lookup is wired (fail closed)', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, objectKeys: [CONFIRMED_KEY] }),
    )

    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(error.details).toEqual([{ field: 'objectKeys', message: '图片尚未通过审核' }])
  })

  test('asks the confirmation table about a final key before rejecting it', async () => {
    const images = fakeImages()
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: images,
      store: fakeStore(),
    })

    await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, objectKeys: [CONFIRMED_KEY] }),
    )

    expect(images.asked).toEqual([CONFIRMED_KEY])
  })

  test('accepts a confirmed ALLOW image and keeps the listing APPROVED', async () => {
    const records: CreateListingRecord[] = []
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'ALLOW' }]),
      store: fakeStore(captureCreate(records)),
    })

    await service.createListing(SELLER_ID, { ...validCreate, objectKeys: [CONFIRMED_KEY] })

    expect(records[0]?.objectKeys).toEqual([CONFIRMED_KEY])
    expect(records[0]?.moderationStatus).toBe('APPROVED')
    expect(records[0]?.moderation?.decision).toBe('ALLOW')
  })

  test('sends the listing to the manual queue when a confirmed image is REVIEW', async () => {
    const records: CreateListingRecord[] = []
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'REVIEW' }]),
      store: fakeStore(captureCreate(records)),
    })

    await service.createListing(SELLER_ID, { ...validCreate, objectKeys: [CONFIRMED_KEY] })

    expect(records[0]?.moderationStatus).toBe('REVIEW')
    expect(records[0]?.moderation?.decision).toBe('REVIEW')
  })

  // #286 复审 blocker 2：REVIEW 图的固化键是私有的 `listing-review-media/`，它对卖家是**正常**的
  // 可引用键 —— 商品得带着审核中的图进人工队列，管理员才能看到这张图并做结论。
  test('accepts a confirmed image stored under the private review prefix', async () => {
    const records: CreateListingRecord[] = []
    const images = fakeImages([{ finalKey: REVIEW_KEY, decision: 'REVIEW' }])
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: images,
      store: fakeStore(captureCreate(records)),
    })

    await service.createListing(SELLER_ID, { ...validCreate, objectKeys: [REVIEW_KEY] })

    expect(images.asked).toEqual([REVIEW_KEY])
    expect(records[0]?.objectKeys).toEqual([REVIEW_KEY])
    expect(records[0]?.moderationStatus).toBe('REVIEW')
  })

  test('rejects a review key that belongs to another user', async () => {
    const otherReviewKey = `listing-review-media/${encodePublicId(PUBLIC_ID_PREFIX.user, OTHER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c4')}.jpg`
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([
        { finalKey: otherReviewKey, userId: OTHER_ID, decision: 'REVIEW' },
      ]),
      store: fakeStore(),
    })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, objectKeys: [otherReviewKey] }),
    )

    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(error.details).toEqual([{ field: 'objectKeys', message: '图片不属于当前用户' }])
  })

  test('rejects a confirmed image that belongs to another user', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, userId: OTHER_ID, decision: 'ALLOW' }]),
      store: fakeStore(),
    })

    const error = await expectServiceError(() =>
      service.createListing(SELLER_ID, { ...validCreate, objectKeys: [CONFIRMED_KEY] }),
    )

    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(error.details).toEqual([{ field: 'objectKeys', message: '图片尚未通过审核' }])
  })

  test('keeps legacy keys working without consulting the confirmation table', async () => {
    const records: CreateListingRecord[] = []
    const images = fakeImages()
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: images,
      store: fakeStore(captureCreate(records)),
    })

    await service.createListing(SELLER_ID, validCreate)

    expect(images.asked).toEqual([])
    expect(records[0]?.objectKeys).toEqual(validCreate.objectKeys)
    expect(records[0]?.moderationStatus).toBe('APPROVED')
  })

  test('sends an update with a REVIEW image back to the manual queue', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'REVIEW' }]),
      store: fakeStore({
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget())
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { objectKeys: [CONFIRMED_KEY] })

    expect(plans[0]).toMatchObject({ moderationStatus: 'REVIEW', status: 'OFFLINE' })
  })

  // #286 回归：`objectKeys` 缺省 = 图片整组不变，图片结论必须按**库里现有的图片**重算。
  // 之前这里直接取 `[]`，于是一次纯文本编辑就把图片 REVIEW 洗成 APPROVED，商品从人工队列消失。
  test('keeps a REVIEW image in the manual queue when the edit omits objectKeys', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const images = fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'REVIEW' }])
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: images,
      store: fakeStore({
        listImageKeys: async () => [CONFIRMED_KEY],
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget({ objectKeys: [CONFIRMED_KEY] }))
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { title: '换了标题的键盘' })

    expect(images.asked).toEqual([CONFIRMED_KEY])
    expect(plans[0]).toMatchObject({ moderationStatus: 'REVIEW', status: 'OFFLINE' })
  })

  // #286 复审 blocker 1：人工放行后媒体行的有效结论是结算列 `ALLOW`。卖家下一次"不改图"的文本
  // 编辑必须读到 ALLOW —— 否则刚放行的商品会被压回人工队列（就是 Owner 复现的那条路径）。
  test('keeps a settled image out of the manual queue when the edit omits objectKeys', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const images = fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'REVIEW', settled: 'ALLOW' }])
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: images,
      store: fakeStore({
        listImageKeys: async () => [CONFIRMED_KEY],
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget({ objectKeys: [CONFIRMED_KEY] }))
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { title: '换了标题的键盘' })

    expect(images.asked).toEqual([CONFIRMED_KEY])
    expect(plans[0]).toMatchObject({ moderationStatus: 'APPROVED' })
  })

  // 反向：人工下架（结算 BLOCK）过的图片不能被一次纯文本编辑洗回可发布状态。
  test('blocks an edit when a stored image was settled to BLOCK', async () => {
    const planKinds: string[] = []
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'REVIEW', settled: 'BLOCK' }]),
      store: fakeStore({
        listImageKeys: async () => [CONFIRMED_KEY],
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget({ objectKeys: [CONFIRMED_KEY] }))
          planKinds.push(plan.kind)
          return { kind: 'rejected', moderation: { decision: 'BLOCK' } } as never
        },
      }),
    })

    const error = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, { title: '换了标题的键盘' }),
    )

    expect(planKinds).toEqual(['blocked'])
    expect(error.code).toBe('LISTING_CONTENT_BLOCKED')
  })

  // 存量图：新形态键但确认表里没有记录（#286 之前上传、或迁移前就存在的图）。编辑保存不能因此被拒。
  test('accepts a resent key that predates the confirmation table', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages(),
      store: fakeStore({
        listImageKeys: async () => [CONFIRMED_KEY],
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget({ objectKeys: [CONFIRMED_KEY] }))
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { objectKeys: [CONFIRMED_KEY] })

    expect(plans[0]).toMatchObject({ moderationStatus: 'APPROVED' })
  })

  test('does not treat a legacy stored key as an image to re-moderate', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const legacyKey = `listings/${SELLER_ID}/01930000-0000-7000-8000-0000000000f1.jpg`
    const images = fakeImages()
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: images,
      store: fakeStore({
        listImageKeys: async () => [legacyKey],
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget({ objectKeys: [legacyKey] }))
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { priceCents: 15000 })

    expect(images.asked).toEqual([])
    expect(plans[0]).toMatchObject({ moderationStatus: 'APPROVED' })
  })

  // 事务外读到的图片组必须与锁内读到的一致，否则旧结论不能用来写状态。
  test('fails closed when the stored images changed under the transaction', async () => {
    const plans: (UpdateListingFields | undefined)[] = []
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages([{ finalKey: CONFIRMED_KEY, decision: 'ALLOW' }]),
      store: fakeStore({
        listImageKeys: async () => [CONFIRMED_KEY],
        updateListingAtomic: async (input) => {
          const plan = await input.apply(input, updateTarget({ objectKeys: [] }))
          if (plan.kind === 'write') plans.push(plan.fields)
          return { kind: 'updated' }
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, { title: '换了标题的键盘' })

    expect(plans[0]).toMatchObject({ moderationStatus: 'REVIEW', status: 'OFFLINE' })
  })

  // 豁免只给"本来就在库里的键"：新引用的键仍然必须走完 confirm。
  test('still rejects an unconfirmed key that is not part of the stored images', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      mediaObjects: fakeImages(),
      store: fakeStore({ listImageKeys: async () => [] }),
    })

    const error = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, { objectKeys: [CONFIRMED_KEY] }),
    )

    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(error.details).toEqual([{ field: 'objectKeys', message: '图片尚未通过审核' }])
  })

  test('rejects a staging key on update without touching the transaction', async () => {
    let touched = false
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListingAtomic: async () => {
          touched = true
          return { kind: 'updated' }
        },
      }),
    })

    const error = await expectServiceError(() =>
      service.updateListing(SELLER_ID, LISTING_ID, { objectKeys: [STAGING_KEY] }),
    )

    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(touched).toBe(false)
  })
})

describe('transition', () => {
  test('offline an ACTIVE listing', async () => {
    const calls: { from: string; to: string }[] = []
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        setStatus: async (input) => {
          calls.push({ from: input.from, to: input.to })
          return true
        },
      }),
    })

    await service.transition(SELLER_ID, LISTING_ID, 'OFFLINE')
    expect(calls).toEqual([{ from: 'ACTIVE', to: 'OFFLINE' }])
  })

  test('is idempotent when the listing is already in the target status', async () => {
    let wrote = false
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findState: async () => ({
          sellerId: SELLER_ID,
          status: 'OFFLINE',
          priceCents: 16000,
          free: false,
          governanceDelistedAt: null,
        }),
        findDetail: async () => ({
          listing: listingRow({ status: 'OFFLINE' }),
          seller: sellerRow(),
          images: [],
        }),
        setStatus: async () => {
          wrote = true
          return true
        },
      }),
    })

    const detail = await service.transition(SELLER_ID, LISTING_ID, 'OFFLINE')
    expect(detail.status).toBe('OFFLINE')
    expect(wrote).toBe(false)
  })

  test('rejects transitions for RESERVED / SOLD listings', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        findState: async () => ({
          sellerId: SELLER_ID,
          status: 'RESERVED',
          priceCents: 16000,
          free: false,
          governanceDelistedAt: null,
        }),
      }),
    })
    const error = await expectServiceError(() =>
      service.transition(SELLER_ID, LISTING_ID, 'OFFLINE'),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('LISTING_NOT_EDITABLE')
  })

  // 并发：别人先把状态改成了 RESERVED，本次 setStatus 没改到任何行 → 必须 409 而不是报成功。
  test('reports 409 when a concurrent change took the listing somewhere else', async () => {
    // 与 updateListing 的同名用例同一个道理：fake 必须"有状态"。
    // 第 1 次 findState 是前置检查（ACTIVE，请求得以继续），第 2 次是 setStatus 没改到行后的
    // 复读（已被并发改成 RESERVED）。两次都返回 RESERVED 的话，异常在前置检查就抛出，
    // setStatus 与 !changed 判别都不可达 —— 回退那段代码用例也照样绿。
    let reads = 0
    let setStatusCalls = 0
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        setStatus: async () => {
          setStatusCalls += 1
          return false
        },
        findState: async () => {
          reads += 1
          return {
            sellerId: SELLER_ID,
            status: reads === 1 ? 'ACTIVE' : 'RESERVED',
            priceCents: 16000,
            free: false,
            governanceDelistedAt: null,
          }
        },
      }),
    })

    const error = await expectServiceError(() =>
      service.transition(SELLER_ID, LISTING_ID, 'OFFLINE'),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('LISTING_NOT_EDITABLE')
    // 这两条保证用例确实走到了目标分支，而不是在前置检查就结束
    expect(setStatusCalls).toBe(1)
    expect(reads).toBe(2)
  })

  test('treats a concurrent change to the target status as success', async () => {
    // 第 1 次 ACTIVE（前置检查通过，不会命中"已是目标态"的早返回），
    // 第 2 次 OFFLINE（= 目标态）→ 并发下别人已改到目标态，应视为幂等成功。
    let reads = 0
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        setStatus: async () => false,
        findState: async () => {
          reads += 1
          return {
            sellerId: SELLER_ID,
            status: reads === 1 ? 'ACTIVE' : 'OFFLINE',
            priceCents: 16000,
            free: false,
            governanceDelistedAt: null,
          }
        },
        findDetail: async () => ({
          listing: listingRow({ status: 'OFFLINE' }),
          seller: sellerRow(),
          images: [],
        }),
      }),
    })

    const detail = await service.transition(SELLER_ID, LISTING_ID, 'OFFLINE')
    expect(detail.status).toBe('OFFLINE')
    expect(reads).toBe(2)
  })

  test('rejects transitions from a stranger without revealing the listing', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    expect(
      (await expectServiceError(() => service.transition(OTHER_ID, LISTING_ID, 'OFFLINE'))).status,
    ).toBe(403)
  })
})

describe('deleteListing', () => {
  test('物理删除成功时不带返回体，并把解码后的 id / 卖家原样传给 store', async () => {
    const received: { id?: string; sellerId?: string } = {}
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        deleteListingAtomic: async (input) => {
          received.id = input.id
          received.sellerId = input.sellerId
          return { kind: 'deleted' }
        },
      }),
    })
    await service.deleteListing(SELLER_ID, LISTING_ID)
    expect(received).toEqual({ id: LISTING_ID, sellerId: SELLER_ID })
  })

  test('商品不存在 → 404 LISTING_NOT_FOUND', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ deleteListingAtomic: async () => ({ kind: 'not-found' }) }),
    })
    const error = await expectServiceError(() => service.deleteListing(SELLER_ID, LISTING_ID))
    expect(error.status).toBe(404)
    expect(error.code).toBe('LISTING_NOT_FOUND')
  })

  test('别人的商品 → 403 NOT_LISTING_OWNER（与编辑同一口径）', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ deleteListingAtomic: async () => ({ kind: 'not-owner' }) }),
    })
    const error = await expectServiceError(() => service.deleteListing(OTHER_ID, LISTING_ID))
    expect(error.status).toBe(403)
    expect(error.code).toBe('NOT_LISTING_OWNER')
  })

  test('状态不许可（审核中 / 已下架 / 有交易记录）→ 409 LISTING_NOT_DELETABLE', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({ deleteListingAtomic: async () => ({ kind: 'not-deletable' }) }),
    })
    const error = await expectServiceError(() => service.deleteListing(SELLER_ID, LISTING_ID))
    expect(error.status).toBe(409)
    expect(error.code).toBe('LISTING_NOT_DELETABLE')
  })
})
