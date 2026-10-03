import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { INTEREST_STRATEGY_VERSION } from '@fish/contracts/recommendation/interest'
import {
  composeRecommendationStrategyVersion,
  RANK_STRATEGY_VERSION,
  RECOMMENDATION_STRATEGY_VERSION_RULE,
} from '@fish/contracts/recommendation/rank'
import { RECALL_STRATEGY_VERSION, type RecallChannel } from '@fish/contracts/recommendation/recall'
import {
  RECOMMENDATION_STRATEGY_VERSION_NONE,
  type RecommendationEventInput,
  type RecommendationEventType,
} from '@fish/contracts/recommendation/schema'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequestItems } from '@fish/db/schema/recommendation-request-items'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq, ne, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'
import { ListingServiceError } from './modules/listings/service'
import { encodeRecommendationCursor } from './modules/recommendation/cursor'
import { createRecommendationRecall } from './modules/recommendation/recall/service'
import { createRecommendationService } from './modules/recommendation/service'
import { createSqlRecommendationStore } from './modules/recommendation/store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.comments.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_recommendation_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const PASSWORD = 'fish123456'

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function registerUser(serial: string): Promise<{ id: string; cookie: string }> {
  const response = await app.request(
    '/auth/register',
    post({
      studentNo: `2021000000${serial}`,
      password: PASSWORD,
      nickname: `推荐验收${serial}`,
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  return { id: decodePublicId(PUBLIC_ID_PREFIX.user, body.user.id), cookie }
}

async function createListing(sellerId: string, title = '推荐验收商品'): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title,
    description: '推荐验收',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  return encodePublicId(PUBLIC_ID_PREFIX.listing, id)
}

interface FeedBody {
  requestId: string
  strategyVersion: string
  items: { id: string }[]
  nextCursor: string | null
}

const SESSION_HEADER = 'x-anonymous-session-id'

/**
 * 排序模式下请求行的 `strategyVersion` 真值。
 *
 * 直接从契约常量拼出来而不是抄字面量：串里任何一段换版本（R4 之后还有 R6/R7）都该让断言跟着变，
 * 抄字面量会让"版本升级了但测试还在断言旧串"这种漂移静默通过。
 */
const RANKED_STRATEGY_VERSION = composeRecommendationStrategyVersion([
  RECOMMENDATION_STRATEGY_VERSION_RULE,
  INTEREST_STRATEGY_VERSION,
  RECALL_STRATEGY_VERSION,
  RANK_STRATEGY_VERSION,
])

async function fetchFeed(
  query = '',
  headers: Record<string, string> = {},
): Promise<{ body: FeedBody; sessionId: string | null; status: number }> {
  const response = await app.request(`/recommendations/feed${query}`, { headers })
  const status = response.status
  const body = status === 200 ? ((await response.json()) as FeedBody) : ({} as FeedBody)
  return { body, sessionId: response.headers.get(SESSION_HEADER), status }
}

/**
 * 篡改外层推荐游标里的**内层商品游标**：外层 JSON/requestId 都合法，只有 `listingCursor` 是坏的。
 *
 * 这是"坏游标必须 422 不能 500"最容易漏的一条路径：外层由推荐层解，内层由 listings 层解，
 * 后者的异常必须被推荐层接下（service.ts 的 ListingServiceError → invalidCursor）。
 */
function tamperListingCursor(cursor: string, listingCursor: string): string {
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    requestId: string
  }
  return Buffer.from(
    JSON.stringify({ listingCursor, requestId: decoded.requestId }),
    'utf8',
  ).toString('base64url')
}

/** 查某商品的某类事件（多个 describe 共用，所以放模块作用域）。 */
async function eventsFor(listingPublicId: string, eventType: RecommendationEventType) {
  return db
    .select()
    .from(recommendationEvents)
    .where(
      and(
        eq(recommendationEvents.eventType, eventType),
        eq(
          recommendationEvents.listingId,
          decodePublicId(PUBLIC_ID_PREFIX.listing, listingPublicId),
        ),
      ),
    )
}

describe('recommendation API wiring (#323 R1)', () => {
  test('匿名 Feed：返回 requestId/strategyVersion，并补发会话标识', async () => {
    const seller = await registerUser('01')
    // 两件商品：后续"归因链"用例用 limit=1 要求必须存在下一页。
    await createListing(seller.id, '推荐验收商品 1')
    await createListing(seller.id, '推荐验收商品 2')

    const { body, sessionId, status } = await fetchFeed()
    expect(status).toBe(200)
    // #323 R4：Feed 从"最新透传"变成"召回 → 排序 → 快照"，请求行因此记复合版本串（见
    // RANKED_STRATEGY_VERSION）；只有"排序拿不出任何候选"的降级路径才回落到 rec-v1-none。
    expect(body.strategyVersion).toBe(RANKED_STRATEGY_VERSION)
    expect(body.strategyVersion).not.toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.items.length).toBeGreaterThan(0)
    // 服务端必须补发会话标识：客户端存不下来就会每次都是新会话。
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    // 内部排序分不下发（#323 §M7）。
    expect(body).not.toHaveProperty('rankScore')

    // 请求行真的落库了，且是匿名身份。
    const [row] = await db
      .select()
      .from(recommendationRequests)
      .where(eq(recommendationRequests.id, body.requestId))
    expect(row?.anonymousSessionId).toBe(sessionId)
    expect(row?.userId).toBeNull()
  })

  test('带会话标识的 Feed：不重复补发，请求行复用同一个会话', async () => {
    const sessionId = newId()
    const { body, sessionId: issued } = await fetchFeed('', { [SESSION_HEADER]: sessionId })
    expect(issued).toBeNull()

    const [row] = await db
      .select()
      .from(recommendationRequests)
      .where(eq(recommendationRequests.id, body.requestId))
    expect(row?.anonymousSessionId).toBe(sessionId)
  })

  test('归因链：推荐请求 → 曝光 → 详情，落库带 requestId/position/source', async () => {
    const sessionId = newId()
    const { body } = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    const card = body.items[0]
    if (!card) throw new Error('Feed 未返回商品')
    expect(body.nextCursor).not.toBeNull()

    const eventId = crypto.randomUUID()
    const response = await app.request(
      '/recommendations/events',
      post(
        {
          events: [
            {
              eventId,
              requestId: body.requestId,
              listingId: card.id,
              eventType: 'IMPRESSION',
              position: 0,
              source: 'fresh',
              anonymousSessionId: sessionId,
              metadata: { visibleRatio: 0.8, durationMs: 1500 },
            },
            {
              eventId: crypto.randomUUID(),
              requestId: body.requestId,
              listingId: card.id,
              eventType: 'DETAIL_VIEW',
              position: 0,
              source: 'fresh',
              anonymousSessionId: sessionId,
            },
          ],
        },
        { [SESSION_HEADER]: sessionId },
      ),
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0, rejected: 0 })

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, body.requestId))
    expect(rows).toHaveLength(2)
    const impression = rows.find((row) => row.eventType === 'IMPRESSION')
    expect(impression?.listingId).toBe(decodePublicId(PUBLIC_ID_PREFIX.listing, card.id))
    expect(impression?.position).toBe(0)
    expect(impression?.source).toBe('fresh')
    expect(impression?.anonymousSessionId).toBe(sessionId)
    expect(impression?.userId).toBeNull()
    expect(impression?.metadata).toEqual({ visibleRatio: 0.8, durationMs: 1500 })
  })

  test('客户端不带 source：服务端按快照真值补 source/position（客户端不猜召回通道）', async () => {
    const sessionId = newId()
    const { body } = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    const card = body.items[0]
    if (!card) throw new Error('Feed 未返回商品')

    const response = await app.request(
      '/recommendations/events',
      post(
        {
          events: [
            {
              eventId: crypto.randomUUID(),
              requestId: body.requestId,
              listingId: card.id,
              eventType: 'IMPRESSION',
              position: 0,
              anonymousSessionId: sessionId,
            },
          ],
        },
        { [SESSION_HEADER]: sessionId },
      ),
    )
    expect(response.status).toBe(202)

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, body.requestId))
    expect(rows).toHaveLength(1)

    /*
     * #323 R4/N6：排序模式下 source/position 不再是"客户端上报 + 服务端补 fresh"，而是快照真值。
     * 断言必须对着 `recommendation_request_items` 比，而不是对着某个硬编码通道名：硬编码会让
     * "服务端开始信任客户端 source"这种回归静默通过（那正是 R4 要消掉的伪归因）。
     */
    const snapshot = await db
      .select()
      .from(recommendationRequestItems)
      .where(
        and(
          eq(recommendationRequestItems.requestId, body.requestId),
          eq(
            recommendationRequestItems.listingId,
            decodePublicId(PUBLIC_ID_PREFIX.listing, card.id),
          ),
        ),
      )
    expect(snapshot).toHaveLength(1)
    expect(rows[0]?.source).toBe(snapshot[0]?.primarySource)
    expect(rows[0]?.position).toBe(snapshot[0]?.position)
  })

  test('重试同一条事件：幂等键撞唯一索引 → duplicates，不写第二行', async () => {
    const sessionId = newId()
    const { body } = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    const card = body.items[0]
    if (!card) throw new Error('Feed 未返回商品')

    const eventId = crypto.randomUUID()
    const payload = {
      events: [
        {
          eventId,
          requestId: body.requestId,
          listingId: card.id,
          eventType: 'IMPRESSION',
          position: 0,
          source: 'fresh',
          anonymousSessionId: sessionId,
        },
      ],
    }

    const first = await app.request('/recommendations/events', post(payload))
    expect(await first.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    const replay = await app.request('/recommendations/events', post(payload))
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1, rejected: 0 })

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.eventId, eventId))
    expect(rows).toHaveLength(1)
  })

  test('拒收：商品不存在 / 会话与 requestId 不符，都不写行', async () => {
    const sessionId = newId()
    const { body } = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    const card = body.items[0]
    if (!card) throw new Error('Feed 未返回商品')

    // 商品不存在：公开 id 合法但库里没有这行。
    const ghostListingId = encodePublicId(PUBLIC_ID_PREFIX.listing, newId())
    const ghost = await app.request(
      '/recommendations/events',
      post({
        events: [
          {
            eventId: crypto.randomUUID(),
            requestId: body.requestId,
            listingId: ghostListingId,
            eventType: 'DETAIL_VIEW',
            anonymousSessionId: sessionId,
          },
        ],
      }),
    )
    expect(await ghost.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 1 })

    // 别人的 requestId：用另一个会话声明这次曝光，必须整条拒收（否则曝光可被伪造到他人会话上）。
    const otherSession = newId()
    const forged = await app.request(
      '/recommendations/events',
      post({
        events: [
          {
            eventId: crypto.randomUUID(),
            requestId: body.requestId,
            listingId: card.id,
            eventType: 'IMPRESSION',
            position: 0,
            source: 'fresh',
            anonymousSessionId: otherSession,
          },
        ],
      }),
    )
    expect(await forged.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 1 })

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, body.requestId))
    expect(rows).toHaveLength(0)
  })

  test('契约校验：曝光缺 position / metadata 出现白名单外的键 → 422', async () => {
    const sessionId = newId()
    const { body } = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    const card = body.items[0]
    if (!card) throw new Error('Feed 未返回商品')

    const missingPosition = await app.request(
      '/recommendations/events',
      post({
        events: [
          {
            eventId: crypto.randomUUID(),
            requestId: body.requestId,
            listingId: card.id,
            eventType: 'IMPRESSION',
            anonymousSessionId: sessionId,
          },
        ],
      }),
    )
    expect(missingPosition.status).toBe(422)

    const badMetadata = await app.request(
      '/recommendations/events',
      post({
        events: [
          {
            eventId: crypto.randomUUID(),
            listingId: card.id,
            eventType: 'DETAIL_VIEW',
            metadata: { q: '随便搜的词' },
          },
        ],
      }),
    )
    expect(badMetadata.status).toBe(422)
  })

  test('游标：翻页复用同一个 requestId；伪造或跨会话的游标 422', async () => {
    const seller = await registerUser('02')
    await createListing(seller.id, '推荐验收商品 A')
    await createListing(seller.id, '推荐验收商品 B')

    const sessionId = newId()
    const first = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    expect(first.body.nextCursor).not.toBeNull()

    const second = await fetchFeed(`?limit=1&cursor=${first.body.nextCursor}`, {
      [SESSION_HEADER]: sessionId,
    })
    expect(second.status).toBe(200)
    // 同一次滚动必须还在同一次推荐请求里，否则 position 会从 0 重来。
    expect(second.body.requestId).toBe(first.body.requestId)
    expect(second.body.strategyVersion).toBe(RANKED_STRATEGY_VERSION)

    const forged = await fetchFeed('?cursor=not-a-cursor', { [SESSION_HEADER]: sessionId })
    expect(forged.status).toBe(422)

    // 外层合法、内层坏：也必须是 422。这里先被**形状校验**拦下（`{listingCursor, requestId}` 是
    // passthrough 形状，而这条请求行是排序模式），"坏内层游标 → listings 层 ListingServiceError
    // → 422 而不是 500" 那条映射由降级路径的用例覆盖（只有 rec-v1-none 的请求才接受 passthrough）。
    const tampered = await fetchFeed(
      `?cursor=${tamperListingCursor(first.body.nextCursor ?? '', 'not-a-listing-cursor')}`,
      { [SESSION_HEADER]: sessionId },
    )
    expect(tampered.status).toBe(422)

    const foreign = await fetchFeed(`?cursor=${first.body.nextCursor}`, {
      [SESSION_HEADER]: newId(),
    })
    expect(foreign.status).toBe(422)
  })

  test('拒收客户端上报的服务端确证类事件（PURCHASE 等只能由服务端写路径产生）', async () => {
    const seller = await registerUser('03')
    const listingId = await createListing(seller.id, '确证类事件验收商品')

    // 这个端点匿名可写：照收客户端上报的 PURCHASE/CHAT_START 就等于任何人 POST 一批
    // 都能污染训练数据，而且落库后无法与真实交易区分。
    const response = await app.request(
      '/recommendations/events',
      post({
        events: [
          { eventId: crypto.randomUUID(), listingId, eventType: 'PURCHASE' },
          { eventId: crypto.randomUUID(), listingId, eventType: 'CHAT_START' },
          { eventId: crypto.randomUUID(), listingId, eventType: 'COMMENT' },
          { eventId: crypto.randomUUID(), listingId, eventType: 'TRANSACTION_START' },
        ],
      }),
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 4 })

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(
        eq(recommendationEvents.listingId, decodePublicId(PUBLIC_ID_PREFIX.listing, listingId)),
      )
    expect(rows).toHaveLength(0)
  })

  test('不碰确定性 Feed：GET /listings?sort=newest 仍然没有推荐字段', async () => {
    const response = await app.request('/listings?sort=newest')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Array.isArray(body.items)).toBe(true)
    expect(body).not.toHaveProperty('requestId')
    expect(body).not.toHaveProperty('strategyVersion')
  })
})

/**
 * 排序 Feed 的编排与归因真值（#323 R4/R5）。
 *
 * 这里覆盖"排序模式"独有的行为：快照冻结顺序、翻页只做切片、可见性变化不补位、
 * 客户端上报的 position/source 一律作废，以及整条管线失败时退回 R1 透传的兼容口径。
 *
 * 降级路径（②⑦⑧）用 `createRecommendationService` 直接装配：app 的装配没有注入点，
 * 而"召回抛错"只能靠替换 recall 来构造；其余依赖都是真的（真 store、真 scratch 库、真事件表）。
 */
describe('recommendation ranked feed (#323 R4/R5)', () => {
  const rawListingId = (publicId: string) => decodePublicId(PUBLIC_ID_PREFIX.listing, publicId)

  /** 降级装配：recall 一定抛错 ⇒ 走 `scored.length === 0` 的 newest 透传分支。 */
  function createDegradedService(
    innerCursor: string | null,
    onListFeed?: (cursor: unknown) => void,
  ) {
    return createRecommendationService({
      store: createSqlRecommendationStore(db),
      listings: {
        listFeed: async (_viewerId, criteria) => {
          onListFeed?.(criteria.cursor)
          return { items: [], nextCursor: innerCursor }
        },
        listCardsByIds: async () => new Map(),
      },
      recall: {
        recall: async () => {
          throw new Error('模拟召回管线崩溃')
        },
      },
      interest: { enqueue: async () => {} },
    })
  }

  async function snapshotOf(requestId: string) {
    return db
      .select()
      .from(recommendationRequestItems)
      .where(eq(recommendationRequestItems.requestId, requestId))
      .orderBy(recommendationRequestItems.position)
  }

  test('召回层抛错 → 200 降级为 newest 透传：strategyVersion 记 rec-v1-none 且不写快照', async () => {
    const sessionId = newId()
    const service = createDegradedService(null)

    const page = await service.startFeed({
      viewerId: null,
      anonymousSessionId: sessionId,
      limit: 20,
    })

    expect(page.response.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)
    expect(page.response.nextCursor).toBeNull()
    expect(page.response.items).toEqual([])

    const [row] = await db
      .select()
      .from(recommendationRequests)
      .where(eq(recommendationRequests.id, page.response.requestId))
    expect(row?.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)

    // 降级不写快照：写了的话第二页会按快照切片，而第一页其实是 newest 页 —— 顺序当场错位。
    expect(await snapshotOf(page.response.requestId)).toHaveLength(0)
  })

  test('快照写不进去 → 整笔请求降级：不返回一个查不到快照的 ranked requestId', async () => {
    const sessionId = newId()
    const listingId = newId()
    const service = createRecommendationService({
      // 只替换「请求行 + 快照」这一次原子写，其余依赖都是真的（真 store、真 scratch 库）：
      // 失败形状与线上一致，降级后的请求行也必须真的落库。
      store: {
        ...createSqlRecommendationStore(db),
        createRequestWithItems: async () => {
          throw new Error('模拟快照写入失败')
        },
      },
      listings: {
        listFeed: async () => ({ items: [], nextCursor: 'inner-listing-cursor' }),
        // 可见性真值返回空 Map ≠ 没有候选：快照仍要按重排结果编号，所以原子写照样会走到。
        listCardsByIds: async () => new Map(),
      },
      recall: {
        recall: async () => ({
          strategyVersion: 'recall-v1',
          candidates: [
            {
              listingId,
              sellerId: newId(),
              category: 'OTHER',
              recallSources: ['fresh'],
              semanticScore: null,
              wishScore: null,
              popularity: null,
              userCategoryAffinity: null,
              freshness: 1,
              createdAt: new Date(),
              alreadySeenCount: null,
              sellerExposure: 0,
            },
          ],
          channels: [],
          interest: { session: false, longTerm: false, combined: false },
          mergeDegradedReason: null,
        }),
      },
      interest: { enqueue: async () => {} },
    })

    const page = await service.startFeed({
      viewerId: null,
      anonymousSessionId: sessionId,
      limit: 20,
    })

    // 返给客户端的上下文必须**有服务端归因真值**。R4 起 position/source 只信快照，所以把那个
    // 写不进快照的 ranked requestId 交出去，等于让客户端照它上报的整页曝光全部落进
    // `attribution_not_found` 被静默拒收 —— 页面看着正常，数据一行不剩。
    expect(page.response.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)
    expect(page.response.nextCursor).not.toBeNull()

    const [row] = await db
      .select()
      .from(recommendationRequests)
      .where(eq(recommendationRequests.id, page.response.requestId))
    expect(row?.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)

    // 库里也不能留下任何一条没有快照的 ranked 请求行：R6 的 `empty_ranked_feed_requests`
    // 会把它报成数据质量异常，而它其实是「写失败」而不是「确实没有可发的推荐」。
    const orphans = await db
      .select({ id: recommendationRequests.id })
      .from(recommendationRequests)
      .where(
        and(
          eq(recommendationRequests.anonymousSessionId, sessionId),
          ne(recommendationRequests.strategyVersion, RECOMMENDATION_STRATEGY_VERSION_NONE),
        ),
      )
    expect(orphans).toEqual([])
  })

  test('候选没有归因来源时宁可不发：不会把写不出快照行的卡片交给客户端', async () => {
    const sessionId = newId()
    const attributableId = newId()
    const noSourceId = newId()
    const requestedPages: string[][] = []
    const candidate = (listingId: string, recallSources: readonly RecallChannel[]) => ({
      listingId,
      sellerId: newId(),
      category: 'OTHER',
      recallSources: [...recallSources],
      semanticScore: null,
      wishScore: null,
      popularity: null,
      userCategoryAffinity: null,
      freshness: 1,
      createdAt: new Date(),
      alreadySeenCount: null,
      sellerExposure: 0,
    })
    const service = createRecommendationService({
      store: createSqlRecommendationStore(db),
      listings: {
        listFeed: async () => ({ items: [], nextCursor: null }),
        listCardsByIds: async (_viewerId, ids) => {
          requestedPages.push([...ids])
          return new Map()
        },
      },
      recall: {
        recall: async () => ({
          strategyVersion: 'recall-v1',
          candidates: [candidate(attributableId, ['fresh']), candidate(noSourceId, [])],
          channels: [],
          interest: { session: false, longTerm: false, combined: false },
          mergeDegradedReason: null,
        }),
      },
      interest: { enqueue: async () => {} },
    })

    await service.startFeed({ viewerId: null, anonymousSessionId: sessionId, limit: 20 })

    // R4 起 position/source 只信服务端快照，而快照行必须有 primary source ⇒ `recallSources`
    // 为空的候选在库里没有归因真值。把它交给客户端，它的曝光就会被 `attribution_not_found`
    // 静默拒收（页面正常、数据一行不剩），所以它连可见性查询都不该进。
    expect(requestedPages).toEqual([[attributableId]])
  })

  test('第一页写快照、第二页按快照切片：position 连续、不重不漏、requestId 复用', async () => {
    const seller = await registerUser('61')
    for (let index = 0; index < 5; index += 1) {
      await createListing(seller.id, `快照翻页验收商品 ${index}`)
    }

    const sessionId = newId()
    const first = await fetchFeed('?limit=2', { [SESSION_HEADER]: sessionId })
    expect(first.status).toBe(200)
    expect(first.body.strategyVersion).toBe(RANKED_STRATEGY_VERSION)
    expect(first.body.items).toHaveLength(2)
    expect(first.body.nextCursor).not.toBeNull()

    const snapshot = await snapshotOf(first.body.requestId)
    expect(snapshot.length).toBeGreaterThan(2)
    // position 必须是 0 起的连续下标：客户端数出来的"第 N 位"就是服务端记下的 position。
    expect(snapshot.map((row) => row.position)).toEqual(snapshot.map((_, index) => index))
    // 第一页发出的卡片就是快照前 2 行，顺序也一致。
    expect(first.body.items.map((item) => rawListingId(item.id))).toEqual(
      snapshot.slice(0, 2).map((row) => row.listingId),
    )

    const second = await fetchFeed(`?limit=2&cursor=${first.body.nextCursor}`, {
      [SESSION_HEADER]: sessionId,
    })
    expect(second.status).toBe(200)
    // 翻页复用原请求：同一次滚动被拆成两次请求的话 position 会从 0 重来。
    expect(second.body.requestId).toBe(first.body.requestId)
    expect(second.body.items.map((item) => rawListingId(item.id))).toEqual(
      snapshot.slice(2, 4).map((row) => row.listingId),
    )

    const served = [...first.body.items, ...second.body.items].map((item) => item.id)
    expect(new Set(served).size).toBe(served.length)
  })

  test('快照里中途下架的商品：第二页跳过它、不补位，offset 仍按快照行数前进', async () => {
    const seller = await registerUser('62')
    for (let index = 0; index < 5; index += 1) {
      await createListing(seller.id, `可见性验收商品 ${index}`)
    }

    const sessionId = newId()
    const first = await fetchFeed('?limit=2', { [SESSION_HEADER]: sessionId })
    const cursor = first.body.nextCursor
    if (cursor === null) throw new Error('需要下一页游标才能测可见性变化')

    const snapshot = await snapshotOf(first.body.requestId)
    const delisted = snapshot[2]
    const kept = snapshot[3]
    if (!delisted || !kept) throw new Error('快照不足 4 行')

    // 第二页要发的第 1 条在翻页前被下架：它必须被跳过，而不是拿第 5 条来补位
    // （补位会让"客户端第 N 位 = 快照 position N"当场失效）。
    await db.update(listings).set({ status: 'OFFLINE' }).where(eq(listings.id, delisted.listingId))

    const second = await fetchFeed(`?limit=2&cursor=${cursor}`, { [SESSION_HEADER]: sessionId })
    expect(second.status).toBe(200)
    expect(second.body.items.map((item) => rawListingId(item.id))).toEqual([kept.listingId])
  })

  test('客户端上报的 position/source 一律作废：落库等于快照真值', async () => {
    const seller = await registerUser('63')
    await createListing(seller.id, '伪造归因验收商品')

    const sessionId = newId()
    const { body } = await fetchFeed('?limit=2', { [SESSION_HEADER]: sessionId })
    const card = body.items[0]
    if (!card) throw new Error('Feed 未返回商品')

    const [truth] = await db
      .select()
      .from(recommendationRequestItems)
      .where(
        and(
          eq(recommendationRequestItems.requestId, body.requestId),
          eq(recommendationRequestItems.listingId, rawListingId(card.id)),
        ),
      )
    if (!truth) throw new Error('快照缺这一行')

    const response = await app.request(
      '/recommendations/events',
      post(
        {
          events: [
            {
              eventId: crypto.randomUUID(),
              requestId: body.requestId,
              listingId: card.id,
              eventType: 'IMPRESSION',
              // 客户端声称"我在第 999 位、来自 semantic"——排序模式下这两个字段只认服务端快照。
              position: 999,
              source: 'semantic',
              anonymousSessionId: sessionId,
              metadata: { visibleRatio: 0.9, durationMs: 1200 },
            },
          ],
        },
        { [SESSION_HEADER]: sessionId },
      ),
    )
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })

    const [stored] = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, body.requestId))
    expect(stored?.position).toBe(truth.position)
    expect(stored?.source).toBe(truth.primarySource)
  })

  test('排序模式未命中快照：普通事件落库为无归因（null），曝光类直接拒收', async () => {
    const seller = await registerUser('64')
    const sessionId = newId()
    const { body } = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    expect(body.strategyVersion).toBe(RANKED_STRATEGY_VERSION)

    // Feed 之后才建的商品：服务端无法证明它被推荐过。
    const outside = await createListing(seller.id, '不在快照里的商品')

    const response = await app.request(
      '/recommendations/events',
      post(
        {
          events: [
            {
              eventId: crypto.randomUUID(),
              requestId: body.requestId,
              listingId: outside,
              eventType: 'DETAIL_VIEW',
              position: 0,
              source: 'fresh',
              anonymousSessionId: sessionId,
            },
            {
              eventId: crypto.randomUUID(),
              requestId: body.requestId,
              listingId: outside,
              eventType: 'IMPRESSION',
              position: 0,
              source: 'fresh',
              anonymousSessionId: sessionId,
              metadata: { visibleRatio: 0.9, durationMs: 1200 },
            },
          ],
        },
        { [SESSION_HEADER]: sessionId },
      ),
    )
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 1 })

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, body.requestId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.eventType).toBe('DETAIL_VIEW')
    // "没被推荐过"就等于没有归因：写 0/fresh 会造出看起来合法的假归因。
    expect(rows[0]?.position).toBeNull()
    expect(rows[0]?.source).toBeNull()
  })

  test('降级透传（rec-v1-none）仍按 R1 口径补 position/source=fresh，且透传游标可继续翻页', async () => {
    const seller = await registerUser('65')
    const listingId = await createListing(seller.id, '透传归因验收商品')
    const sessionId = newId()

    const cursors: unknown[] = []
    const service = createDegradedService('inner-listing-cursor', (cursor) => {
      cursors.push(cursor)
    })

    const page = await service.startFeed({
      viewerId: null,
      anonymousSessionId: sessionId,
      limit: 1,
    })
    expect(page.response.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)
    expect(page.response.nextCursor).not.toBeNull()

    const result = await service.ingest({
      viewerId: null,
      events: [
        {
          eventId: newId(),
          requestId: page.response.requestId,
          listingId: listingId as RecommendationEventInput['listingId'],
          eventType: 'DETAIL_VIEW',
          position: 3,
          anonymousSessionId: sessionId,
          occurredAt: new Date().toISOString(),
        },
      ],
    })
    expect(result).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })

    const [row] = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, page.response.requestId))
    // 透传模式下客户端上报的 position 是唯一可用信息，source 缺省补 fresh（R1 口径）。
    expect(row?.position).toBe(3)
    expect(row?.source).toBe('fresh')

    // 外层推荐游标里包着内层商品游标：翻页要把它原样交回 listings 层，否则第二页会从头开始。
    const next = await service.startFeed({
      viewerId: null,
      anonymousSessionId: sessionId,
      limit: 1,
      cursor: page.response.nextCursor ?? undefined,
    })
    expect(next.response.requestId).toBe(page.response.requestId)
    expect(String(cursors[1])).toBe('inner-listing-cursor')
  })

  test('游标形状必须与请求行的策略匹配：passthrough / snapshot 互不通用，都按坏游标 422', async () => {
    const seller = await registerUser('66')
    for (let index = 0; index < 3; index += 1) {
      await createListing(seller.id, `游标形状验收商品 ${index}`)
    }

    const sessionId = newId()
    const ranked = await fetchFeed('?limit=1', { [SESSION_HEADER]: sessionId })
    expect(ranked.status).toBe(200)
    expect(ranked.body.strategyVersion).toBe(RANKED_STRATEGY_VERSION)

    // 自造 `{listingCursor, requestId}`（R1 的旧形状 = passthrough）指向一条**排序**请求：放行的话
    // 这一页会按 newest 发卡，而这些卡片没有快照行，它们随后的曝光会被归因层按
    // `attribution_not_found` 拒收 —— 客户端自造一个游标就能把自己后续的曝光数据丢掉。
    // 内层游标必须是**合法**的（`GET /listings` 自己发的），否则这条断言会因为"内层游标解不出来"
    // 而 422，证明不了形状守卫。
    const newest = await app.request('/listings?sort=newest&limit=1')
    const newestPage = (await newest.json()) as { nextCursor: string | null }
    expect(typeof newestPage.nextCursor).toBe('string')

    const forgedPassthrough = await fetchFeed(
      `?cursor=${encodeRecommendationCursor({
        kind: 'passthrough',
        requestId: ranked.body.requestId,
        listingCursor: newestPage.nextCursor ?? '',
      })}`,
      { [SESSION_HEADER]: sessionId },
    )
    expect(forgedPassthrough.status).toBe(422)

    // 反向：降级请求（rec-v1-none）没有快照，snapshot 游标只会翻出空页 —— 同样按坏游标拒。
    const service = createDegradedService('inner-listing-cursor')
    const degraded = await service.startFeed({
      viewerId: null,
      anonymousSessionId: sessionId,
      limit: 1,
    })
    expect(degraded.response.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)

    await expect(
      service.startFeed({
        viewerId: null,
        anonymousSessionId: sessionId,
        limit: 1,
        cursor: encodeRecommendationCursor({
          kind: 'snapshot',
          requestId: degraded.response.requestId,
          offset: 0,
        }),
      }),
    ).rejects.toThrow('cursor 无效')
  })

  test('降级透传路径接住 listings 层的坏内层游标：422 而不是冒成 500', async () => {
    const sessionId = newId()
    // 桩复现 listings 层的游标契约：只认自己发出去的那个内层游标，其它一律
    // `ListingServiceError(VALIDATION_FAILED)` —— 真实现（`listings/service.ts` 的
    // decodeFeedCursor）就是这么拒坏游标的。这里断言的是推荐层有没有把它转成 422。
    const service = createRecommendationService({
      store: createSqlRecommendationStore(db),
      listings: {
        listFeed: async (_viewerId, criteria) => {
          if (criteria.cursor !== undefined && criteria.cursor !== 'inner-listing-cursor') {
            throw new ListingServiceError(422, 'VALIDATION_FAILED', 'listing cursor 无效')
          }
          return { items: [], nextCursor: 'inner-listing-cursor' }
        },
        listCardsByIds: async () => new Map(),
      },
      recall: {
        recall: async () => {
          throw new Error('模拟召回管线崩溃')
        },
      },
      interest: { enqueue: async () => {} },
    })

    const page = await service.startFeed({
      viewerId: null,
      anonymousSessionId: sessionId,
      limit: 1,
    })
    expect(page.response.strategyVersion).toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)
    expect(page.response.nextCursor).not.toBeNull()

    await expect(
      service.startFeed({
        viewerId: null,
        anonymousSessionId: sessionId,
        limit: 1,
        cursor: encodeRecommendationCursor({
          kind: 'passthrough',
          requestId: page.response.requestId,
          listingCursor: 'not-a-listing-cursor',
        }),
      }),
    ).rejects.toThrow('cursor 无效')
  })
})

/**
 * 服务端确证行为的埋点（#323 §M0：COMMENT / CHAT_START / TRANSACTION_START / PURCHASE）。
 *
 * 这些事件刻意**不走客户端上报**：评论成功、交易建行、成交这些事实只有服务端知道，
 * 客户端断网重试会丢或重复。这里验证的是"行为真的发生 → 事件真的落库"，以及
 * 归因缺失（没带推荐上下文头）时事件仍然落库（归因可以丢，行为不能丢）。
 */
describe('recommendation domain events (#323 R1)', () => {
  test('评论成功 → 服务端补一条 COMMENT 事件（无归因也落库）', async () => {
    const seller = await registerUser('11')
    const buyer = await registerUser('12')
    const listingId = await createListing(seller.id, '评论验收商品')

    const response = await app.request(
      `/listings/${listingId}/comments`,
      post({ content: '还在吗？' }, { cookie: buyer.cookie }),
    )
    expect(response.status).toBe(201)

    const rows = await eventsFor(listingId, 'COMMENT')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(buyer.id)
    // 请求没带推荐上下文头 → 归因为空，但事件必须落库。
    expect(rows[0]?.requestId).toBeNull()
    expect(rows[0]?.position).toBeNull()
  })

  test('回复留言 → 同样补一条 COMMENT 事件（回复是独立的 insert 路径）', async () => {
    const seller = await registerUser('31')
    const buyer = await registerUser('32')
    const listingId = await createListing(seller.id, '回复验收商品')

    const top = await app.request(
      `/listings/${listingId}/comments`,
      post({ content: '还在吗？' }, { cookie: buyer.cookie }),
    )
    expect(top.status).toBe(201)
    const comment = (await top.json()) as { id: string }

    const reply = await app.request(
      `/comments/${comment.id}/replies`,
      post({ content: '在的，明天面交' }, { cookie: seller.cookie }),
    )
    expect(reply.status).toBe(201)

    // 两条：顶层留言 + 回复。回复走 `createReply` 自己的 insert，不经过 `createComment`，
    // 而 ingest 又拒收客户端上报的 COMMENT —— 漏掉这条路等于把回复类强正反馈整条丢掉。
    const rows = await eventsFor(listingId, 'COMMENT')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.userId).sort()).toEqual([buyer.id, seller.id].sort())
  })

  test('新建会话 → CHAT_START；复用同一会话不重复记', async () => {
    const seller = await registerUser('13')
    const buyer = await registerUser('14')
    const listingId = await createListing(seller.id, '会话验收商品')

    const first = await app.request('/conversations', post({ listingId }, { cookie: buyer.cookie }))
    expect(first.status).toBe(201)
    // 复用同一个会话：不是新的行为信号，不该再记一条。
    const second = await app.request(
      '/conversations',
      post({ listingId }, { cookie: buyer.cookie }),
    )
    expect(second.status).toBe(200)

    const rows = await eventsFor(listingId, 'CHAT_START')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(buyer.id)
  })

  test('交易建行 → TRANSACTION_START；双方确认成交 → PURCHASE', async () => {
    const seller = await registerUser('15')
    const buyer = await registerUser('16')
    const listingId = await createListing(seller.id, '交易验收商品')

    const created = await app.request(
      '/conversations',
      post({ listingId }, { cookie: buyer.cookie }),
    )
    expect(created.status).toBe(201)
    const conversation = (await created.json()) as { id: string }

    // 卖家接受 = 唯一创建交易行的端点。
    const accepted = await app.request(
      '/transactions',
      post({ conversationId: conversation.id, amountCents: 100 }, { cookie: seller.cookie }),
    )
    expect(accepted.status).toBe(201)
    const transaction = (await accepted.json()) as { id: string; status: string }

    const started = await eventsFor(listingId, 'TRANSACTION_START')
    expect(started).toHaveLength(1)
    expect(started[0]?.userId).toBe(seller.id)

    // 双侧各确认一次；第二侧确认后交易才 COMPLETED。
    const buyerConfirm = await app.request(
      `/transactions/${transaction.id}/confirm`,
      post({}, { cookie: buyer.cookie }),
    )
    expect(buyerConfirm.status).toBe(200)
    // 只有一侧确认：还没成交，不该有 PURCHASE。
    expect(await eventsFor(listingId, 'PURCHASE')).toHaveLength(0)

    const sellerConfirm = await app.request(
      `/transactions/${transaction.id}/confirm`,
      post({}, { cookie: seller.cookie }),
    )
    expect(sellerConfirm.status).toBe(200)
    expect(((await sellerConfirm.json()) as { status: string }).status).toBe('COMPLETED')

    const purchased = await eventsFor(listingId, 'PURCHASE')
    expect(purchased).toHaveLength(1)
    expect(purchased[0]?.userId).toBe(seller.id)
  })

  /**
   * `PURCHASE` 的精确一次护栏。
   *
   * 确认成交在 store 层是幂等的（已 COMPLETED 的交易再确认仍返回 ok），而 `recordDomainEvent`
   * 每次都新生成 `eventId`，`event_id` 唯一索引对这类重复无效：不拦的话卖家重复点确认或重放
   * `POST /transactions/:id/confirm` 就能把最强的正样本无界放大。服务端按「一个商品只会成交
   * 一次」（成交即转 SOLD）在写入前查一次，所以这里必须恰好一条。
   */
  test('重复确认成交不会重复记 PURCHASE（商品级唯一事实）', async () => {
    const seller = await registerUser('17')
    const buyer = await registerUser('18')
    const listingId = await createListing(seller.id, '重复确认验收商品')

    const created = await app.request(
      '/conversations',
      post({ listingId }, { cookie: buyer.cookie }),
    )
    const conversation = (await created.json()) as { id: string }
    const accepted = await app.request(
      '/transactions',
      post({ conversationId: conversation.id, amountCents: 100 }, { cookie: seller.cookie }),
    )
    const transaction = (await accepted.json()) as { id: string }

    // 买家确认：只推进时间戳，交易仍等卖家（还没成交 → 不该有 PURCHASE）。
    const buyerConfirm = await app.request(
      `/transactions/${transaction.id}/confirm`,
      post({}, { cookie: buyer.cookie }),
    )
    expect(buyerConfirm.status).toBe(200)
    expect(((await buyerConfirm.json()) as { status: string }).status).toBe('PENDING_MEETUP')
    expect(await eventsFor(listingId, 'PURCHASE')).toHaveLength(0)

    // 卖家确认：双侧齐 → COMPLETED + 一条 PURCHASE。
    const sellerConfirm = await app.request(
      `/transactions/${transaction.id}/confirm`,
      post({}, { cookie: seller.cookie }),
    )
    expect(sellerConfirm.status).toBe(200)
    expect(((await sellerConfirm.json()) as { status: string }).status).toBe('COMPLETED')
    expect(await eventsFor(listingId, 'PURCHASE')).toHaveLength(1)

    // 已完成后重复确认：store 幂等返回 COMPLETED，但事件不重复。
    const replay = await app.request(
      `/transactions/${transaction.id}/confirm`,
      post({}, { cookie: seller.cookie }),
    )
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { status: string }).status).toBe('COMPLETED')
    expect(await eventsFor(listingId, 'PURCHASE')).toHaveLength(1)
  })

  test('归因头里的 position 溢出 int4 时退化为无归因，但事件必须落库', async () => {
    const seller = await registerUser('19')
    const buyer = await registerUser('20')
    const listingId = await createListing(seller.id, '位次溢出验收商品')

    // 上界之外的值如果照收，INSERT 会报 `integer out of range`，而写失败被 recordDomainEvent
    // 的 try/catch 吞掉 —— 整条 COMMENT 都没了，不只是丢归因。
    const response = await app.request(
      `/listings/${listingId}/comments`,
      post(
        { content: '位次溢出了' },
        {
          cookie: buyer.cookie,
          'x-recommendation-position': '99999999999',
          'x-recommendation-request-id': newId(),
        },
      ),
    )
    expect(response.status).toBe(201)

    const rows = await eventsFor(listingId, 'COMMENT')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.position).toBeNull()

    // 非规范整数字串也不能被 `Number.parseInt` 悄悄截断：`5.9` → 5、`1e3` → 1 都是凭空
    // 多出来的错误位次，归因宁可没有。
    const decimal = await app.request(
      `/listings/${listingId}/comments`,
      post(
        { content: '位次不是整数字串' },
        {
          cookie: buyer.cookie,
          'x-recommendation-position': '5.9',
          'x-recommendation-request-id': newId(),
        },
      ),
    )
    expect(decimal.status).toBe(201)

    const withDecimal = await eventsFor(listingId, 'COMMENT')
    expect(withDecimal).toHaveLength(2)
    expect(withDecimal.every((row) => row.position === null)).toBe(true)
  })

  test('收藏 / 取消收藏 → 服务端补 FAVORITE / UNFAVORITE 事件', async () => {
    // 学号必须全文件唯一：`registerUser` 走真实注册接口，重号会拿到 409 而不是 200。
    const seller = await registerUser('26')
    const buyer = await registerUser('27')
    const listingId = await createListing(seller.id, '收藏埋点验收商品')

    // 这两个事件是负反馈特征（R4）唯一可靠的真值来源：`POST /recommendations/events` 只认客户端
    // 上报，断网重试会整批丢；而收藏是用户主动动作，丢了就等于画像里最强的正信号消失。
    const added = await app.request(`/listings/${listingId}/favorite`, {
      method: 'POST',
      headers: { cookie: buyer.cookie },
    })
    expect(added.status).toBe(200)

    const removed = await app.request(`/listings/${listingId}/favorite`, {
      method: 'DELETE',
      headers: { cookie: buyer.cookie },
    })
    expect(removed.status).toBe(200)

    const rows = await eventsFor(listingId, 'FAVORITE')
    const unfavorites = await eventsFor(listingId, 'UNFAVORITE')
    expect(rows).toHaveLength(1)
    expect(unfavorites).toHaveLength(1)
    // 收藏是登录用户的动作：userId 必须落库（长期画像重算靠它），没有推荐上下文时归因保持 null
    // 而不是补一个看起来合法的 0/fresh。
    expect(rows[0]?.userId).toBe(buyer.id)
    expect(rows[0]?.position).toBeNull()
    expect(rows[0]?.source).toBeNull()
    expect(unfavorites[0]?.userId).toBe(buyer.id)
  })

  test('降级请求（rec-v1-none）的服务端确证事件按上下文头落 position/source', async () => {
    const seller = await registerUser('28')
    const buyer = await registerUser('29')
    const listingId = await createListing(seller.id, '降级归因验收商品')

    // 降级路径（召回抛错 / 空库）写下的请求行版本就是 `rec-v1-none`：没有快照可查，position/source
    // 只能来自上下文头，这是 R1 口径，R4 只改了排序模式。这一行直接建：app 装配下真召回有 fresh
    // 通道兜底、降级不可达，而行的形状与 `service.startFeed` 降级分支写出来的完全一致。
    const requestId = newId()
    await db.insert(recommendationRequests).values({
      id: requestId,
      userId: buyer.id,
      anonymousSessionId: newId(),
      strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
    })

    const response = await app.request(`/listings/${listingId}/favorite`, {
      method: 'POST',
      headers: {
        cookie: buyer.cookie,
        'x-recommendation-request-id': requestId,
        'x-recommendation-position': '3',
        'x-recommendation-source': 'semantic',
      },
    })
    expect(response.status).toBe(200)

    const [row] = await eventsFor(listingId, 'FAVORITE')
    expect(row?.requestId).toBe(requestId)
    expect(row?.position).toBe(3)
    expect(row?.source).toBe('semantic')
  })

  test('排序请求（rank-v1）的服务端确证事件取快照真值，忽略上下文头', async () => {
    const seller = await registerUser('67')
    const buyer = await registerUser('68')
    const listingId = await createListing(seller.id, '排序归因验收商品')

    // 排序模式的两行都由 `service.createRankedFeed` 写下。这里直接建出同形的两行：走真实 Feed 拿到
    // 的 position 取决于召回与排序结果，而本用例要钉的是 `recordDomainEvent` 的归因分支——
    // 快照命中即取快照的 position/primarySource，客户端上报的上下文头一律丢弃（#323 §8 真值表）。
    const requestId = newId()
    await db.insert(recommendationRequests).values({
      id: requestId,
      userId: buyer.id,
      anonymousSessionId: newId(),
      strategyVersion: RANKED_STRATEGY_VERSION,
    })
    await db.insert(recommendationRequestItems).values({
      requestId,
      position: 5,
      listingId: decodePublicId(PUBLIC_ID_PREFIX.listing, listingId),
      primarySource: 'popular',
      sources: ['popular', 'semantic'],
      rankScore: 0.5,
      rankBreakdown: {},
    })

    const response = await app.request(`/listings/${listingId}/favorite`, {
      method: 'POST',
      headers: {
        cookie: buyer.cookie,
        'x-recommendation-request-id': requestId,
        // 客户端上报的是伪造值：999 位、fresh 通道。真值只有服务端快照知道。
        'x-recommendation-position': '999',
        'x-recommendation-source': 'fresh',
      },
    })
    expect(response.status).toBe(200)

    const [row] = await eventsFor(listingId, 'FAVORITE')
    expect(row?.requestId).toBe(requestId)
    expect(row?.position).toBe(5)
    expect(row?.source).toBe('popular')
  })
})

describe('recommendation ingest 契约 (#323 R1)', () => {
  test('大写 UUID 的会话标识与小写等价：翻页 200 且事件不被判 identity_mismatch', async () => {
    const seller = await registerUser('21')
    const listingId = await createListing(seller.id, '大写会话验收商品')
    const uppercaseSession = 'D49C7312-6A1D-4977-962C-6B7CC5F6F68C'

    const first = await fetchFeed('?limit=1', { [SESSION_HEADER]: uppercaseSession })
    expect(first.status).toBe(200)
    expect(first.body.nextCursor).not.toBeNull()
    // 客户端已经带了会话标识 → 服务端不补发（补发只发生在客户端没带时）。
    expect(first.sessionId).toBeNull()

    // PG 的 uuid 列回读是小写：不规范化就会在这里 422。
    const second = await fetchFeed(
      `?limit=1&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
      { [SESSION_HEADER]: uppercaseSession },
    )
    expect(second.status).toBe(200)
    expect(second.body.requestId).toBe(first.body.requestId)

    const ingest = await app.request(
      '/recommendations/events',
      post({
        events: [
          {
            eventId: newId(),
            requestId: first.body.requestId.toUpperCase(),
            listingId: first.body.items[0]?.id ?? listingId,
            eventType: 'IMPRESSION',
            position: 0,
            anonymousSessionId: uppercaseSession,
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    )
    expect(ingest.status).toBe(202)
    expect((await ingest.json()) as unknown).toMatchObject({
      accepted: 1,
      duplicates: 0,
      rejected: 0,
    })
  })

  test('切号不串事件：登出后带旧 requestId 的事件被拒（identity_mismatch）', async () => {
    const seller = await registerUser('22')
    const buyer = await registerUser('23')
    const listingId = await createListing(seller.id, '切号验收商品')

    // 登录用户发起的推荐请求：请求行的身份真值是 userId。
    const feed = await fetchFeed('?limit=1', { cookie: buyer.cookie })
    expect(feed.status).toBe(200)
    expect(feed.body.requestId).toBeTruthy()

    // 登出（无 cookie）后再发这个 requestId 的事件：匿名视角不是这条请求的主人。
    const anonymous = await app.request(
      '/recommendations/events',
      post({
        events: [
          {
            eventId: newId(),
            requestId: feed.body.requestId,
            listingId,
            eventType: 'DETAIL_VIEW',
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    )
    expect(anonymous.status).toBe(202)
    expect((await anonymous.json()) as unknown).toMatchObject({ accepted: 0, rejected: 1 })

    // 另一个账号拿着别人的 requestId 也一样被拒。
    const other = await registerUser('24')
    const foreign = await app.request(
      '/recommendations/events',
      post(
        {
          events: [
            {
              eventId: newId(),
              requestId: feed.body.requestId,
              listingId,
              eventType: 'DETAIL_VIEW',
              occurredAt: new Date().toISOString(),
            },
          ],
        },
        { cookie: other.cookie },
      ),
    )
    expect(foreign.status).toBe(202)
    expect((await foreign.json()) as unknown).toMatchObject({ accepted: 0, rejected: 1 })
    expect(await eventsFor(listingId, 'DETAIL_VIEW')).toHaveLength(0)
  })

  test('occurredAt 超前或过旧的事件被拒；批内重复 eventId 计入 duplicates', async () => {
    const seller = await registerUser('25')
    const listingId = await createListing(seller.id, '时间窗验收商品')
    const eventId = newId()
    const base = {
      requestId: null,
      listingId,
      eventType: 'IMAGE_VIEW' as RecommendationEventType,
      metadata: { imageIndex: 0 },
    }

    const response = await app.request(
      '/recommendations/events',
      post({
        events: [
          // 超前 11 分钟（容忍上限 10 分钟）
          {
            ...base,
            eventId: newId(),
            occurredAt: new Date(Date.now() + 11 * 60 * 1_000).toISOString(),
          },
          // 早于 180 天保留期
          {
            ...base,
            eventId: newId(),
            occurredAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1_000).toISOString(),
          },
          // 批内两条同 eventId：第一条落库，第二条计入 duplicates。
          { ...base, eventId, occurredAt: new Date().toISOString() },
          { ...base, eventId, occurredAt: new Date().toISOString() },
        ],
      }),
    )
    expect(response.status).toBe(202)
    expect((await response.json()) as unknown).toMatchObject({
      accepted: 1,
      duplicates: 1,
      rejected: 2,
    })
    expect(await eventsFor(listingId, 'IMAGE_VIEW')).toHaveLength(1)
  })

  test('同一请求同一商品的曝光换 eventId 重复上报 → 只落一行，其余计入 duplicates', async () => {
    const seller = await registerUser('33')
    await createListing(seller.id, '曝光去重验收商品')

    const feed = await fetchFeed('?limit=1')
    expect(feed.status).toBe(200)
    const listingId = feed.body.items[0]?.id as string
    const sessionId = feed.sessionId as string

    const impression = (position: number) => ({
      eventId: newId(),
      requestId: feed.body.requestId,
      listingId,
      eventType: 'IMPRESSION' as RecommendationEventType,
      position,
      anonymousSessionId: sessionId,
      metadata: { visibleRatio: 1, durationMs: 1_500 },
      occurredAt: new Date().toISOString(),
    })

    const response = await app.request(
      '/recommendations/events',
      post(
        { events: [impression(0), impression(0), impression(1)] },
        {
          [SESSION_HEADER]: sessionId,
        },
      ),
    )
    expect(response.status).toBe(202)
    // 「同一请求内同一张卡只曝光一次」不能只是客户端承诺：端点匿名可写、eventId 由客户端
    // 自生成，换一个 UUID 就能刷出任意多行。库级部分唯一索引 (request_id, listing_id,
    // event_type) WHERE event_type IN ('IMPRESSION','QUICK_SKIP') 把它变成硬约束。
    expect((await response.json()) as unknown).toMatchObject({
      accepted: 1,
      duplicates: 2,
      rejected: 0,
    })
    /*
     * 断言必须把 requestId 一起收进过滤条件：R4 之后 `feed.body.items[0]` 是"当前得分最高"的卡片，
     * 不再是"刚建的那件商品"，别的用例早就在同一件商品上写过 IMPRESSION。只按 listingId 数行数会
     * 数到别人的行上（这条用例一开始就是这么红的），而它真正要守的是 (request_id, listing_id,
     * event_type) 这条部分唯一索引。
     */
    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.requestId, feed.body.requestId),
          eq(recommendationEvents.listingId, decodePublicId(PUBLIC_ID_PREFIX.listing, listingId)),
          eq(recommendationEvents.eventType, 'IMPRESSION'),
        ),
      )
    expect(rows).toHaveLength(1)
  })
})

describe('recommendation interest refresh enqueue (#323 R2)', () => {
  /**
   * 直接看原始 jsonb 而不是 drizzle 的 `.select()`：`jsonb_typeof` 能区分"对象"与"被双序列化
   * 成的字符串标量"。后者会让消费方的 `payload->>'userId'` 恒为 NULL，而部分唯一索引同时失效
   * ——两件事都会静默发生，只有回库看才知道。
   */
  async function interestJobs(userId: string): Promise<{ status: string; kind: string }[]> {
    const rows = await db.execute(sql`
      select status, jsonb_typeof(payload) as kind
      from jobs
      where type = 'REFRESH_USER_INTEREST'
        and payload->>'userId' = ${userId}
      order by created_at, id
    `)
    return [...rows] as { status: string; kind: string }[]
  }

  /** 以该身份取一次 Feed，并回传归属于他的 requestId（归因身份以请求行为真值）。 */
  async function feedFor(headers: Record<string, string>): Promise<FeedBody> {
    const response = await app.request('/recommendations/feed?limit=1', { headers })
    expect(response.status).toBe(200)
    return (await response.json()) as FeedBody
  }

  /**
   * 该 job 类型在当前 scratch 库里的总行数（不按 userId 收口）。
   *
   * 用于断言"这次请求没有新增任何长期画像 job"：只看 `payload->>'userId' is null` 是不够的，
   * `{"userId": null}` 与"payload 被双序列化成字符串标量"都会让 `->>'userId'` 返回 SQL NULL，
   * 恰好放过它要防的那个 bug。
   */
  async function countInterestJobs(): Promise<number> {
    const rows = await db.execute(sql`
      select count(*)::int as n from jobs where type = 'REFRESH_USER_INTEREST'
    `)
    return Number(rows[0]?.n ?? 0)
  }

  const detailView = (
    feed: FeedBody,
    listingId: string,
    extra: Record<string, unknown> = {},
  ): { events: unknown[] } => ({
    events: [
      {
        eventId: newId(),
        requestId: feed.requestId,
        listingId,
        eventType: 'DETAIL_VIEW' as RecommendationEventType,
        position: 0,
        occurredAt: new Date().toISOString(),
        ...extra,
      },
    ],
  })

  test('登录用户的行为落库 → 投递一条长期画像重算 job', async () => {
    const buyer = await registerUser('41')
    const seller = await registerUser('42')
    await createListing(seller.id, '画像投递验收商品')

    const feed = await feedFor({ cookie: buyer.cookie })
    const listingId = feed.items[0]?.id as string

    const response = await app.request(
      '/recommendations/events',
      post(detailView(feed, listingId), { cookie: buyer.cookie }),
    )
    expect(response.status).toBe(202)
    expect((await response.json()) as unknown).toMatchObject({ accepted: 1, rejected: 0 })

    // 落库的是 PENDING job、payload 是 jsonb 对象、userId 就是行为归属的那个账号。
    expect(await interestJobs(buyer.id)).toEqual([{ status: 'PENDING', kind: 'object' }])
  })

  test('同一用户连续两次行为只留一条待跑 job（幂等键 = 用户 + PENDING）', async () => {
    const buyer = await registerUser('43')
    const seller = await registerUser('44')
    await createListing(seller.id, '画像投递去重验收商品')

    for (let round = 0; round < 2; round += 1) {
      const feed = await feedFor({ cookie: buyer.cookie })
      const listingId = feed.items[0]?.id as string
      const response = await app.request(
        '/recommendations/events',
        post(detailView(feed, listingId), { cookie: buyer.cookie }),
      )
      expect(response.status).toBe(202)
      expect((await response.json()) as unknown).toMatchObject({ accepted: 1 })
    }

    expect(await interestJobs(buyer.id)).toEqual([{ status: 'PENDING', kind: 'object' }])
  })

  test('匿名会话的行为不投递长期画像 job（长期画像只给登录用户）', async () => {
    const sessionId = newId()
    const seller = await registerUser('45')
    await createListing(seller.id, '匿名画像不投递验收商品')

    const feed = await feedFor({ [SESSION_HEADER]: sessionId })
    const listingId = feed.items[0]?.id as string
    const jobsBefore = await countInterestJobs()

    const response = await app.request(
      '/recommendations/events',
      post(detailView(feed, listingId, { anonymousSessionId: sessionId }), {
        [SESSION_HEADER]: sessionId,
      }),
    )
    expect(response.status).toBe(202)
    expect((await response.json()) as unknown).toMatchObject({ accepted: 1, rejected: 0 })

    // 事件本身必须落库（匿名行为照样是 session 画像的输入），只是不投 job。
    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, feed.requestId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBeNull()

    // 总行数一行都不能多（比"没有 userId 为 null 的行"更强：那种写法对
    // `{"userId": null}` 与"payload 被双序列化成字符串标量"同样假绿）。
    expect(await countInterestJobs()).toBe(jobsBefore)

    // 库里已有的长期画像 job 必须都是"jsonb 对象 + 非空 userId"，否则上面那条总行数断言
    // 就是在一个坏掉的写入路径上做计数。
    const malformed = await db.execute(sql`
      select count(*)::int as n from jobs
      where type = 'REFRESH_USER_INTEREST'
        and (jsonb_typeof(payload) <> 'object' or payload->>'userId' is null)
    `)
    expect(Number(malformed[0]?.n ?? 0)).toBe(0)
  })

  test('服务端确证的强正反馈（新建会话 CHAT_START）也触发重算投递', async () => {
    const seller = await registerUser('46')
    const buyer = await registerUser('47')
    const listingId = await createListing(seller.id, '强反馈投递验收商品')

    const created = await app.request(
      '/conversations',
      post({ listingId }, { cookie: buyer.cookie }),
    )
    expect(created.status).toBe(201)

    // 这条事件不是走 ingest，而是服务端确证写路径（recordDomainEvent）——
    // 强正反馈比一次浏览更值得立刻重算，两条路径都必须投递。
    expect(await interestJobs(buyer.id)).toEqual([{ status: 'PENDING', kind: 'object' }])
  })

  test('幂等键已被占用时 events 依然 202，事件照常落库（ON CONFLICT DO NOTHING）', async () => {
    const buyer = await registerUser('48')
    const seller = await registerUser('49')
    await createListing(seller.id, '投递幂等冲突验收商品')

    const feed = await feedFor({ cookie: buyer.cookie })
    const listingId = feed.items[0]?.id as string

    // 先手工占掉幂等键：真实投递会被 ON CONFLICT DO NOTHING 吃掉，但请求必须照常成功。
    await db.execute(sql`
      INSERT INTO jobs (id, type, status, payload)
      VALUES (${newId()}, 'REFRESH_USER_INTEREST', 'PENDING', ${JSON.stringify({ userId: buyer.id })}::text::jsonb)
    `)

    const response = await app.request(
      '/recommendations/events',
      post(detailView(feed, listingId), { cookie: buyer.cookie }),
    )
    expect(response.status).toBe(202)
    expect((await response.json()) as unknown).toMatchObject({ accepted: 1, rejected: 0 })

    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, feed.requestId))
    expect(rows).toHaveLength(1)
    expect(await interestJobs(buyer.id)).toEqual([{ status: 'PENDING', kind: 'object' }])
  })

  test('投递口真的抛错时 ingest 不失败：事件照常落库，只记一条日志', async () => {
    const buyer = await registerUser('52')
    const seller = await registerUser('53')
    await createListing(seller.id, '投递异常降级验收商品')

    const feed = await feedFor({ cookie: buyer.cookie })
    // 从 JSON 回读的公开 id 只是 `string`，而 `RecommendationEventInput.listingId` 是品牌类型
    // （`lst_${string}`）：这里显式收口，与路由层用同一个契约类型对齐。
    const listingId = feed.items[0]?.id as RecommendationEventInput['listingId']

    /*
     * 直接装配服务，只把投递口换成"一定抛错"的实现：app 的装配没有注入点，而这条降级路径的
     * 真实性靠"其余依赖都是真的"来保证（真 store、真 scratch 库、真事件表）。
     * 上一个用例（幂等键冲突）测的是 `ON CONFLICT DO NOTHING`，不是这条 try/catch。
     */
    const service = createRecommendationService({
      store: createSqlRecommendationStore(db),
      listings: {
        listFeed: async () => {
          throw new Error('本用例只走 ingest，不调用 startFeed')
        },
        listCardsByIds: async () => new Map(),
      },
      // 本用例只走 ingest，召回/排序不会被调用；依赖照样要齐 —— 缺依赖就等于测的不是真实装配。
      recall: createRecommendationRecall({ db, embeddingModel: null }),
      interest: {
        enqueue: async () => {
          throw new Error('模拟 jobs 表不可用')
        },
      },
    })

    const events: RecommendationEventInput[] = [
      {
        eventId: newId(),
        requestId: feed.requestId,
        listingId,
        eventType: 'DETAIL_VIEW',
        position: 0,
        occurredAt: new Date().toISOString(),
      },
    ]

    // `mockRestore()` 会一并清掉调用记录，所以先把次数记下来再还原（还原放在 finally 里，
    // 断言失败也不会把 spy 泄漏给后面的用例）。
    let loggedCalls = 0
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const result = await service.ingest({ viewerId: buyer.id, events }).finally(() => {
      loggedCalls = errorSpy.mock.calls.length
      errorSpy.mockRestore()
    })

    expect(result).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 })
    // 投递失败必须留下可观测的痕迹（R6 靠它做告警），且每个用户只记一次。
    expect(loggedCalls).toBe(1)

    // 事件必须已经落库：埋点是旁路，投递不上不能让客户端收到 5xx、更不能丢事件。
    const rows = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.requestId, feed.requestId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(buyer.id)
  })
})
