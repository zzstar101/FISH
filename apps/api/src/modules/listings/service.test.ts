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
  ListingState,
  ListingStore,
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
    updateListing: async () => listingRow(),
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
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    const error = await expectServiceError(() =>
      service.updateListing(OTHER_ID, LISTING_ID, { title: '新标题' }),
    )
    expect(error.status).toBe(403)
  })

  test('rejects edits while RESERVED or SOLD (transaction-owned states)', async () => {
    for (const status of ['RESERVED', 'SOLD'] as ListingStatus[]) {
      const service = createListingService({
        storage: fakeStorage(),
        store: fakeStore({
          findState: async (): Promise<ListingState> => ({
            sellerId: SELLER_ID,
            status,
            priceCents: 16000,
            free: false,
          }),
        }),
      })
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
        findState: async () => ({
          sellerId: SELLER_ID,
          status: 'ACTIVE',
          priceCents: 0,
          free: true,
        }),
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
        updateListing: async (input) => {
          received.fields = input.fields
          if (input.objectKeys) received.objectKeys = input.objectKeys
          return listingRow()
        },
      }),
    })

    await service.updateListing(SELLER_ID, LISTING_ID, {
      title: '新标题',
      objectKeys: [`listings/${SELLER_ID}/new.jpg`],
    })

    expect(received.fields).toEqual({ title: '新标题' })
    expect(received.objectKeys).toEqual([`listings/${SELLER_ID}/new.jpg`])
  })

  // 并发：service 读到的还是可编辑状态，但 UPDATE 时它已变成 RESERVED / SOLD（#11 的交易流程），
  // UPDATE 的 status 谓词会命中 0 行 —— 这必须是 409 而不是 404。
  test('reports 409 when the listing became RESERVED between the read and the write', async () => {
    // fake 必须是**有状态**的：第一次 findState 是前置检查（此时仍可编辑，请求得以继续），
    // 第二次是 UPDATE 没命中后的复读（此时已被并发改成 RESERVED）。
    // 若两次都返回 RESERVED，异常会在前置检查就抛出，`updateListing` 根本不会被调用 ——
    // 那样即使把 service 的 409 分支回退成 404，用例也照样通过（等于没测）。
    let reads = 0
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListing: async () => null,
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
      service.updateListing(SELLER_ID, LISTING_ID, { title: '新标题' }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('LISTING_NOT_EDITABLE')
  })

  test('returns 404 when the listing disappears between the check and the update', async () => {
    // 先读到可编辑的行，UPDATE 没命中后再读已经查不到该行（并发删除）
    let reads = 0
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        updateListing: async () => null,
        findState: async () => {
          reads += 1
          return reads === 1
            ? { sellerId: SELLER_ID, status: 'ACTIVE' as const, priceCents: 16000, free: false }
            : null
        },
      }),
    })
    expect(
      (
        await expectServiceError(() =>
          service.updateListing(SELLER_ID, LISTING_ID, { title: '新标题' }),
        )
      ).status,
    ).toBe(404)
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
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        setStatus: async () => false,
        findState: async () => ({
          sellerId: SELLER_ID,
          status: 'RESERVED',
          priceCents: 16000,
          free: false,
        }),
      }),
    })
    expect(
      (await expectServiceError(() => service.transition(SELLER_ID, LISTING_ID, 'OFFLINE'))).status,
    ).toBe(409)
  })

  test('treats a concurrent change to the target status as success', async () => {
    const service = createListingService({
      storage: fakeStorage(),
      store: fakeStore({
        setStatus: async () => false,
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
      }),
    })

    await service.transition(SELLER_ID, LISTING_ID, 'OFFLINE')
  })

  test('rejects transitions from a stranger without revealing the listing', async () => {
    const service = createListingService({ storage: fakeStorage(), store: fakeStore() })
    expect(
      (await expectServiceError(() => service.transition(OTHER_ID, LISTING_ID, 'OFFLINE'))).status,
    ).toBe(403)
  })
})
