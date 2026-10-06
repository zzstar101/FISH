import { describe, expect, test } from 'bun:test'
import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import type { VisualEmbeddingProvider } from '@fish/contracts/visual/provider'
import {
  MAX_VISUAL_QUERY_IMAGE_BYTES,
  VISUAL_QUERY_IMAGE_TTL_SECONDS,
  VISUAL_SOLD_AVG_MIN_SAMPLES,
  type VisualInterpretation,
  type VisualSearchErrorCode,
  visualQueryImageKey,
} from '@fish/contracts/visual/schema'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'
import type { InsertVisualQueryImageInput } from '@fish/db/visual-query-store'
import type { ListingCardSource } from '../listings/card'
import { VISUAL_RECALL_LIMIT, VISUAL_RESULT_LIMIT } from './ranking'
import {
  createVisualSearchService,
  type VisualSearchService,
  VisualSearchServiceError,
  type VisualSearchServiceErrorStatus,
  type VisualSearchStorage,
} from './service'
import type {
  VisualListingSignals,
  VisualSearchCandidate,
  VisualSearchStore,
  VisualSoldPriceStats,
} from './store'
import type { ResolvedVisualSearchSubject } from './subject'

/**
 * 用例层单测：store / storage / provider / parser / rate limiter 全部用假实现，
 * 所以这里测的是**决策**（哪一档错误码、召回合并在哪里、排序怎么兜底），不是 SQL 或网络。
 * 真库集成（可见性过滤、Top-K）由 store 的集成测试与 core smoke 覆盖。
 */
const SUBJECT_KEY = 'session-abcdef0123456789'
const MODEL = 'stub-visual-deterministic-v1'
const QUERY_IMAGE_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-06-01T00:00:00.000Z')

/** 33 字节即可通过 `probeImage` 的 PNG 分支：签名 + IHDR + width/height。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const SMALL_PNG = pngBytes(4, 4)
/** 6000×6000 = 3600 万像素 > 2500 万上限：字节数很小，像素数才是"解压炸弹"的真实成本。 */
const HUGE_PIXEL_PNG = pngBytes(6000, 6000)

function vectorOf(value: number): number[] {
  return new Array<number>(VISUAL_EMBEDDING_DIMENSIONS).fill(value)
}

/** 图片路的向量：只在第 0 维打标记，好让假 `recall` 分辨两条路。 */
function imageVector(): number[] {
  const vector = vectorOf(0)
  vector[0] = 1
  return vector
}

/** 文本路的向量在第一维之外打标记，fake `recall` 靠它区分两路。 */
function textVector(): number[] {
  const vector = vectorOf(0)
  vector[1] = 1
  return vector
}

function subject(): ResolvedVisualSearchSubject {
  return {
    key: { subjectType: 'session', subjectKey: SUBJECT_KEY },
    attempts: [{ subjectType: 'session', subjectKey: SUBJECT_KEY }],
    issuedSessionId: null,
  }
}

function queryObjectKey(subjectKey = SUBJECT_KEY): string {
  return visualQueryImageKey(subjectKey, '22222222-2222-4222-8222-222222222222', 'png')
}

/**
 * 公开 ID 编码只接受规范 UUIDv7（`packages/shared/src/public-id.ts:26` 的 `UUID_V7`），
 * 而卡片映射会经过 `encodePublicId`，所以夹具的主键也必须长成 v7 形状。
 */
function listingId(seq: number): string {
  return `0197f0a1-0000-7000-8000-${seq.toString().padStart(12, '0')}`
}

function listingSource(id: string, overrides: Partial<ListingCardSource> = {}): ListingCardSource {
  return {
    id,
    // 卡片契约要求 12 位、首位非 0 的商品号（`/^[1-9][0-9]{11}$/`）。
    listingNo: 100000000001n,
    // 标题按 id 尾部区分：断言"谁排在前面"时只能靠可读字段，卡片里的 `id` 是编码后的公开 ID。
    title: `商品-${id.slice(-6)}`,
    priceCents: 1000,
    category: 'BOOKS',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    // 卡片必带卖家公开子集（#344）：同样要求 v7 形状的 UUID，否则 `encodePublicId` 会拒绝。
    seller: {
      id: '0197f0a1-0000-7000-8000-0000000000ff',
      nickname: '视觉搜索卖家',
      avatarUrl: null,
      authStatus: 'UNVERIFIED',
    },
    // 想要数（已建会话的买家数）：卡片契约的必填字段，fake 行给 0（本用例不关心它）。
    wants: 0,
    ...overrides,
  }
}

type HarnessState = {
  bytes: Uint8Array | null
  statSize: number | null
  usableQueryImage: boolean
  recall: (vector: number[]) => VisualSearchCandidate[]
  hasEmbeddings: boolean
  listings: ListingCardSource[]
  favoriteCounts: Map<string, number>
  embedImage: () => Promise<number[]>
  embedText: (text: string) => Promise<number[]>
  interpretation: VisualInterpretation | null
  /** `soldPriceStats` 的假返回值；`calls.soldStatsCategories` 记录它是否真的被问到。 */
  soldStats: VisualSoldPriceStats
}

type Harness = {
  service: VisualSearchService
  state: HarnessState
  calls: {
    consumed: number
    registered: InsertVisualQueryImageInput[]
    marked: string[]
    recalls: Array<{ vector: number[]; limit: number; excludeSellerId?: string | null }>
    parsed: number
    embeddedImages: number
    embeddedTexts: string[]
    soldStatsCategories: string[]
    /** 每次 `soldPriceStats` 收到的 `excludeSellerId`：证明服务端真的按请求者排除本人成交商品。 */
    soldStatsExcludeSellerIds: Array<string | null | undefined>
  }
}

function createHarness(overrides: Partial<HarnessState> = {}): Harness {
  const state: HarnessState = {
    bytes: SMALL_PNG,
    statSize: SMALL_PNG.length,
    usableQueryImage: true,
    recall: () => [],
    hasEmbeddings: true,
    listings: [],
    favoriteCounts: new Map(),
    embedImage: async () => vectorOf(1),
    embedText: async () => textVector(),
    interpretation: null,
    soldStats: { soldAvgPriceCents: null, soldSampleCount: 0 },
    ...overrides,
  }

  const calls: Harness['calls'] = {
    consumed: 0,
    registered: [],
    marked: [],
    recalls: [],
    parsed: 0,
    embeddedImages: 0,
    embeddedTexts: [],
    soldStatsCategories: [],
    soldStatsExcludeSellerIds: [],
  }

  const storage: VisualSearchStorage = {
    presignPut: (input) => ({
      url: `https://minio.example.com/${input.key}?sig=test`,
      headers: {},
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    }),
    stat: async () =>
      state.statSize === null ? null : { size: state.statSize, contentType: 'image/png' },
    readMediaBytes: async () => state.bytes,
    publicUrl: (key) => `https://cdn.example.com/${key}`,
  }

  const provider: VisualEmbeddingProvider = {
    model: MODEL,
    dimensions: VISUAL_EMBEDDING_DIMENSIONS,
    async embedImage() {
      calls.embeddedImages += 1
      return state.embedImage()
    },
    async embedText(text) {
      calls.embeddedTexts.push(text)
      return state.embedText(text)
    },
  }

  const store: VisualSearchStore = {
    async registerQueryImage(input) {
      calls.registered.push(input)
    },
    async findUsableQueryImage() {
      if (!state.usableQueryImage) return null
      return {
        id: QUERY_IMAGE_ID,
        objectKey: queryObjectKey(),
        subjectType: 'session',
        subjectKey: SUBJECT_KEY,
        expiresAt: new Date(NOW.getTime() + VISUAL_QUERY_IMAGE_TTL_SECONDS * 1000),
      }
    },
    async markQueryImageUsed(objectKey) {
      calls.marked.push(objectKey)
      return true
    },
    async recall(input) {
      calls.recalls.push({
        vector: input.vector,
        limit: input.limit,
        excludeSellerId: input.excludeSellerId,
      })
      return state.recall(input.vector)
    },
    async hasVisualEmbeddings() {
      return state.hasEmbeddings
    },
    async loadListingSignals(listingIds) {
      const signals = new Map<string, VisualListingSignals>()
      for (const listingId of listingIds) {
        signals.set(listingId, {
          listingId,
          coverObjectKey: `listings/${listingId}/0.png`,
          favoriteCount: state.favoriteCounts.get(listingId) ?? 0,
        })
      }
      return signals
    },
    async loadListings(listingIds) {
      const rows = new Map<string, ListingCardSource>()
      for (const listing of state.listings) {
        if (listingIds.includes(listing.id)) rows.set(listing.id, listing)
      }
      return rows
    },
    async soldPriceStats(input) {
      calls.soldStatsCategories.push(input.category)
      calls.soldStatsExcludeSellerIds.push(input.excludeSellerId)
      return state.soldStats
    },
  }

  const service = createVisualSearchService({
    store,
    storage,
    provider,
    parser: {
      async parse() {
        calls.parsed += 1
        return state.interpretation
      },
    },
    rateLimiter: {
      async consume() {
        calls.consumed += 1
      },
    },
    now: () => NOW,
  })

  return { service, state, calls }
}

function first<T>(items: T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error('期望至少有一条记录')
  return item
}

/** 断言抛出的服务错误码与状态码，并把它交回调用方做进一步检查。 */
async function expectServiceError(
  promise: Promise<unknown>,
  status: VisualSearchServiceErrorStatus,
  code: VisualSearchErrorCode,
): Promise<VisualSearchServiceError> {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof VisualSearchServiceError)) throw error
    expect({ status: error.status, code: error.code }).toEqual({ status, code })
    return error
  }
  throw new Error(`期望抛出 ${code}，实际成功返回`)
}

describe('createUpload', () => {
  test('键落在私有查询图前缀下，并把 presign 结果原样返回', async () => {
    const { service, calls } = createHarness()

    const result = await service.createUpload(subject(), {
      contentType: 'image/png',
      sizeBytes: 1234,
    })

    expect(result.objectKey.startsWith(`visual-search/${SUBJECT_KEY}/`)).toBe(true)
    expect(result.objectKey.endsWith('.png')).toBe(true)
    expect(result.url).toContain('sig=test')
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 300_000).toISOString())
    expect(calls.consumed).toBe(1)
  })

  test('台账行带主体、声明类型、大小与 TTL', async () => {
    const { service, calls } = createHarness()

    await service.createUpload(subject(), { contentType: 'image/webp', sizeBytes: 999 })

    const row = first(calls.registered)
    expect(row.subjectType).toBe('session')
    expect(row.subjectKey).toBe(SUBJECT_KEY)
    expect(row.contentType).toBe('image/webp')
    expect(row.sizeBytes).toBe(999)
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(VISUAL_QUERY_IMAGE_TTL_SECONDS * 1000)
  })

  test('声明的 MIME 决定对象键后缀（真值仍由搜索时的魔术字节决定）', async () => {
    const extensions = new Map([
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
      ['image/webp', '.webp'],
    ] as const)

    for (const [contentType, extension] of extensions) {
      const { service } = createHarness()
      const result = await service.createUpload(subject(), { contentType, sizeBytes: 10 })
      expect(result.objectKey.endsWith(extension)).toBe(true)
    }
  })
})

describe('search 的输入校验（图片不可信的三道闸）', () => {
  test('引用他人前缀的 objectKey 直接拒绝，且不进入向量化', async () => {
    const { service, calls } = createHarness()

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey('other-session') }),
      400,
      'VISUAL_SEARCH_IMAGE_INVALID',
    )
    expect(calls.embeddedImages).toBe(0)
    expect(calls.recalls.length).toBe(0)
  })

  test('键形状非法（路径穿越 / 非私有前缀）拒绝', async () => {
    const { service } = createHarness()

    for (const objectKey of [
      '../listing-media/secret.png',
      'listings/user/0.png',
      `visual-search/${SUBJECT_KEY}/../../secret.png`,
      'visual-search/',
    ]) {
      await expectServiceError(
        service.search(subject(), { objectKey }),
        400,
        'VISUAL_SEARCH_IMAGE_INVALID',
      )
    }
  })

  test('台账里没有可用行（不存在 / 过期 / 已被清理）一律同一句话', async () => {
    const { service, calls } = createHarness({ usableQueryImage: false })

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      400,
      'VISUAL_SEARCH_IMAGE_INVALID',
    )
    expect(calls.embeddedImages).toBe(0)
  })

  test('对象存储里的真实大小超过上限 ⇒ 413（不信客户端声明的 sizeBytes）', async () => {
    const { service, calls } = createHarness({ statSize: MAX_VISUAL_QUERY_IMAGE_BYTES + 1 })

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      413,
      'VISUAL_SEARCH_IMAGE_TOO_LARGE',
    )
    expect(calls.embeddedImages).toBe(0)
  })

  test('魔术字节不是允许的图片格式 ⇒ 400（客户端声明的 image/png 不作数）', async () => {
    const notAnImage = new TextEncoder().encode('<html>not an image</html>')
    const { service, calls } = createHarness({ bytes: notAnImage, statSize: notAnImage.length })

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      400,
      'VISUAL_SEARCH_IMAGE_INVALID',
    )
    expect(calls.embeddedImages).toBe(0)
  })

  test('像素数超过上限 ⇒ 413（解压炸弹护栏，字节数很小）', async () => {
    const { service, calls } = createHarness({
      bytes: HUGE_PIXEL_PNG,
      statSize: HUGE_PIXEL_PNG.length,
    })

    const error = await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      413,
      'VISUAL_SEARCH_IMAGE_TOO_LARGE',
    )
    expect(error.message).toContain('分辨率')
    expect(calls.embeddedImages).toBe(0)
  })
})

describe('search 的召回与合并', () => {
  test('成功路径：向量化的向量进入召回，返回卡片与策略版本', async () => {
    const listing = listingSource(listingId(1))
    const { service, calls } = createHarness({
      listings: [listing],
      recall: () => [{ listingId: listing.id, distance: 0 }],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.queryId).toBe(QUERY_IMAGE_ID)
    expect(result.embeddingModel).toBe(MODEL)
    expect(result.items.length).toBe(1)
    expect(calls.recalls.length).toBe(1)
    expect(first(calls.recalls).limit).toBe(VISUAL_RECALL_LIMIT)
    expect(calls.marked).toEqual([queryObjectKey()])
  })

  test('已登录主体把自己的 userId 传给两路召回做排除，匿名主体不设排除目标', async () => {
    const viewerId = listingId(9)
    const authenticated: ResolvedVisualSearchSubject = {
      key: { subjectType: 'user', subjectKey: viewerId },
      attempts: [{ subjectType: 'user', subjectKey: viewerId }],
      issuedSessionId: null,
    }
    const loggedIn = createHarness({ interpretation: { keywords: ['红色球鞋'] } })

    await loggedIn.service.search(authenticated, { objectKey: queryObjectKey(viewerId) })

    // 图片路 + 文本路各一次，两次都要带上同一个排除目标。
    expect(loggedIn.calls.recalls.map((call) => call.excludeSellerId)).toEqual([viewerId, viewerId])

    // 匿名主体的 subjectKey 是会话 HMAC（不是 userId）：没有可排除的主体。
    const anonymous = createHarness({ interpretation: { keywords: ['红色球鞋'] } })
    await anonymous.service.search(subject(), { objectKey: queryObjectKey() })

    expect(anonymous.calls.recalls.map((call) => call.excludeSellerId)).toEqual([null, null])
  })

  test('召回为空且库里根本没有该模型的向量 ⇒ 503 NO_EMBEDDING（回填没跑，不是"没人卖"）', async () => {
    const { service } = createHarness({ recall: () => [], hasEmbeddings: false })

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      503,
      'VISUAL_SEARCH_NO_EMBEDDING',
    )
  })

  test('召回为空但库里有向量 ⇒ 200 + 空 items（确实没有相似商品）', async () => {
    const { service } = createHarness({ recall: () => [], hasEmbeddings: true })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items).toEqual([])
    expect(result.interpretation).toBeNull()
  })

  test('召回到的候选全部低于相似度下限 ⇒ 200 + 空 items，而不是把最近邻塞给用户（#406 第 6 项）', async () => {
    const listing = listingSource(listingId(1))
    // 距离 1.2 ⇒ 相似度 0.4，低于 VISUAL_RECALL_MIN_SIMILARITY（0.5 = 余弦正交）。
    const { service, calls } = createHarness({
      listings: [listing],
      recall: () => [{ listingId: listing.id, distance: 1.2 }],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(calls.recalls.length).toBe(1)
    expect(result.items).toEqual([])
  })

  test('恰好等于下限（距离 1.0 ⇒ 相似度 0.5）仍然返回：下限是下界而不是"必须相似"', async () => {
    const listing = listingSource(listingId(1))
    const { service } = createHarness({
      listings: [listing],
      recall: () => [{ listingId: listing.id, distance: 1 }],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items.map((item) => item.title)).toEqual([listing.title])
  })

  test('未解析出文本时只走图片路一次召回', async () => {
    const { service, calls } = createHarness()

    await service.search(subject(), { objectKey: queryObjectKey() })

    expect(calls.recalls.length).toBe(1)
    expect(calls.parsed).toBe(1)
    expect(calls.embeddedTexts).toEqual([])
  })

  test('解析出文本时两路召回合并，图片证据排前、纯文本命中 visualScore = 0', async () => {
    const imageHit = listingSource(listingId(1))
    const textOnlyHit = listingSource(listingId(2))
    const { service, calls } = createHarness({
      listings: [imageHit, textOnlyHit],
      interpretation: { keywords: ['红色球鞋'] },
      embedImage: async () => imageVector(),
      // 图片路与自己距离 0（相似度 1），文本路给纯文本命中距离 0.4（相似度 0.8）
      recall: (vector) =>
        vector[0] === 1
          ? [{ listingId: imageHit.id, distance: 0 }]
          : [{ listingId: textOnlyHit.id, distance: 0.4 }],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(calls.recalls.length).toBe(2)
    expect(calls.embeddedTexts).toEqual(['红色球鞋'])
    // 图片路距离 0（相似度 1）> 文本路的 0.8，所以图片命中排第一，但两件都在结果里。
    expect(result.items.length).toBe(2)
    expect(result.items[0]?.title).toBe(imageHit.title)
    expect(result.items[1]?.title).toBe(textOnlyHit.title)
  })

  test('解析结果里没有可检索文本时不开文本路（分类仍参与排序）', async () => {
    const listing = listingSource(listingId(1))
    const { service, calls } = createHarness({
      listings: [listing],
      interpretation: { category: 'BOOKS' },
      recall: () => [{ listingId: listing.id, distance: 0 }],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(calls.recalls.length).toBe(1)
    expect(calls.embeddedTexts).toEqual([])
    expect(result.interpretation?.category).toBe('BOOKS')
  })

  test('文本路整段 fail-open：embedText 抛错仍返回图片路结果', async () => {
    const imageHit = listingSource(listingId(1))
    const { service } = createHarness({
      listings: [imageHit],
      interpretation: { text: '红色球鞋 42 码' },
      recall: () => [{ listingId: imageHit.id, distance: 0 }],
      embedText: async () => {
        throw new EmbeddingProviderError('http_status', '上游 500', { retryable: true })
      },
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items.length).toBe(1)
    expect(result.interpretation?.text).toBe('红色球鞋 42 码')
  })

  test('解析为分类一致时加分：同类目候选排在同距离的异类目前面', async () => {
    const sameCategory = listingSource(listingId(1), {
      category: 'BOOKS',
    })
    const otherCategory = listingSource(listingId(2), {
      category: 'BEAUTY',
    })
    const { service } = createHarness({
      listings: [sameCategory, otherCategory],
      interpretation: { category: 'BOOKS' },
      // 距离相同：只有 categoryScore（1 vs 0）能区分
      recall: () => [
        { listingId: otherCategory.id, distance: 0.5 },
        { listingId: sameCategory.id, distance: 0.5 },
      ],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items.map((item) => item.title)).toEqual([
      sameCategory.title,
      otherCategory.title,
    ])
  })
})

describe('search 的上游失败分类', () => {
  test('可重试的 provider 失败 ⇒ 503 + Retry-After 5', async () => {
    const { service } = createHarness({
      embedImage: async () => {
        throw new EmbeddingProviderError('network', '上游连不上', { retryable: true })
      },
    })

    const error = await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      503,
      'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
    )
    expect(error.retryAfterSeconds).toBe(5)
  })

  test('不可重试的 provider 失败 ⇒ 503 且不给 Retry-After', async () => {
    const { service } = createHarness({
      embedImage: async () => {
        throw new EmbeddingProviderError('invalid_response', '上游返回空', { retryable: false })
      },
    })

    const error = await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      503,
      'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
    )
    expect(error.retryAfterSeconds).toBeUndefined()
  })

  test('provider 返回错误维度 ⇒ 503（不能把 `::vector` 转换失败暴露成 500）', async () => {
    const { service, calls } = createHarness({
      embedImage: async () => vectorOf(1).slice(0, 8),
    })

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      503,
      'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
    )
    expect(calls.recalls.length).toBe(0)
  })

  test('provider 返回非有限值 ⇒ 503', async () => {
    const { service } = createHarness({
      embedImage: async () => {
        const vector = vectorOf(1)
        vector[3] = Number.NaN
        return vector
      },
    })

    await expectServiceError(
      service.search(subject(), { objectKey: queryObjectKey() }),
      503,
      'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
    )
  })
})

describe('search 的排序与截断', () => {
  test('结果截断到 VISUAL_RESULT_LIMIT', async () => {
    const listings: ListingCardSource[] = []
    for (let index = 0; index < VISUAL_RESULT_LIMIT + 10; index += 1) {
      listings.push(listingSource(listingId(index)))
    }
    const { service } = createHarness({
      listings,
      recall: () =>
        listings.map((listing, index) => ({ listingId: listing.id, distance: index / 100 })),
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items.length).toBe(VISUAL_RESULT_LIMIT)
  })

  test('更相似的排在前面（距离越小越靠前）', async () => {
    const near = listingSource(listingId(1))
    const far = listingSource(listingId(2))
    const { service } = createHarness({
      listings: [near, far],
      recall: () => [
        { listingId: far.id, distance: 0.9 },
        { listingId: near.id, distance: 0.1 },
      ],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items[0]?.title).toBe(near.title)
    expect(result.items[0]?.id).not.toBe(result.items[1]?.id)
  })

  test('召回后已不可见的商品（loadListings 缺席）被跳过，不留过期卡片', async () => {
    const visible = listingSource(listingId(1))
    const delisted = listingSource(listingId(2))
    const { service } = createHarness({
      listings: [visible],
      recall: () => [
        { listingId: visible.id, distance: 0.1 },
        { listingId: delisted.id, distance: 0.2 },
      ],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items.length).toBe(1)
  })

  test('收藏数参与热度分：同一商品收藏 20 件比 0 件排前', async () => {
    const popular = listingSource(listingId(1))
    const plain = listingSource(listingId(2))
    const favorites = new Map<string, number>()
    favorites.set(popular.id, 20)
    const { service } = createHarness({
      listings: [popular, plain],
      favoriteCounts: favorites,
      // 距离相同，只有热度不同
      recall: () => [
        { listingId: plain.id, distance: 0.5 },
        { listingId: popular.id, distance: 0.5 },
      ],
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.items[0]?.id).not.toBe(result.items[1]?.id)
    expect(result.items.length).toBe(2)
  })
})

describe('search 的排序档', () => {
  test('sort=price_asc 在截断之前排序：拿到全局最便宜的 30 条，而不是重排前 30 条', async () => {
    const total = VISUAL_RESULT_LIMIT + 10
    // 价格与相似度反向：越相似越贵。于是"不带排序时入选的前 30 条"恰好是最贵的 30 条。
    const listings = Array.from({ length: total }, (_, index) =>
      listingSource(listingId(index), { priceCents: (total - index) * 100 }),
    )
    const { service } = createHarness({
      listings,
      recall: () =>
        listings.map((listing, index) => ({ listingId: listing.id, distance: index / 100 })),
    })

    const result = await service.search(subject(), {
      objectKey: queryObjectKey(),
      sort: 'price_asc',
    })

    expect(result.items.length).toBe(VISUAL_RESULT_LIMIT)
    // 最便宜的在 index = total - 1（相似度最低），它只有"先排序再截断"才可能出现在结果里。
    expect(result.items[0]?.priceCents).toBe(100)
    expect(result.items[result.items.length - 1]?.priceCents).toBe(VISUAL_RESULT_LIMIT * 100)
  })

  test('sort=popular 真的改变顺序：按想要数降序，并把想要数带进结果项', async () => {
    const liked = listingSource(listingId(1))
    const quiet = listingSource(listingId(2))
    const favoriteCounts = new Map<string, number>([[liked.id, 9]])
    const { service } = createHarness({
      listings: [liked, quiet],
      favoriteCounts,
      // 相似度是反向的：只看 relevance，quiet 才是第一名。
      recall: () => [
        { listingId: quiet.id, distance: 0.1 },
        { listingId: liked.id, distance: 0.9 },
      ],
    })

    const byRelevance = await service.search(subject(), { objectKey: queryObjectKey() })
    const byPopular = await service.search(subject(), {
      objectKey: queryObjectKey(),
      sort: 'popular',
    })

    expect(byRelevance.items[0]?.title).toBe(quiet.title)
    expect(byPopular.items[0]?.title).toBe(liked.title)
    expect(byPopular.items.map((item) => item.favoriteCount)).toEqual([9, 0])
  })
})

describe('search 的成交均价统计', () => {
  test('没解析出类目时给空统计，并且根本不查库', async () => {
    const { service, calls } = createHarness({ interpretation: null })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.stats).toEqual({ soldAvgPriceCents: null, soldSampleCount: 0 })
    expect(calls.soldStatsCategories).toEqual([])
  })

  test('样本不足阈值时均价为 null，但仍返回真实样本数（客户端要能说"样本不足"）', async () => {
    const belowThreshold = VISUAL_SOLD_AVG_MIN_SAMPLES - 1
    const { service, calls } = createHarness({
      interpretation: { category: 'BOOKS' },
      soldStats: { soldAvgPriceCents: 1234, soldSampleCount: belowThreshold },
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.stats).toEqual({ soldAvgPriceCents: null, soldSampleCount: belowThreshold })
    // 统计口径跟着解析出的类目走，不是"全局均价"。
    expect(calls.soldStatsCategories).toEqual(['BOOKS'])
  })

  test('样本达到阈值时返回四舍五入的均价（阈值判定锁在服务端）', async () => {
    const { service } = createHarness({
      interpretation: { category: 'DIGITAL' },
      soldStats: {
        soldAvgPriceCents: 1234.6,
        soldSampleCount: VISUAL_SOLD_AVG_MIN_SAMPLES,
      },
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.stats).toEqual({
      soldAvgPriceCents: 1235,
      soldSampleCount: VISUAL_SOLD_AVG_MIN_SAMPLES,
    })
  })

  test('样本足够但均价缺失（防御）时仍是 null，不把 null 变成 0', async () => {
    const { service } = createHarness({
      interpretation: { category: 'BOOKS' },
      soldStats: { soldAvgPriceCents: null, soldSampleCount: VISUAL_SOLD_AVG_MIN_SAMPLES },
    })

    const result = await service.search(subject(), { objectKey: queryObjectKey() })

    expect(result.stats.soldAvgPriceCents).toBeNull()
  })

  test('已登录时把请求者 userId 传给统计做排除，匿名时不设排除目标（#406 第 2 项）', async () => {
    const viewerId = listingId(9)
    const authenticated: ResolvedVisualSearchSubject = {
      key: { subjectType: 'user', subjectKey: viewerId },
      attempts: [{ subjectType: 'user', subjectKey: viewerId }],
      issuedSessionId: null,
    }

    const loggedIn = createHarness({ interpretation: { category: 'BOOKS' } })
    await loggedIn.service.search(authenticated, { objectKey: queryObjectKey(viewerId) })

    // 与召回侧同一个排除目标：本人已成交商品不进行情。
    expect(loggedIn.calls.soldStatsExcludeSellerIds).toEqual([viewerId])

    // 匿名主体的 subjectKey 是会话 HMAC（不是 userId）：没有可排除的主体。
    const anonymous = createHarness({ interpretation: { category: 'BOOKS' } })
    await anonymous.service.search(subject(), { objectKey: queryObjectKey() })

    expect(anonymous.calls.soldStatsExcludeSellerIds).toEqual([null])
  })
})
