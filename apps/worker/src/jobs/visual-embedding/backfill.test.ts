import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { VISUAL_EMBED_JOB_TYPES } from '@fish/contracts/visual/jobs'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import {
  listingVisualEmbeddings,
  VISUAL_EMBEDDING_DIMENSIONS,
} from '@fish/db/schema/visual-embeddings'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { saveVisualEmbedding } from '@fish/db/visual-embedding-store'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  createVisualBackfillRunner,
  drainVisualBackfill,
  enqueueVisualBackfillBatch,
} from './backfill'

// 与 #322 文本侧同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

/**
 * 本文件专用的模型名：回填谓词按 `model` 过滤，用独立模型名把本文件的向量与其它测试/seed
 * 数据的向量彻底分开。
 */
const TEST_MODEL = 'visual-backfill-test-model'

const createdUserIds: string[] = []
const createdListingIds: string[] = []

let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `visual-backfill-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '视觉回填测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  createdUserIds.push(row.id)
  return row.id
}

async function createListing(): Promise<string> {
  const id = newId()
  createdListingIds.push(id)
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId: await createUser(),
    title: 'K380 机械键盘',
    description: '青轴 95 新，附原装键帽',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
  })
  return id
}

/** 封面 = `sort_order = 0` 的那一张；回填谓词只认它。 */
async function addImage(listingId: string, objectKey: string, sortOrder: number): Promise<void> {
  await db.insert(listingImages).values({ listingId, objectKey, sortOrder })
}

/** 1024 维里只动前两维，避免浮点误差让断言变脆（与视觉 handler 测试同一取舍）。 */
function testVector(): number[] {
  const vector = new Array<number>(VISUAL_EMBEDDING_DIMENSIONS).fill(0)
  vector[0] = 1
  vector[1] = 0.5
  return vector
}

async function saveEmbedding(listingId: string, sourceObjectKey: string): Promise<void> {
  const written = await saveVisualEmbedding(db, {
    listingId,
    model: TEST_MODEL,
    dimensions: VISUAL_EMBEDDING_DIMENSIONS,
    sourceObjectKey,
    embedding: testVector(),
    sourceUpdatedAt: new Date(),
  })
  if (!written) throw new Error('saveVisualEmbedding 未写入行')
}

/** 某商品在本文件模型下的视觉 job 行（用来断言"投递了谁 / 投了几条"）。 */
function visualJobsFor(listingId: string) {
  return db
    .select({
      type: jobs.type,
      status: jobs.status,
      listingId: sql<string>`${jobs.payload}->>'listingId'`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, VISUAL_EMBED_JOB_TYPES.listing),
        sql`${jobs.payload}->>'listingId' = ${listingId}`,
      ),
    )
}

/**
 * 回填批次是**全库**扫描：库里可能残留别的脚本/测试造的商品。给"已经存在且有封面"的商品
 * 补一条本模型的新鲜向量，把它们排除出候选集，本文件的精确计数才只由自己造的行决定。
 * 这些行在 `afterAll` 按模型名统一清掉（本文件模型名独有，不会误删别人的向量）。
 */
async function neutralizeForeignListings(): Promise<void> {
  const rows = await db
    .select({ listingId: listings.id, coverKey: listingImages.objectKey })
    .from(listings)
    .innerJoin(
      listingImages,
      and(eq(listingImages.listingId, listings.id), eq(listingImages.sortOrder, 0)),
    )

  for (const row of rows) {
    await saveEmbedding(row.listingId, row.coverKey)
  }
}

async function cleanupCreated(): Promise<void> {
  if (createdListingIds.length > 0) {
    for (const listingId of createdListingIds) {
      await db
        .delete(jobs)
        .where(
          and(
            eq(jobs.type, VISUAL_EMBED_JOB_TYPES.listing),
            sql`${jobs.payload}->>'listingId' = ${listingId}`,
          ),
        )
    }
    // 删 listings 时 `listing_images` / `listing_visual_embeddings` 由 ON DELETE CASCADE 带走。
    await db.delete(listings).where(inArray(listings.id, createdListingIds))
    // `listing_numbers` 是 append-only 的独立预约表（没有指向 listings 的 FK），要显式清掉。
    await db.delete(listingNumbers).where(inArray(listingNumbers.listingId, createdListingIds))
    createdListingIds.length = 0
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds))
    createdUserIds.length = 0
  }
}

beforeEach(neutralizeForeignListings)
afterEach(cleanupCreated)

afterAll(async () => {
  await cleanupCreated()
  await db.delete(listingVisualEmbeddings).where(eq(listingVisualEmbeddings.model, TEST_MODEL))
  await db.$client.close()
})

describe('enqueueVisualBackfillBatch', () => {
  test('只投递缺向量、或向量指向旧封面的商品；封面未变的跳过', async () => {
    const missing = await createListing()
    await addImage(missing, 'listings/backfill-missing.png', 0)

    const fresh = await createListing()
    const freshCover = 'listings/backfill-fresh.png'
    await addImage(fresh, freshCover, 0)
    // 向量指向的正是当前封面 ⇒ 不需要重算。
    await saveEmbedding(fresh, freshCover)

    const stale = await createListing()
    await addImage(stale, 'listings/backfill-stale.png', 0)
    // 向量指向的是旧封面 ⇒ 不可召回，必须重投。
    await saveEmbedding(stale, 'listings/backfill-stale-old.png')

    const noCover = await createListing()
    await addImage(noCover, 'listings/backfill-second-only.png', 1)

    const result = await enqueueVisualBackfillBatch(db, { model: TEST_MODEL, limit: 10 })

    expect(result.scanned).toBe(2)
    expect(result.enqueued).toBe(2)
    expect(result.nextCursor).toBe([missing, stale].sort().at(-1) ?? null)

    expect(await visualJobsFor(missing)).toHaveLength(1)
    expect(await visualJobsFor(stale)).toHaveLength(1)
    expect(await visualJobsFor(fresh)).toHaveLength(0)
    expect(await visualJobsFor(noCover)).toHaveLength(0)
  })

  test('投递出的是真实 jobs 行：type 与 payload.listingId 都对', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/backfill-job.png', 0)

    await enqueueVisualBackfillBatch(db, { model: TEST_MODEL, limit: 10 })

    const rows = await visualJobsFor(listingId)
    // payload 经 `::text::jsonb` 落库；若退化成 jsonb 字符串标量，listingId 会是 NULL。
    expect(rows).toEqual([{ type: 'VISUAL_EMBED_LISTING', status: 'PENDING', listingId }])
  })

  test('同一商品重复投递不会产生第二条待跑 job', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/backfill-idempotent.png', 0)

    const first = await enqueueVisualBackfillBatch(db, { model: TEST_MODEL, limit: 10 })
    expect(first.scanned).toBe(1)
    expect(first.enqueued).toBe(1)
    expect(await visualJobsFor(listingId)).toHaveLength(1)

    // 商品仍没有向量（handler 没跑）⇒ 仍是候选；partial unique index + ON CONFLICT DO NOTHING
    // 让第二次投递不落新行。
    const second = await enqueueVisualBackfillBatch(db, { model: TEST_MODEL, limit: 10 })
    expect(second.scanned).toBe(1)
    // 候选仍是 1 条，但没有任何新行落库：`enqueued` 必须按真实插入计数，否则日志虚报投递量。
    expect(second.enqueued).toBe(0)
    expect(await visualJobsFor(listingId)).toHaveLength(1)
  })

  test('没有 sort_order = 0 封面的商品不进批次', async () => {
    const listingId = await createListing()
    // 只有第 2 张图：回填谓词是 inner join 封面，缺封面自然被排除。
    await addImage(listingId, 'listings/backfill-no-cover.png', 1)

    const result = await enqueueVisualBackfillBatch(db, { model: TEST_MODEL, limit: 10 })

    expect(result).toEqual({ scanned: 0, enqueued: 0, nextCursor: null })
    expect(await visualJobsFor(listingId)).toHaveLength(0)
  })
})

describe('回填游标', () => {
  test('runPass 推进游标：每条待回填商品各覆盖一次，翻到末尾后回到开头', async () => {
    const ids = [await createListing(), await createListing(), await createListing()]
    for (const [index, id] of ids.entries()) {
      await addImage(id, `listings/backfill-runner-${index}.png`, 0)
    }
    const ordered = [...ids].sort()

    const runner = createVisualBackfillRunner({ db, model: TEST_MODEL, limit: 1 })

    const cursors: (string | null)[] = []
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await runner.runPass()
      expect(result.scanned).toBe(1)
      cursors.push(result.nextCursor)
    }
    // 队首那条永远补不上（本用例不跑 handler），游标仍必须往前走：三条各一次、按 id 升序。
    expect(cursors).toEqual(ordered)

    // 翻过末尾：本批没有候选，游标清空。
    const atEnd = await runner.runPass()
    expect(atEnd).toEqual({ scanned: 0, enqueued: 0, nextCursor: null })

    // 再一轮回到开头。
    const wrapped = await runner.runPass()
    expect(wrapped.scanned).toBe(1)
    expect(wrapped.nextCursor).toBe(ordered[0] ?? null)
  })

  test('drainVisualBackfill 跑到底并返回一致的 {batches, enqueued}', async () => {
    const ids = [await createListing(), await createListing(), await createListing()]
    for (const [index, id] of ids.entries()) {
      await addImage(id, `listings/backfill-drain-${index}.png`, 0)
    }

    const result = await drainVisualBackfill(db, { model: TEST_MODEL, limit: 2 })

    // 3 条 / 每批 2 条：第一批 2 条（满批，继续），第二批 1 条（不满，收尾）。
    expect(result).toEqual({ batches: 2, enqueued: 3 })
    for (const id of ids) {
      expect(await visualJobsFor(id)).toHaveLength(1)
    }
  })
})
