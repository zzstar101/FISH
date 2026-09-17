import { describe, expect, test } from 'bun:test'
import type { ListingFeedQuery, ListingStatus } from '@fish/contracts/listings/schema'
import type { MediaStorage } from '../uploads/storage'
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
    campus: '肇庆',
    authStatus: 'VERIFIED',
    verifiedAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

const CREATED_AT_CURSOR = '2026-09-12T03:40:10.000000Z'

/** store 的 feed 行现在多带一个微秒精度的 `createdAtCursor`（游标用）。 */
function feedEntry(listing: ListingRow, coverObjectKey: string | null) {
  return { listing, createdAtCursor: CREATED_AT_CURSOR, coverObjectKey }
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
    ...overrides,
  }
}

function fakeStore(overrides: Partial<ListingStore> = {}): ListingStore {
  return {
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
    }),
    listFeed: async () => [],
    updateListingAtomic: async (input) => {
      input.apply(input, updateTarget())
      return { kind: 'updated' }
    },
    setStatus: async () => true,
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

function feedQuery(overrides: Partial<ListingFeedQuery> = {}): ListingFeedQuery {
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
  objectKeys: [`listings/${SELLER_ID}/a.jpg`],
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
    expect(response.items[0]?.id).toBe('01930000-0000-7000-8000-000000000012')
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
    expect(detail.isOwner).toBe(true)
    expect(detail.images.map((image) => image.url)).toEqual([
      `https://cdn.test/listings/${SELLER_ID}/a.jpg`,
      `https://cdn.test/listings/${SELLER_ID}/b.jpg`,
    ])
    expect(detail.seller).toEqual({
      id: SELLER_ID,
      nickname: '阿岚',
      avatarUrl: null,
      campus: '肇庆',
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

  test('does not leak authStatus through the seller projection', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const detail = await service.getDetail(null, LISTING_ID)
    expect('authStatus' in detail.seller).toBe(false)
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
    expect(result.detail.id).toBe(LISTING_ID)
  })

  test('reports created=true and returns the detail', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const result = await service.createListing(SELLER_ID, validCreate)

    expect(result.created).toBe(true)
    expect(result.detail.id).toBe(LISTING_ID)
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
      objectKeys: [`listings/${SELLER_ID}/new.jpg`],
    })

    expect(received.fields).toMatchObject({ title: '新标题', moderationStatus: 'APPROVED' })
    // `objectKeys` 不是 `listings` 的列，绝不能出现在 `fields` 里。
    expect(received.fields).not.toHaveProperty('objectKeys')
    expect(received.objectKeys).toEqual([`listings/${SELLER_ID}/new.jpg`])
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
