import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildWishEmbeddingText, contentHashOf } from '@fish/contracts/embedding/text'
import { createDb } from '@fish/db/client'
import { findEmbedding, saveEmbedding } from '@fish/db/embedding-store'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDbWishMatchQueue } from './match-queue'
import { createSqlWishStore, type WishRow } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 seed.test.ts / auth router.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_wish_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlWishStore(db)
const matchQueue = createDbWishMatchQueue(db)

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

const userId = crypto.randomUUID()
const otherUserIds = [crypto.randomUUID(), crypto.randomUUID()]

const baseRow = (overrides: Partial<WishRow> = {}): WishRow => ({
  id: crypto.randomUUID(),
  user_id: userId,
  keyword: '机械键盘',
  category: 'DIGITAL',
  budget_min_cents: 10000,
  budget_max_cents: 20000,
  description: null,
  accept_similar: true,
  status: 'ACTIVE',
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
})

// ---- #322 M2 复审 blocker：向量行失效（写路径按内容指纹删旧行）用到的辅助 ----

const EMBEDDING_MODEL = 'stub-deterministic-v1'

function unitVector(axis: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === axis ? 1 : 0))
}

/** 实体当前的 `updated_at`：向量行要记的版本号，也是"新鲜"判据的一端。 */
async function currentWishVersion(wishId: string): Promise<Date> {
  const rows = await db
    .select({ updatedAt: wishes.updatedAt })
    .from(wishes)
    .where(eq(wishes.id, wishId))
  const row = rows[0]
  if (!row) throw new Error('wish 不存在')
  return row.updatedAt
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [userId, ...otherUserIds].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`wish${process.pid}_${i}`}, 'test-hash', '愿望测试')
    `)
  }
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('wishes store (integration)', () => {
  test('creates a wish and returns the recent row for a duplicate submission', async () => {
    const created = await store.createOrGetRecent(baseRow(), 10, new Date(Date.now() - 5_000))
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return

    const replay = await store.createOrGetRecent(
      baseRow({ id: crypto.randomUUID() }),
      10,
      new Date(Date.now() - 5_000),
    )
    expect(replay.kind).toBe('duplicate')
    if (replay.kind === 'duplicate') expect(replay.row.id).toBe(created.row.id)
  })

  test('db match queue 投递 MATCH_WISH + EMBED_WISH 两条 PENDING job，且重复投递幂等', async () => {
    const wishId = crypto.randomUUID()
    await matchQueue.enqueue(wishId)

    const queued = rows(
      await db.execute(sql`
        SELECT type, payload, status FROM jobs
        WHERE payload->>'wishId' = ${wishId} ORDER BY type
      `),
    )
    // #322 M1：一次 enqueue = v1 重算 + 语义向量刷新，成对投递（漏一边会让编辑后的状态不一致）。
    expect(queued.map((row) => row.type)).toEqual(['EMBED_WISH', 'MATCH_WISH'])
    expect(queued.map((row) => row.status)).toEqual(['PENDING', 'PENDING'])
    for (const row of queued) expect(row.payload).toEqual({ wishId })

    // 幂等：重复投递同一 wishId 不再新增 job（重放只补投真正缺失的那条）。
    await matchQueue.enqueue(wishId)
    const count = rows(
      await db.execute(
        sql`SELECT count(*)::int AS c FROM jobs WHERE payload->>'wishId' = ${wishId}`,
      ),
    )[0]
    expect(Number(count?.c)).toBe(2)
  })

  test('db match queue：投递前先让旧内容的向量行失效（#333 复审 blocker）', async () => {
    const wishId = crypto.randomUUID()
    // keyword 必须唯一：同 user + 同 keyword + 同 category 的 5 秒窗口查重会命中前面用例建的行。
    const wishRow = baseRow({
      id: wishId,
      keyword: `愿望失效-${crypto.randomUUID()}`,
      description: '旧描述',
    })
    const created = await store.createOrGetRecent(wishRow, 10, new Date(Date.now() - 5_000))
    expect(created.kind).toBe('created')

    const facts = {
      keyword: wishRow.keyword,
      description: wishRow.description,
      category: wishRow.category,
    }
    await saveEmbedding(db, {
      entity: { kind: 'wish', id: wishId },
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: contentHashOf(buildWishEmbeddingText(facts)),
      embedding: unitVector(0),
      sourceUpdatedAt: await currentWishVersion(wishId),
    })

    // 编辑内容后走写路径的投递入口（service 的顺序就是 update 之后 enqueue）：旧向量当场消失，
    // 不必等 worker 跑到 EMBED_WISH——这是"按内容失效"而不是"等向量重算"的关键差别。
    await store.update(wishId, { description: '新描述：语义完全变了' }, new Date())
    await matchQueue.enqueue(wishId)
    expect(await findEmbedding(db, { kind: 'wish', id: wishId }, EMBEDDING_MODEL)).toBeNull()

    // 新内容的向量落库后内容没再变：再投一次不该删掉它（指纹一致 ⇒ EMBED_WISH 走 unchanged，不重复计费）。
    await saveEmbedding(db, {
      entity: { kind: 'wish', id: wishId },
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: contentHashOf(
        buildWishEmbeddingText({ ...facts, description: '新描述：语义完全变了' }),
      ),
      embedding: unitVector(1),
      sourceUpdatedAt: await currentWishVersion(wishId),
    })
    await matchQueue.enqueue(wishId)
    expect(
      (await findEmbedding(db, { kind: 'wish', id: wishId }, EMBEDDING_MODEL))?.embedding,
    ).toEqual(unitVector(1))
  })

  test('rolls back the wish when the MATCH_WISH job insert fails', async () => {
    // 反向用例：愿望与 job 是同一语句，job 失败必须整体回滚，不能留下没有 job 的愿望。
    await db.execute(
      sql`ALTER TABLE jobs ADD CONSTRAINT tmp_reject_match_wish CHECK (type <> 'MATCH_WISH') NOT VALID`,
    )
    try {
      const wish = baseRow({ keyword: '原子性验证' })
      await expect(
        store.createOrGetRecent(wish, 10, new Date(Date.now() - 5_000)),
      ).rejects.toThrow()
      expect(await store.findById(wish.id)).toBeNull()
    } finally {
      await db.execute(sql`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS tmp_reject_match_wish`)
    }
  })

  test('findById and listByUser report matchCount from the matches table', async () => {
    const wish = baseRow({ keyword: '二手教材' })
    const created = await store.createOrGetRecent(wish, 10, new Date(Date.now() - 5_000))
    expect(created.kind).toBe('created')

    for (let i = 0; i < 2; i += 1) {
      const listingId = crypto.randomUUID()
      const listingNo = await reserveTestListingNo(db, listingId)
      await db.execute(sql`
        INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition)
        VALUES (${listingId}, ${listingNo}, ${userId}, '测试商品', '描述', 15000, 'DIGITAL', 'GOOD')
      `)
      await db.execute(sql`
        INSERT INTO matches (id, listing_id, wish_id, score, category_score, keyword_score, price_score)
        VALUES (${crypto.randomUUID()}, ${listingId}, ${wish.id}, 80, 30, 30, 20)
      `)
    }

    const found = await store.findById(wish.id)
    expect(found?.match_count).toBe(2)

    const listed = await store.listByUser(userId, { status: 'ACTIVE', limit: 20, offset: 0 })
    const own = listed.rows.find((row) => row.id === wish.id)
    expect(own?.match_count).toBe(2)

    // 编辑/关闭的 UPDATE RETURNING 也要带上真实 matchCount，而不是兜底 0
    const updated = await store.update(wish.id, { keyword: '考研教材' }, new Date())
    expect(updated?.match_count).toBe(2)

    // 软幂等重复创建返回的是同一行，matchCount 同样不能回退成 0
    const replay = await store.createOrGetRecent(
      baseRow({ id: crypto.randomUUID(), keyword: '考研教材' }),
      10,
      new Date(Date.now() - 5_000),
    )
    expect(replay.kind).toBe('duplicate')
    if (replay.kind === 'duplicate') expect(replay.row.match_count).toBe(2)

    const closed = await store.updateStatusIfActive(wish.id, 'CLOSED', new Date())
    expect(closed?.match_count).toBe(2)
  })

  test('pool aggregation keeps only k-anonymous ACTIVE groups over real SQL', async () => {
    // 自行车组 4 行 ACTIVE（20000×3 / 30000），中位数 20000。
    // created_at 挪到软幂等窗口外，避免同用户同关键词的批量插入被判为重复提交。
    const oldRow = (overrides: Partial<WishRow> = {}) =>
      baseRow({ created_at: new Date(Date.now() - 60_000), updated_at: new Date(), ...overrides })
    for (const [i, budget] of [20_000, 20_000, 20_000, 30_000].entries()) {
      const created = await store.createOrGetRecent(
        oldRow({
          keyword: '自行车',
          budget_max_cents: budget,
          user_id: i < 2 ? userId : otherUserIds[i - 2],
        }),
        10,
        new Date(Date.now() - 5_000),
      )
      expect(created.kind).toBe('created')
    }
    // 已关闭的同组愿望不计入需求池
    await store.createOrGetRecent(
      oldRow({ keyword: '自行车', status: 'CLOSED' }),
      10,
      new Date(Date.now() - 5_000),
    )
    // 只有 2 条 ACTIVE：低于 k-匿名阈值，不应出现
    for (const owner of [userId, otherUserIds[0]]) {
      await store.createOrGetRecent(
        oldRow({ keyword: '游戏掌机', user_id: owner }),
        10,
        new Date(Date.now() - 5_000),
      )
    }

    // 同一用户刷 3 行、只有 1 个去重用户：不得靠行数把自己抬进需求池
    for (let i = 0; i < 3; i += 1) {
      const created = await store.createOrGetRecent(
        oldRow({ keyword: '单人多条' }),
        10,
        new Date(Date.now() - 5_000),
      )
      expect(created.kind).toBe('created')
    }

    const pool = await store.aggregatePool(3, 50)
    const bike = pool.find((item) => item.keyword === '自行车')
    expect(bike?.want_count).toBe(4)
    expect(bike?.median_budget_cents).toBe(20_000)
    expect(pool.find((item) => item.keyword === '游戏掌机')).toBeUndefined()
    expect(pool.find((item) => item.keyword === '单人多条')).toBeUndefined()
  })
})
