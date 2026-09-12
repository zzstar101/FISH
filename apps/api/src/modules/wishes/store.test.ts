import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
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

  test('db match queue inserts a PENDING MATCH_WISH job with the wishId payload', async () => {
    const wishId = crypto.randomUUID()
    await matchQueue.enqueue(wishId)

    const job = rows(
      await db.execute(sql`
        SELECT type, payload, status FROM jobs
        WHERE payload->>'wishId' = ${wishId} ORDER BY created_at DESC LIMIT 1
      `),
    )[0]
    expect(job?.type).toBe('MATCH_WISH')
    expect(job?.status).toBe('PENDING')
    expect(job?.payload).toEqual({ wishId })

    // 幂等：重复投递同一 wishId 不再新增 job（重放只补投真正缺失的那条）
    await matchQueue.enqueue(wishId)
    const count = rows(
      await db.execute(
        sql`SELECT count(*)::int AS c FROM jobs WHERE payload->>'wishId' = ${wishId}`,
      ),
    )[0]
    expect(Number(count?.c)).toBe(1)
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
      await db.execute(sql`
        INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition)
        VALUES (${listingId}, ${userId}, '测试商品', '描述', 15000, 'DIGITAL', 'GOOD')
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
