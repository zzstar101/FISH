import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  aggregateInterestVector,
  INTEREST_HALF_LIFE_MS,
  type InterestAction,
} from '@fish/contracts/recommendation/interest'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { EMBEDDING_DIMENSIONS, embeddings } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { readSessionInterest } from './interest'

/**
 * session 画像读取（#323 R2）的集成测试：真实 Postgres + 真实 schema。
 *
 * 为什么要真库而不是打桩：本模块的正确性一半在 SQL（窗口、身份过滤、`LIMIT 50` 的语义），
 * 一半在纯计算（权重/衰减/归一化）。纯计算由 `packages/contracts` 的单测覆盖，这里只验证
 * "从库里读出来的行为"与"算出来的画像"接起来之后的行为——尤其是**身份不串**与
 * **不可用向量按原因分账**这两件只有真库才暴露的事。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_recommendation_interest_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

/** 测试用的 embedding 模型名。生产值是 `EMBEDDING_MODEL`，聚合只认"当前模型"这一个字符串。 */
const MODEL = 'interest-test-model'
const OTHER_MODEL = 'interest-test-model-legacy'

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

let seq = 0

/** 1536 维单位向量：只有 `axis` 位是 1。手算点积用，避免用例里出现大段数字。 */
function unitVector(axis: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[axis] = 1
  return vector
}

const X = unitVector(0)
const Y = unitVector(1)

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0)
  }
  return sum
}

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `interest-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '画像测试用户',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

async function createListing(sellerId: string): Promise<{ id: string; updatedAt: Date }> {
  const id = newId()
  const rows = await db
    .insert(listings)
    .values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: `画像测试商品 ${seq++}`,
      description: '画像聚合测试',
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
    })
    .returning({ updatedAt: listings.updatedAt })
  const row = rows[0]
  if (!row) throw new Error('insert listings 未返回行')
  return { id, updatedAt: row.updatedAt }
}

/**
 * 写一条向量行。默认 `source_updated_at = listings.updated_at`（**新鲜**，与 #322 的谓词一致）；
 * 传 `sourceUpdatedAt` 可以造出"商品已编辑、向量没跟上"的过期行。
 */
async function putEmbedding(
  listingId: string,
  vector: number[],
  options: { model?: string; sourceUpdatedAt: Date },
): Promise<void> {
  await db.insert(embeddings).values({
    id: newId(),
    listingId,
    model: options.model ?? MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: `hash-${seq++}`,
    embedding: vector,
    sourceUpdatedAt: options.sourceUpdatedAt,
  })
}

/** 造一件"有新鲜向量"的商品：列表行 + 与它同版本的向量行。 */
async function listingWithVector(
  sellerId: string,
  vector: number[],
): Promise<{ id: string; updatedAt: Date }> {
  const listing = await createListing(sellerId)
  await putEmbedding(listing.id, vector, { sourceUpdatedAt: listing.updatedAt })
  return listing
}

/**
 * 把某商品的向量版本改成"确定落后于商品行"（真实场景：商品编辑后向量还没重算）。
 *
 * 不靠"先写向量、再更新商品"来制造过期：那要求两次写入落在不同毫秒，同一毫秒内会假绿
 * （本仓 `packages/db/src/embeddings.test.ts` 的 `refreshEmbeddingSourceVersion` 用例
 * 就踩了这个毫秒并列的坑）。
 */
async function makeEmbeddingStale(listingId: string, listingUpdatedAt: Date): Promise<void> {
  await db
    .update(embeddings)
    .set({ sourceUpdatedAt: new Date(listingUpdatedAt.getTime() - 1000) })
    .where(eq(embeddings.listingId, listingId))
}

type EventInput = {
  userId?: string | null
  anonymousSessionId?: string | null
  listingId: string
  eventType: (typeof recommendationEvents.$inferInsert)['eventType']
  occurredAt: Date
  requestId?: string
  position?: number
}

async function addEvent(input: EventInput): Promise<void> {
  await db.insert(recommendationEvents).values({
    id: newId(),
    eventId: newId(),
    userId: input.userId ?? null,
    anonymousSessionId: input.anonymousSessionId ?? null,
    // 曝光类事件在库上有 CHECK：必须带 requestId + position（契约层同款约束的镜像）。
    requestId: input.requestId ?? null,
    listingId: input.listingId,
    eventType: input.eventType,
    position: input.position ?? null,
    occurredAt: input.occurredAt,
  })
}

describe('readSessionInterest（session 画像）', () => {
  test('session 画像快速响应最近行为，长期画像仍偏长期兴趣', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()

    // 长期兴趣：12 天前收藏了一件"教材方向"（X）的商品。
    const longTermListing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: longTermListing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - 12 * DAY),
    })
    // 当下 session：一分钟前点开了"骑行方向"（Y）的商品。
    const sessionListing = await listingWithVector(sellerId, Y)
    await addEvent({
      userId,
      listingId: sessionListing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })

    // 12 天在 30 分钟半衰期下早已下溢：它被记为 decayed，session 画像只剩最近那一条点开。
    expect(session.usedActions).toBe(1)
    expect(session.decayedActions).toBe(1)
    expect(session.vector).not.toBeNull()
    const sessionVector = session.vector ?? []
    // 30 分钟半衰期下，12 天前的收藏衰减到 ~0，session 方向几乎完全由一分钟前的点开决定。
    expect(dot(sessionVector, Y)).toBeCloseTo(1, 6)
    expect(dot(sessionVector, X)).toBeLessThan(1e-9)

    // 同一批行为换成 14 天半衰期（长期画像的口径）后，方向反而由 12 天前的收藏主导：
    // 这就是"两套半衰期"要分开的理由，也是本条用例真正钉住的东西。
    const actions: InterestAction[] = [
      { eventType: 'FAVORITE', vector: X, occurredAt: new Date(now.getTime() - 12 * DAY) },
      { eventType: 'DETAIL_VIEW', vector: Y, occurredAt: new Date(now.getTime() - MINUTE) },
    ]
    const longTerm = aggregateInterestVector({
      actions,
      now,
      halfLifeMs: INTEREST_HALF_LIFE_MS.longTerm,
    })
    const longTermVector = longTerm.vector ?? []
    expect(dot(longTermVector, X)).toBeGreaterThan(dot(longTermVector, Y))
  })

  test('没有任何行为 → 没有画像（返回 null，不返回零向量）', async () => {
    const userId = await createUser()
    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now: new Date(),
    })

    expect(session.vector).toBeNull()
    expect(session.usedActions).toBe(0)
    expect(session.skipped).toEqual({
      missing: 0,
      model_mismatch: 0,
      stale: 0,
      dimension_mismatch: 0,
    })
    expect(session.decayedActions).toBe(0)
  })

  test('曝光不算兴趣，也不占 session 的 50 条窗口名额', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, Y)

    // 60 条曝光（R1 的首页每屏就会产生），远超 50 条窗口；它们必须在 SQL 层就被排除。
    for (let index = 0; index < 60; index += 1) {
      await addEvent({
        userId,
        listingId: listing.id,
        eventType: 'IMPRESSION',
        requestId: newId(),
        position: index,
        occurredAt: new Date(now.getTime() - 30 * MINUTE - index * MINUTE),
      })
    }
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })

    // 只有那一条收藏参与聚合：曝光既没进分子，也没把窗口占满把收藏挤出去。
    expect(session.usedActions).toBe(1)
    expect(dot(session.vector ?? [], Y)).toBeCloseTo(1, 6)
  })

  test('匿名会话只吃自己的匿名行为，不串登录后的事件', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const sessionId = newId()

    const loginListing = await listingWithVector(sellerId, X)
    const anonymousListing = await listingWithVector(sellerId, Y)

    // 登录期间的行为：同时带 user_id 与 anonymous_session_id（同一浏览器先匿名后登录的真实形态）。
    for (const age of [10 * MINUTE, 20 * MINUTE]) {
      await addEvent({
        userId,
        anonymousSessionId: sessionId,
        listingId: loginListing.id,
        eventType: 'DETAIL_VIEW',
        occurredAt: new Date(now.getTime() - age),
      })
    }
    // 未登录时的行为：只有 anonymous_session_id。
    await addEvent({
      anonymousSessionId: sessionId,
      listingId: anonymousListing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const anonymous = await readSessionInterest(db, {
      identity: { kind: 'anonymous', id: sessionId },
      model: MODEL,
      now,
    })
    expect(anonymous.usedActions).toBe(1)
    expect(dot(anonymous.vector ?? [], Y)).toBeCloseTo(1, 6)

    const user = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })
    expect(user.usedActions).toBe(2)
    expect(dot(user.vector ?? [], X)).toBeCloseTo(1, 6)
  })

  test('登录用户只吃自己的行为', async () => {
    const userId = await createUser()
    const otherUserId = await createUser()
    const sellerId = await createUser()
    const now = new Date()

    const listing = await listingWithVector(sellerId, Y)
    await addEvent({
      userId: otherUserId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })
    expect(session.vector).toBeNull()
    expect(session.usedActions).toBe(0)
  })

  test('向量不可用时按原因分账，而不是静默当成零向量', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()

    // 1) 商品编辑过、向量没跟上（`source_updated_at` 落后于 `listings.updated_at`）→ stale。
    const stale = await listingWithVector(sellerId, X)
    await makeEmbeddingStale(stale.id, stale.updatedAt)
    await db.update(listings).set({ title: '编辑过的标题' }).where(eq(listings.id, stale.id))
    await addEvent({
      userId,
      listingId: stale.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    // 2) 只有别的模型的向量 → model_mismatch（换模型后还没 backfill）。
    const otherModel = await createListing(sellerId)
    await putEmbedding(otherModel.id, X, {
      model: OTHER_MODEL,
      sourceUpdatedAt: otherModel.updatedAt,
    })
    await addEvent({
      userId,
      listingId: otherModel.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    // 3) 从来没有向量 → missing。
    const missing = await createListing(sellerId)
    await addEvent({
      userId,
      listingId: missing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })

    expect(session.vector).toBeNull()
    expect(session.usedActions).toBe(0)
    expect(session.skipped).toEqual({
      missing: 1,
      model_mismatch: 1,
      stale: 1,
      dimension_mismatch: 0,
    })
  })

  test('远古行为衰减下溢后不算 session 兴趣（宁可返回 null 走冷启动）', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, Y)

    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 60 * DAY),
    })

    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })

    expect(session.vector).toBeNull()
    expect(session.usedActions).toBe(0)
    expect(session.decayedActions).toBe(1)
  })

  test('180 天窗口外的行为不参与聚合（与事件 retention 对齐）', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, Y)

    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - 181 * DAY),
    })

    const session = await readSessionInterest(db, {
      identity: { kind: 'user', id: userId },
      model: MODEL,
      now,
    })

    expect(session.vector).toBeNull()
    expect(session.usedActions).toBe(0)
    // 连"被跳过"都不算：这条行为根本没进窗口。
    expect(session.decayedActions).toBe(0)
  })
})
