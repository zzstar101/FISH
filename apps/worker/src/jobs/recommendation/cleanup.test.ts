/**
 * 保留期清理的集成测试（Issue #323 R6 / 设计 §7）。
 *
 * 纯逻辑没什么可测的（就是三条 `DELETE`），所以这里的价值全在**边界与规模**上：
 *   1. 截止时间是**严格早于**（`<`）：正好落在 90 天/180 天那一刻的行必须留下；
 *   2. **没有快照行的请求也要被删**——降级 Feed（`rec-v1-none` 直通游标）与"快照写入失败"的请求
 *      一行快照都没有，如果按文档 §7.2 第 2 步"复用第 1 步取到的 request_id 集合"，这些请求行
 *      永远删不掉，保留期承诺直接失效。这条用例就是那个回归护栏；
 *   3. 批大小真的分批（`batches` 反映轮数），且重复运行幂等（第二轮全 0）。
 *
 * scratch 库模式与 `apps/worker/src/jobs/recommendation/store.test.ts` 一致：不污染开发库。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequestItems } from '@fish/db/schema/recommendation-request-items'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { cleanupExpiredRecommendationData } from './cleanup'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_recommendation_cleanup_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

/** 清理基准时刻。两个截止时间由它推出：上下文 2026-01-10T00:00:00Z、事件 2025-10-12T00:00:00Z。 */
const NOW = new Date('2026-04-10T00:00:00Z')
const CONTEXT_EDGE = new Date('2026-01-10T00:00:00Z')
const EVENT_EDGE = new Date('2025-10-12T00:00:00Z')

const admin = createDb(databaseUrl)
let db: Db
let listingId: string
let sellerId: string

async function insertRequest(input: {
  requestedAt: Date
  strategyVersion?: string
}): Promise<string> {
  const id = newId()
  await db.insert(recommendationRequests).values({
    id,
    userId: sellerId,
    strategyVersion: input.strategyVersion ?? 'rec-v1-rule+interest-v1+recall-v1+rank-v1',
    requestedAt: input.requestedAt,
  })
  return id
}

async function insertItem(requestId: string, position: number): Promise<void> {
  await db.insert(recommendationRequestItems).values({
    requestId,
    position,
    listingId,
    primarySource: 'fresh',
    sources: ['fresh'],
    rankScore: 0.25,
    rankBreakdown: {},
  })
}

async function insertEvent(occurredAt: Date): Promise<void> {
  await db.insert(recommendationEvents).values({
    eventId: newId(),
    listingId,
    eventType: 'DETAIL_VIEW',
    occurredAt,
  })
}

async function countRows(table: 'requests' | 'items' | 'events'): Promise<number> {
  const identifier =
    table === 'requests'
      ? sql`recommendation_requests`
      : table === 'items'
        ? sql`recommendation_request_items`
        : sql`recommendation_events`
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM ${identifier}`)
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  return Number((rows[0] as { count?: unknown } | undefined)?.count ?? 0)
}

// 数据只在 beforeAll 里造一次，用例之间靠**顺序**共享状态：先试运行（不写），再真删，再批大小，
// 最后幂等。用 `describe` 内的顺序依赖是有意的——每一轮的"删除前/后"断言都要看到上一轮的结果。
beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  const [user] = await db
    .insert(users)
    .values({
      studentNo: `cleanup-test-${Date.now()}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '保留期清理测试',
    })
    .returning({ id: users.id })
  if (!user) throw new Error('insert users 未返回行')
  sellerId = user.id

  listingId = newId()
  await db.insert(listings).values({
    id: listingId,
    listingNo: await reserveTestListingNo(db, listingId),
    sellerId,
    title: '清理测试商品',
    description: '保留期清理测试',
    priceCents: 1000,
    category: 'DIGITAL',
    condition: 'GOOD',
  })

  // 过期请求：一条有 2 行快照、一条**一行快照都没有**（降级 / 快照写失败的样子）。
  const expiredWithItems = await insertRequest({ requestedAt: new Date('2026-01-09T00:00:00Z') })
  await insertItem(expiredWithItems, 0)
  await insertItem(expiredWithItems, 1)
  await insertRequest({ requestedAt: new Date('2026-01-05T00:00:00Z') })
  // 边界：正好 90 天（严格早于才算过期 ⇒ 留下）。
  await insertRequest({ requestedAt: CONTEXT_EDGE })
  // 新鲜：一条请求 + 一行快照，必须留下。
  const fresh = await insertRequest({ requestedAt: new Date('2026-04-01T00:00:00Z') })
  await insertItem(fresh, 0)

  await insertEvent(new Date('2025-10-11T00:00:00Z'))
  await insertEvent(EVENT_EDGE)
  await insertEvent(new Date('2026-04-01T00:00:00Z'))
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('cleanupExpiredRecommendationData（#323 R6 §7）', () => {
  test('dryRun：只统计待删行数，一行都不写', async () => {
    const before = {
      requests: await countRows('requests'),
      items: await countRows('items'),
      events: await countRows('events'),
    }

    const result = await cleanupExpiredRecommendationData({ db, now: NOW, dryRun: true })

    // 请求 2 条过期（有快照的 + 无快照的），快照 2 行，事件 1 条过期；边界那三条不算。
    expect(result).toEqual({
      deletedRequestItems: 2,
      deletedRequests: 2,
      deletedEvents: 1,
      batches: 0,
    })
    expect({
      requests: await countRows('requests'),
      items: await countRows('items'),
      events: await countRows('events'),
    }).toEqual(before)
  })

  test('真删：严格早于截止时间的行被删，边界与新鲜行留下', async () => {
    const result = await cleanupExpiredRecommendationData({ db, now: NOW, batchSize: 1000 })

    expect(result).toEqual({
      deletedRequestItems: 2,
      deletedRequests: 2,
      deletedEvents: 1,
      batches: 1,
    })
    // 剩：边界请求 + 新鲜请求（各 1 行快照被级联/显式删掉后的结果）与边界 + 新鲜事件。
    expect(await countRows('requests')).toBe(2)
    expect(await countRows('items')).toBe(1)
    expect(await countRows('events')).toBe(2)

    // 边界那一刻的请求必须还在（严格 `<`）。
    const edge = await db
      .select({ id: recommendationRequests.id })
      .from(recommendationRequests)
      .where(eq(recommendationRequests.requestedAt, CONTEXT_EDGE))
    expect(edge).toHaveLength(1)
    const edgeEvent = await db
      .select({ id: recommendationEvents.id })
      .from(recommendationEvents)
      .where(eq(recommendationEvents.occurredAt, EVENT_EDGE))
    expect(edgeEvent).toHaveLength(1)
  })

  test('重复运行幂等：没有可删的行时不报错、批次数为 0', async () => {
    const result = await cleanupExpiredRecommendationData({ db, now: NOW, batchSize: 1000 })
    expect(result).toEqual({
      deletedRequestItems: 0,
      deletedRequests: 0,
      deletedEvents: 0,
      batches: 0,
    })
  })

  test('批大小：batchSize=1 时按轮次分批（batches 反映轮数）', async () => {
    // 再造 3 条过期请求 + 3 行快照：batchSize=1 时快照要 3 轮、请求要 3 轮。
    for (const index of [0, 1, 2]) {
      const requestId = await insertRequest({
        requestedAt: new Date(`2026-01-0${index + 1}T00:00:00Z`),
      })
      await insertItem(requestId, 0)
    }

    const result = await cleanupExpiredRecommendationData({ db, now: NOW, batchSize: 1 })

    expect(result.deletedRequestItems).toBe(3)
    expect(result.deletedRequests).toBe(3)
    expect(result.deletedEvents).toBe(0)
    // 第 1 轮删 3 类各 1 行、第 2 轮各 1 行、第 3 轮各 1 行，第 4 轮全 0 才停 ⇒ 3 批。
    expect(result.batches).toBe(3)
    expect(await countRows('requests')).toBe(2)
    expect(await countRows('items')).toBe(1)
  })

  test('批大小非法直接抛错，不静默按默认值跑', async () => {
    await expect(cleanupExpiredRecommendationData({ db, now: NOW, batchSize: 0 })).rejects.toThrow(
      '清理批大小必须是正整数',
    )
    await expect(
      cleanupExpiredRecommendationData({ db, now: NOW, batchSize: 1.5 }),
    ).rejects.toThrow('清理批大小必须是正整数')
  })
})
