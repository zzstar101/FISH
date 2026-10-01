import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  INTEREST_STRATEGY_VERSION,
  interestLookbackStart,
} from '@fish/contracts/recommendation/interest'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { EMBEDDING_DIMENSIONS, embeddings } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { findUserInterestProfile, saveUserInterestProfile } from '@fish/db/user-interest-store'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import { createInterestJobHandlers, refreshUserInterestProfile } from './handlers'

/**
 * 长期画像重算 handler（#323 R2）的集成测试：真实 Postgres。
 *
 * 这里要钉住的是"**全量重算**"这个语义在真实数据变来变去时的四种归宿：
 * `saved` / `superseded`（CAS）/ `cleared`（证据没了要删行）/ `empty`（从来就没有），
 * 以及坏 payload 必须 FATAL 而不是重试三次。
 * 权重、衰减、归一化的数学由 `packages/contracts` 的单测负责，这里只验"落库的那一行对不对"。
 *
 * 用独立 scratch 库（而不是既有 embedding 测试那种"直接连开发库 + 手工清理"）：
 * 本用例会造商品、向量、行为事件与画像行四类数据，且要在开发库**已迁移**的前提下才能跑；
 * 独立库让这条用例既不影响别人共用的开发库，也不依赖它当前迁移到哪一版。
 */

// 与 packages/db / apps/api 的集成测试同一约定：没有 DATABASE_URL 就明确失败。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_interest_worker_test_${process.pid}`
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

/** 测试用的 embedding 模型名（聚合只认"当前模型"这一个字符串）。 */
const MODEL = 'interest-worker-test-model'
const OTHER_MODEL = 'interest-worker-test-model-legacy'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

let seq = 0

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

function magnitude(vector: readonly number[]): number {
  return Math.sqrt(dot(vector, vector))
}

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `interest-worker-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '长期画像 handler 测试',
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
      title: `长期画像测试商品 ${seq++}`,
      description: '长期画像聚合测试',
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
    })
    .returning({ updatedAt: listings.updatedAt })
  const row = rows[0]
  if (!row) throw new Error('insert listings 未返回行')
  return { id, updatedAt: row.updatedAt }
}

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
  userId: string
  listingId: string
  eventType: (typeof recommendationEvents.$inferInsert)['eventType']
  occurredAt: Date
}

async function addEvent(input: EventInput): Promise<void> {
  await db.insert(recommendationEvents).values({
    id: newId(),
    eventId: newId(),
    userId: input.userId,
    anonymousSessionId: null,
    requestId: null,
    listingId: input.listingId,
    eventType: input.eventType,
    position: null,
    occurredAt: input.occurredAt,
  })
}

describe('refreshUserInterestProfile', () => {
  test('有行为时写入画像行：版本号/条数/窗口/模型/归一化向量都对得上', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()

    // 一小时前收藏 X（强正反馈，w=4），一分钟前点开 Y（弱行为，w=1）：
    // 长期窗口（14 天半衰期）下两者衰减都微不足道，方向应由收藏主导。
    const favorite = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: favorite.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })
    const detail = await listingWithVector(sellerId, Y)
    await addEvent({
      userId,
      listingId: detail.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const result = await refreshUserInterestProfile(db, {
      userId,
      embeddingModel: MODEL,
      now,
    })

    expect(result.status).toBe('saved')
    expect(result.usedActions).toBe(2)
    expect(result.skipped).toEqual({ noVector: 0, decayed: 0 })

    const row = await findUserInterestProfile(db, { userId, model: MODEL })
    expect(row).not.toBeNull()
    if (!row) throw new Error('本用例期望写入画像行')

    expect(row.strategyVersion).toBe(INTEREST_STRATEGY_VERSION)
    expect(row.model).toBe(MODEL)
    expect(row.dimensions).toBe(EMBEDDING_DIMENSIONS)
    expect(row.embedding.length).toBe(EMBEDDING_DIMENSIONS)
    expect(row.actionCount).toBe(2)
    // 窗口起点是"近 180 天"，与事件 retention 对齐；写入的是读数据那一刻的 now。
    expect(row.windowStartedAt.getTime()).toBe(interestLookbackStart(now).getTime())
    expect(row.computedAt.getTime()).toBe(now.getTime())
    // L2 归一化：模长必须是 1，否则语义召回的 cosine 排序会被"行为条数多寡"污染。
    expect(magnitude(row.embedding)).toBeCloseTo(1, 6)
    expect(dot(row.embedding, X)).toBeGreaterThan(dot(row.embedding, Y))
  })

  test('同一 now 重跑是幂等的（saved），更早的 now 会被 CAS 挡成 superseded 且不改旧行', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })

    expect(
      (await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })).status,
    ).toBe('saved')

    // 同 now 再跑：CAS 是 `>=`，相等算通过，结果稳定可复现。
    const again = await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })
    expect(again.status).toBe('saved')
    expect(again.usedActions).toBe(1)

    // 一个"读得早、算得晚"的 job：它的 computed_at 更小，不能覆盖已经写入的新画像。
    const stale = await refreshUserInterestProfile(db, {
      userId,
      embeddingModel: MODEL,
      now: new Date(now.getTime() - HOUR),
    })
    expect(stale.status).toBe('superseded')

    const row = await findUserInterestProfile(db, { userId, model: MODEL })
    expect(row?.computedAt.getTime()).toBe(now.getTime())
  })

  test('并发的更晚一次重算已经写过 → superseded，且不动那一行', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    // 模拟"另一个 job 用更晚的时刻先写完了"。
    const laterNow = new Date(now.getTime() + HOUR)
    await saveUserInterestProfile(db, {
      userId,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      strategyVersion: INTEREST_STRATEGY_VERSION,
      embedding: Y,
      actionCount: 7,
      windowStartedAt: interestLookbackStart(laterNow),
      computedAt: laterNow,
    })

    const result = await refreshUserInterestProfile(db, {
      userId,
      embeddingModel: MODEL,
      now,
    })

    expect(result.status).toBe('superseded')
    const row = await findUserInterestProfile(db, { userId, model: MODEL })
    expect(row?.actionCount).toBe(7)
    expect(row?.computedAt.getTime()).toBe(laterNow.getTime())
    expect(dot(row?.embedding ?? [], Y)).toBeCloseTo(1, 6)
  })

  test('版本号取「读完数据之后」：读得更晚的慢 job 不会被更早的结果挡掉', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })

    // 另一个 job 在 T1 先写完了：它的入口比本次晚，但读到的是更旧的数据。
    const earlier = new Date(now.getTime() + MINUTE)
    await saveUserInterestProfile(db, {
      userId,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      strategyVersion: INTEREST_STRATEGY_VERSION,
      embedding: Y,
      actionCount: 7,
      windowStartedAt: interestLookbackStart(earlier),
      computedAt: earlier,
    })

    /*
     * 本次 job：`now`（衰减基准）仍是更早的 T0，但数据是 T2 才读完的。
     * `computedAt` 必须取 T2 —— 取 T0（旧写法：函数入口）会被 T1 那份挡成 `superseded`，
     * 于是库里一直留着一份**证据更旧**的画像，直到用户下一条行为才被纠正。
     */
    const readDone = new Date(now.getTime() + HOUR)
    const result = await refreshUserInterestProfile(db, {
      userId,
      embeddingModel: MODEL,
      now,
      clock: () => readDone,
    })

    expect(result.status).toBe('saved')
    const row = await findUserInterestProfile(db, { userId, model: MODEL })
    expect(row?.computedAt.getTime()).toBe(readDone.getTime())
    expect(row?.actionCount).toBe(1)
    expect(dot(row?.embedding ?? [], X)).toBeCloseTo(1, 6)
  })

  test('窗口内已无可用向量 → 删掉旧行（cleared），读取返回 null', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })

    expect(
      (await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })).status,
    ).toBe('saved')
    expect(await findUserInterestProfile(db, { userId, model: MODEL })).not.toBeNull()

    // 商品被编辑 → 向量过期（`source_updated_at` 落后于 `listings.updated_at`），行为还在但证据不再可用。
    await makeEmbeddingStale(listing.id, listing.updatedAt)
    await db.update(listings).set({ title: '商品标题被改过' }).where(eq(listings.id, listing.id))

    const result = await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })

    expect(result.status).toBe('cleared')
    expect(result.usedActions).toBe(0)
    expect(result.skipped.noVector).toBe(1)
    expect(await findUserInterestProfile(db, { userId, model: MODEL })).toBeNull()
  })

  test('删除路径同样受 CAS 约束：更晚写过的画像不会被旧一次重算删掉', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })

    // 等价于"另一个 worker 用更晚的时刻已经写过一份画像"。
    const laterNow = new Date(now.getTime() + HOUR)
    await saveUserInterestProfile(db, {
      userId,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      strategyVersion: INTEREST_STRATEGY_VERSION,
      embedding: Y,
      actionCount: 3,
      windowStartedAt: interestLookbackStart(laterNow),
      computedAt: laterNow,
    })

    // 这次重算（读数据时刻更早）落在"无可用向量"分支：必须被 CAS 挡下，不能删掉更晚的行。
    await makeEmbeddingStale(listing.id, listing.updatedAt)
    await db.update(listings).set({ title: '商品标题被改过' }).where(eq(listings.id, listing.id))

    const result = await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })

    expect(result.status).toBe('superseded')
    expect(result.usedActions).toBe(0)
    const row = await findUserInterestProfile(db, { userId, model: MODEL })
    expect(row?.computedAt.getTime()).toBe(laterNow.getTime())
    expect(row?.actionCount).toBe(3)
  })

  test('没有行为 → empty（明确"没有画像"，绝不写零向量）', async () => {
    const userId = await createUser()
    const now = new Date()

    const result = await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })

    expect(result.status).toBe('empty')
    expect(result.usedActions).toBe(0)
    expect(result.skipped).toEqual({ noVector: 0, decayed: 0 })
    expect(await findUserInterestProfile(db, { userId, model: MODEL })).toBeNull()
  })

  test('只有别的模型的向量 → 该行为按 noVector 跳过，没有画像', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await createListing(sellerId)
    await putEmbedding(listing.id, X, { model: OTHER_MODEL, sourceUpdatedAt: listing.updatedAt })
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })

    const result = await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })

    expect(result.status).toBe('empty')
    expect(result.usedActions).toBe(0)
    expect(result.skipped.noVector).toBe(1)
    expect(await findUserInterestProfile(db, { userId, model: MODEL })).toBeNull()
  })

  test('180 天窗口外的行为不参与（老用户长期不活跃会退化成没有画像）', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const now = new Date()
    const listing = await listingWithVector(sellerId, X)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - 181 * DAY),
    })

    const result = await refreshUserInterestProfile(db, { userId, embeddingModel: MODEL, now })

    expect(result.status).toBe('empty')
    expect(result.usedActions).toBe(0)
    expect(result.skipped).toEqual({ noVector: 0, decayed: 0 })
  })
})

describe('createInterestJobHandlers', () => {
  test('合法 payload 走完整链路并返回结构化结果', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const listing = await listingWithVector(sellerId, Y)
    await addEvent({
      userId,
      listingId: listing.id,
      eventType: 'CHAT_START',
      occurredAt: new Date(Date.now() - MINUTE),
    })

    const handlers = createInterestJobHandlers(db, { embeddingModel: MODEL })
    const result = await handlers.REFRESH_USER_INTEREST({ userId })

    expect(result.status).toBe('saved')
    expect(result.userId).toBe(userId)
    expect(result.usedActions).toBe(1)
  })

  test('payload 非法时抛 InvalidJobPayloadError（FATAL，不重试）', async () => {
    const handlers = createInterestJobHandlers(db, { embeddingModel: MODEL })
    for (const payload of [
      {},
      { userId: 'not-a-uuid' },
      { userId: newId(), extra: 1 },
      null,
      'REFRESH_USER_INTEREST',
    ]) {
      await expect(handlers.REFRESH_USER_INTEREST(payload)).rejects.toBeInstanceOf(
        InvalidJobPayloadError,
      )
    }
  })

  test('不认识的事件不参与画像：只有曝光时依然没有画像', async () => {
    const userId = await createUser()
    const sellerId = await createUser()
    const listing = await listingWithVector(sellerId, X)
    await db.insert(recommendationEvents).values({
      id: newId(),
      eventId: newId(),
      userId,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      requestId: newId(),
      position: 0,
      occurredAt: new Date(),
    })

    const handlers = createInterestJobHandlers(db, { embeddingModel: MODEL })
    expect((await handlers.REFRESH_USER_INTEREST({ userId })).status).toBe('empty')
  })
})
