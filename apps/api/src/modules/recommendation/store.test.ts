import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlRecommendationStore, type RecommendationRequestItemRecord } from './store'

// 与 app.recommendation.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_recommendation_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let store: ReturnType<typeof createSqlRecommendationStore>
let listingIds: string[]

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  store = createSqlRecommendationStore(db)

  const [seller] = await db
    .insert(users)
    .values({
      studentNo: `recommendation-store-${Date.now()}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '推荐快照测试',
    })
    .returning({ id: users.id })
  if (!seller) throw new Error('insert users 未返回行')

  listingIds = []
  for (let index = 0; index < 3; index += 1) {
    const id = newId()
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId: seller.id,
      title: `快照商品 ${index}`,
      description: '快照测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
    })
    listingIds.push(id)
  }
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

function listingIdAt(index: number): string {
  const id = listingIds[index]
  if (id === undefined) throw new Error(`缺少测试商品 #${index}`)
  return id
}

async function createRequest(strategyVersion = 'rank-v1'): Promise<string> {
  const id = newId()
  await store.createRequest({
    id,
    userId: null,
    anonymousSessionId: newId(),
    strategyVersion,
  })
  return id
}

function item(
  requestId: string,
  position: number,
  overrides: Partial<RecommendationRequestItemRecord> = {},
): RecommendationRequestItemRecord {
  return {
    requestId,
    position,
    listingId: listingIdAt(0),
    primarySource: 'fresh',
    sources: ['fresh'],
    rankScore: 0.5,
    rankBreakdown: { missing: [] },
    ...overrides,
  }
}

describe('recommendation store — 请求上下文 (#323 R4)', () => {
  test('createRequest 用调用方给的 id 落库，findRequests 一次批量取回', async () => {
    const first = await createRequest('rank-v1')
    const second = await createRequest('rec-v1-none')

    const rows = await store.findRequests([first, second])
    expect(rows.map((row) => row.id).sort()).toEqual([first, second].sort())
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(first)).toMatchObject({ userId: null, strategyVersion: 'rank-v1' })
    expect(byId.get(second)).toMatchObject({ strategyVersion: 'rec-v1-none' })
    // 匿名会话标识必须落库：跨会话复用同一个 requestId 的归属校验就靠它。
    expect(typeof byId.get(first)?.anonymousSessionId).toBe('string')

    // 空批量不能变成一次 `IN ()` 查询；查不到的 id 也不该编造行。
    expect(await store.findRequests([])).toEqual([])
    expect(await store.findRequests([newId()])).toEqual([])
  })
})

describe('recommendation store — 快照与归因真值 (#323 R4/R5)', () => {
  test('快照按 position 写入，findRequestItems 按 position 升序返回', async () => {
    const requestId = await createRequest()
    // 故意乱序写入：翻页按 offset 切片，顺序只能由读路径自己保证。
    await store.insertRequestItems([
      item(requestId, 2, {
        listingId: listingIdAt(2),
        primarySource: 'popular',
        sources: ['popular', 'explore'],
        rankScore: 0.7,
      }),
      item(requestId, 0, { listingId: listingIdAt(0), rankScore: 1.5 }),
      item(requestId, 1, {
        listingId: listingIdAt(1),
        primarySource: 'category',
        sources: ['category'],
        rankScore: -0.25,
      }),
    ])

    const rows = await store.findRequestItems(requestId)
    expect(rows.map((row) => row.position)).toEqual([0, 1, 2])
    expect(rows.map((row) => row.listingId)).toEqual([
      listingIdAt(0),
      listingIdAt(1),
      listingIdAt(2),
    ])
    expect(rows[1]).toEqual({
      requestId,
      position: 1,
      listingId: listingIdAt(1),
      primarySource: 'category',
      sources: ['category'],
      rankScore: -0.25,
    })
    // 归因只认 `primary_source`，召回来源另存 `sources`：两者必须都能原样回来。
    expect(rows[2]?.primarySource).toBe('popular')
    expect(rows[2]?.sources).toEqual(['popular', 'explore'])
    expect(rows[2]?.rankScore).toBe(0.7)

    // 空数组是 no-op，不是「发一条空 INSERT」。
    await store.insertRequestItems([])
    expect(await store.findRequestItems(requestId)).toHaveLength(3)

    // 别的请求的快照不串味。
    expect(await store.findRequestItems(newId())).toEqual([])
  })

  test('同一次请求重复写同一 position 直接报错，不静默吞掉', async () => {
    const requestId = await createRequest()
    await store.insertRequestItems([item(requestId, 0)])
    await expect(store.insertRequestItems([item(requestId, 1)])).resolves.toBeUndefined()

    // `(request_id, position)` 唯一索引再来一次 → 报错。静默吞掉会让「快照没写对」变成看不见
    // 的错误，所以这里不用 `onConflictDoNothing`；service 侧把它降级成 nextCursor=null。
    await expect(store.insertRequestItems([item(requestId, 1)])).rejects.toThrow()
    expect(await store.findRequestItems(requestId)).toHaveLength(2)
  })

  test('rank_breakdown 以 JSON 对象落库（jsonParam 防止 drizzle 双次 stringify）', async () => {
    const requestId = await createRequest()
    await store.insertRequestItems([
      item(requestId, 0, {
        rankBreakdown: {
          semantic: { normalized: 1, weight: 0.35, contribution: 0.35 },
          missing: ['wish'],
        },
      }),
    ])

    const rows = await db.execute<{ kind: string; contribution: string; missing: string }>(sql`
      SELECT jsonb_typeof(rank_breakdown) AS kind,
             rank_breakdown->'semantic'->>'contribution' AS contribution,
             rank_breakdown->>'missing' AS missing
      FROM recommendation_request_items
      WHERE request_id = ${requestId}
    `)
    // 裸对象在 drizzle + bun-sql 下会被 stringify 两次，列会变成 jsonb **字符串** ——
    // 那时 `->>` 恒为 NULL，排查时看起来像「特征没算」。类型断言能一眼看出这种退化。
    expect(rows[0]?.kind).toBe('object')
    expect(rows[0]?.contribution).toBe('0.35')
    expect(JSON.parse(rows[0]?.missing ?? 'null')).toEqual(['wish'])
  })

  test('findRequestItemAttribution 一次取多次请求的归因真值，键是 (requestId, listingId)', async () => {
    const first = await createRequest()
    const second = await createRequest()
    await store.insertRequestItems([
      item(first, 0, { listingId: listingIdAt(0), primarySource: 'fresh' }),
      item(first, 1, { listingId: listingIdAt(1), primarySource: 'semantic' }),
      item(second, 0, { listingId: listingIdAt(0), primarySource: 'popular' }),
    ])

    const rows = await store.findRequestItemAttribution({
      requestIds: [first, second],
      listingIds: [listingIdAt(0), listingIdAt(1)],
    })
    expect(rows).toHaveLength(3)
    const byKey = new Map(
      rows.map((row) => [`${row.requestId}:${row.listingId}`, row.primarySource]),
    )
    // 同一商品在不同请求里的归因各自独立：ingest 就是按这两列查的。
    expect(byKey.get(`${first}:${listingIdAt(0)}`)).toBe('fresh')
    expect(byKey.get(`${second}:${listingIdAt(0)}`)).toBe('popular')
    expect(byKey.get(`${first}:${listingIdAt(1)}`)).toBe('semantic')

    // 商品条件必须真的下推到 SQL：只问 listingIdAt(0) 就只回那两行，而不是把整份快照拉回来
    // 再由调用方过滤（最坏 50 请求 × 200 行）。
    const narrowed = await store.findRequestItemAttribution({
      requestIds: [first, second],
      listingIds: [listingIdAt(0)],
    })
    expect(narrowed.map((row) => row.listingId)).toEqual([listingIdAt(0), listingIdAt(0)])
    expect(narrowed.every((row) => row.position === 0)).toBe(true)
    // 本批事件里没有的商品：一行都不该回（包括别的请求快照里的那些）。
    expect(
      await store.findRequestItemAttribution({
        requestIds: [first, second],
        listingIds: [listingIdAt(2)],
      }),
    ).toEqual([])

    expect(
      await store.findRequestItemAttribution({ requestIds: [], listingIds: [listingIdAt(0)] }),
    ).toEqual([])
    expect(await store.findRequestItemAttribution({ requestIds: [first], listingIds: [] })).toEqual(
      [],
    )
    expect(
      await store.findRequestItemAttribution({
        requestIds: [newId()],
        listingIds: [listingIdAt(0)],
      }),
    ).toEqual([])
  })
})
