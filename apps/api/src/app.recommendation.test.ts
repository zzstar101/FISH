import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { RecommendationEventType } from '@fish/contracts/recommendation/schema'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

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
    expect(body.strategyVersion).toBe('rec-v1-none')
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

  test('客户端不带 source：服务端按 R1 的单通道补 fresh（客户端不猜召回通道）', async () => {
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
    expect(rows[0]?.source).toBe('fresh')
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
    expect(second.body.strategyVersion).toBe('rec-v1-none')

    const forged = await fetchFeed('?cursor=not-a-cursor', { [SESSION_HEADER]: sessionId })
    expect(forged.status).toBe(422)

    // 外层合法、内层坏：必须也是 422（推荐层要接下 listings 层的 ListingServiceError，
    // 否则坏内层游标会一路冒到 app.onError 变成 500）。
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
    expect(await eventsFor(listingId, 'IMPRESSION')).toHaveLength(1)
  })
})
