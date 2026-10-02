import { afterAll, describe, expect, test } from 'bun:test'
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import {
  MATCH_SCORE_THRESHOLD,
  MATCH_SEMANTIC_TOP_K,
  RANKING_VERSION,
  RANKING_VERSION_V1,
} from '@fish/contracts/matching/schema'
import { createDb } from '@fish/db/client'
import { saveEmbedding } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { EMBEDDING_DIMENSIONS, embeddings } from '@fish/db/schema/embeddings'
import { jobs } from '@fish/db/schema/jobs'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { notifications } from '@fish/db/schema/notifications'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createMatchEngine } from './engine'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
afterAll(async () => {
  await db.$client.close()
})

/**
 * 本文件用的 embedding 模型名（#322 M2）。这些用例**不写 embeddings 行**，所以引擎一律走
 * `v1-fallback`（结构化全量候选，与 M1 之前的行为一致）——"向量召回"另有专门的用例：
 * 手工插入 `embeddings` 行做受控 fixture，见文件末尾的 `describe('向量召回')`。
 */
const TEST_EMBEDDING_MODEL = 'm2-engine-test-model'

const engine = createMatchEngine(db, { embeddingModel: TEST_EMBEDDING_MODEL })

/**
 * 隔离手段：本地库里通常还有 `db:seed` 的数据（6 个商品 / 2 个愿望）。
 * 引擎的候选集是**全库**的，所以断言分两类：
 *
 * 1. 只针对自己创建的行（`matchRows` / `matchNotifications` 都按自己的 id 过滤）；
 * 2. fixture 一律用 `OTHER` 分类 + 随机关键词——seed 的商品与愿望都不在 `OTHER`，
 *    且关键词不会命中 seed 的标题，于是"自己的那对"是唯一可能命中阈值的组合。
 *
 * 如果将来 seed 里出现了 OTHER 分类的数据，第 2 条假设需要重挑一个空分类
 * （目前 BEAUTY / TRANSPORT / OTHER 都是空的）。
 */
const ISOLATED_CATEGORY = 'OTHER' as const

let seq = 0
const uniqueKeyword = () => `qa${Date.now()}${seq++}`

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `matching-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '匹配引擎测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

async function createListing(
  sellerId: string,
  keyword: string,
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title: `测试商品 ${keyword}`,
    description: '匹配引擎集成测试',
    priceCents: 16000,
    category: ISOLATED_CATEGORY,
    condition: 'GOOD',
    ...overrides,
  })
  return id
}

async function createWish(
  userId: string,
  keyword: string,
  overrides: Partial<typeof wishes.$inferInsert> = {},
): Promise<string> {
  const id = newId()
  await db.insert(wishes).values({
    id,
    userId,
    keyword,
    category: ISOLATED_CATEGORY,
    budgetMaxCents: 20000,
    ...overrides,
  })
  return id
}

async function matchRows(listingId: string, wishId: string) {
  return db
    .select()
    .from(matches)
    .where(and(eq(matches.listingId, listingId), eq(matches.wishId, wishId)))
}

async function matchNotifications(userId: string, wishId: string) {
  return db
    .select({ id: notifications.id, payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'MATCH'),
        sql`${notifications.payload}->>'wishId' = ${wishId}`,
      ),
    )
}

/** 两个用户（卖家 / 愿望所有者）+ 用到的行，跑完一律按 id 清干净（users 没有级联）。 */
async function withFixture(
  run: (ctx: { sellerId: string; buyerId: string }) => Promise<void>,
): Promise<void> {
  const sellerId = await createUser()
  const buyerId = await createUser()

  try {
    await run({ sellerId, buyerId })
  } finally {
    // #322 M2：向量未就绪时引擎会补投 `EMBED_*` job；`jobs` 没有外键，不会跟着实体一起删。
    const ownedListings = await db
      .select({ id: listings.id })
      .from(listings)
      .where(inArray(listings.sellerId, [sellerId, buyerId]))
    const ownedWishes = await db
      .select({ id: wishes.id })
      .from(wishes)
      .where(inArray(wishes.userId, [sellerId, buyerId]))
    for (const { id } of ownedListings) {
      await db.delete(jobs).where(sql`${jobs.payload}->>'listingId' = ${id}`)
    }
    for (const { id } of ownedWishes) {
      await db.delete(jobs).where(sql`${jobs.payload}->>'wishId' = ${id}`)
    }

    await db.delete(notifications).where(inArray(notifications.userId, [sellerId, buyerId]))
    await db.delete(wishes).where(inArray(wishes.userId, [sellerId, buyerId]))
    await db.delete(listings).where(inArray(listings.sellerId, [sellerId, buyerId]))
    await db.delete(users).where(inArray(users.id, [sellerId, buyerId]))
  }
}

describe('matchListing', () => {
  test('写入匹配与一条通知，收件人是愿望所有者', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      const result = await engine.matchListing(listingId)

      expect(result.skipped).toBeNull()
      expect(result.matched).toBeGreaterThanOrEqual(1)

      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      // 同分类 + 标题含关键词 + 在预算内 → 三个分项都满分（契约 §3.2）。
      expect(rows[0]?.score).toBe(100)
      expect(rows[0]?.categoryScore).toBe(100)
      expect(rows[0]?.keywordScore).toBe(100)
      expect(rows[0]?.priceScore).toBe(100)

      const notes = await matchNotifications(buyerId, wishId)
      expect(notes).toHaveLength(1)
      // payload 必须是 jsonb object 且 `->>'matchId'` 取得到值（jsonParam 的回归点）。
      expect(notes[0]?.payload.matchId).toBe(rows[0]?.id)
    })
  })

  test('重复运行不重复建行或建通知，只覆盖分数', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      await engine.matchListing(listingId)
      // 改价 → priceScore 50（16000 → 30000，2 倍预算 = 40000）→ 总分 85。
      await db.update(listings).set({ priceCents: 30000 }).where(eq(listings.id, listingId))

      const second = await engine.matchListing(listingId)

      expect(second.created).toBe(0)
      expect(second.matched).toBe(1)
      expect(second.downgraded).toBe(0)
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(85)
      expect(rows[0]?.priceScore).toBe(50)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })

  test('分数低于阈值时不落库、不建通知', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 关键词与分类都不命中 → 0.35×0 + 0.35×0 + 0.30×100 = 30。
      const wishId = await createWish(buyerId, `另一个关键词${keyword}`, { category: 'BOOKS' })

      const result = await engine.matchListing(listingId)

      expect(result.skipped).toBeNull()
      expect(result.matched).toBe(0)
      expect(result.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(0)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(0)
    })
  })

  test('候选集排除自己的愿望与超出 2 倍预算的愿望', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 卖家自己的愿望。
      const ownWishId = await createWish(sellerId, keyword)
      // 价格 16000 > 2 × 7000 → 收窄掉。
      const poorWishId = await createWish(buyerId, keyword, { budgetMaxCents: 7000 })

      await engine.matchListing(listingId)

      expect(await matchRows(listingId, ownWishId)).toHaveLength(0)
      expect(await matchRows(listingId, poorWishId)).toHaveLength(0)
    })
  })

  test('商品不是 ACTIVE 或不存在时跳过', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const offlineId = await createListing(sellerId, keyword, { status: 'OFFLINE' })
      await createWish(buyerId, keyword)

      expect(await engine.matchListing(offlineId)).toMatchObject({ skipped: 'target-not-active' })
      expect(await engine.matchListing(newId())).toMatchObject({ skipped: 'target-missing' })
    })
  })

  /**
   * 掉出阈值：改标题后关键词不再命中（分类与价格仍满分）→ 65 分。
   * 这一对仍在本轮收窄候选里，所以**必须**被覆盖成真实分数；否则行里还是 100，
   * 读接口的阈值过滤就永远看不到它（审查发现的 P1）。
   */
  test('改标题后掉出阈值：既有行被覆盖成低分，通知不增加', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)

      await db
        .update(listings)
        .set({ title: `完全无关的标题 ${keyword.replace('qa', 'zz')}` })
        .where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result).toMatchObject({ matched: 0, downgraded: 1 })
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      // 65 = 分类 100 + 关键词 0 + 价格 100；低于阈值 → 读接口不会返回它（§9.7）。
      expect(rows[0]?.score).toBe(65)
      expect(rows[0]?.keywordScore).toBe(0)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })

  /*
   * 可见性与计数必须与读接口的策略一致（方向相关）：
   * wish 侧隐藏 OFFLINE 商品、保留 RESERVED/SOLD（卡片带状态角标）。
   * 这条区分是审查抓到的 P1——引擎曾把"对端 ACTIVE"当成"有效"，于是接口照旧展示
   * RESERVED 的匹配而计数说它无效。
   */
  test('商品转 RESERVED/SOLD 后仍然算"可见"（wish 侧策略），转 OFFLINE 才算不可见', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)

      await db.update(listings).set({ status: 'RESERVED' }).where(eq(listings.id, listingId))
      expect(await engine.matchWish(wishId)).toMatchObject({ matched: 1, downgraded: 0 })
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)

      await db.update(listings).set({ status: 'SOLD' }).where(eq(listings.id, listingId))
      expect(await engine.matchWish(wishId)).toMatchObject({ matched: 1, downgraded: 0 })

      await db.update(listings).set({ status: 'OFFLINE' }).where(eq(listings.id, listingId))
      expect(await engine.matchWish(wishId)).toMatchObject({ matched: 0, downgraded: 1 })
      // 行仍在、分数仍是真实裸分——可见性由读接口的谓词决定，引擎不删行。
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)
    })
  })

  /**
   * 掉出**价格**收窄（`price > 2 × budget_max`）：这一对的裸分恰好是 70
   * （分类 100 + 关键词 100 + 价格 0），所以只按 `score >= 阈值` 判断会把它当成有效匹配——
   * 而新建这种同时对不会建行（候选 SQL 直接排除），于是"新建时不匹配、编辑后却可见"。
   * 修法是重评时也带上收窄判据（审查发现的 P1）。
   */
  test('改价到 2 倍预算以上：既有行被判为无效（裸分 70 不算匹配）', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword, { budgetMaxCents: 20000 })
      await engine.matchListing(listingId)
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)

      // 50000 > 2 × 20000 → 掉出价格收窄。
      await db.update(listings).set({ priceCents: 50000 }).where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result).toMatchObject({ matched: 0, downgraded: 1 })
      const rows = await matchRows(listingId, wishId)
      // 行保留，分数是**真实裸分** 70；读接口靠价格收窄谓词把它挡掉（见 apps/api 的 service.test.ts）。
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(70)
      expect(rows[0]?.priceScore).toBe(0)
      // 已经是既有行，不该再发通知。
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })

  // 计数不变式的边界：在收窄集合内、分数不够、又没有既有行 → 评估了但既不 matched 也不 downgraded。
  test('候选在收窄集合内但分数不够且没有行：matched 与 downgraded 都是 0', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 分类与价格都成立（进得了收窄集合），但关键词一个 token 都不命中 → 65 分，且没有既有行。
      // 注意不能用含空格的 keyword：那是多 token，命中其中一个就会把分数抬过阈值。
      const wishId = await createWish(buyerId, `无关需求${uniqueKeyword()}`)

      const result = await engine.matchListing(listingId)

      // 不用 `toEqual` 断言 `evaluated` 的精确值：候选集是**全库**的，并行跑的其它测试文件
      // （如 apps/api 的 service.test.ts）会临时造出 `category: null ∧ budgetMaxCents: null` 的
      // ACTIVE 愿望，它同样是本 listing 的候选（分数不到阈值，所以不影响其余三个计数）。
      expect(result).toMatchObject({ matched: 0, created: 0, downgraded: 0, skipped: null })
      expect(result.evaluated).toBeGreaterThanOrEqual(1)
      expect(await matchRows(listingId, wishId)).toHaveLength(0)
    })
  })

  /**
   * 掉出**收窄集合**：改分类（DIGITAL → BOOKS）后这对不再被候选 SQL 选中。
   * 只加读接口过滤是不够的——必须把"已有行"也拉进本轮评估，否则旧分数永远留着。
   */
  test('改分类后掉出候选集：既有行同样被重新评估并覆盖', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)

      await db.update(listings).set({ category: 'APPAREL' }).where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result).toMatchObject({ matched: 0, downgraded: 1 })
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(65)
      expect(rows[0]?.categoryScore).toBe(0)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })
})

describe('matchWish', () => {
  test('只匹配在售商品，且不发通知给卖家', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const activeId = await createListing(sellerId, keyword)
      const offlineId = await createListing(sellerId, keyword, { status: 'OFFLINE' })
      const wishId = await createWish(buyerId, keyword)

      const result = await engine.matchWish(wishId)

      expect(result.skipped).toBeNull()
      expect(await matchRows(activeId, wishId)).toHaveLength(1)
      expect(await matchRows(offlineId, wishId)).toHaveLength(0)
      // 通知只给愿望所有者（契约 §3.4）。
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
      expect(await matchNotifications(sellerId, wishId)).toHaveLength(0)
    })
  })

  test('跳过自己发布的商品与非 ACTIVE 的愿望', async () => {
    await withFixture(async ({ buyerId }) => {
      const keyword = uniqueKeyword()
      // 愿望所有者自己发的商品不该匹配到自己的愿望。
      const ownListingId = await createListing(buyerId, keyword)
      const closedWishId = await createWish(buyerId, keyword, { status: 'CLOSED' })

      expect(await engine.matchWish(closedWishId)).toMatchObject({ skipped: 'target-not-active' })

      const activeWishId = await createWish(buyerId, keyword)
      await engine.matchWish(activeWishId)
      expect(await matchRows(ownListingId, activeWishId)).toHaveLength(0)
      expect(await engine.matchWish(newId())).toMatchObject({ skipped: 'target-missing' })
    })
  })

  test('不限分类的愿望按归一化分数匹配', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword, { category: null })

      await engine.matchWish(wishId)

      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      // 分类不参与计分 → 落库的 categoryScore 是 0，总分按剩余两项归一化（契约 §3.2）。
      expect(rows[0]?.categoryScore).toBe(0)
      expect(rows[0]?.score).toBe(100)
    })
  })

  // listing 侧策略与 wish 侧不同：只展示仍 ACTIVE 的（他人的）愿望。
  test('愿望转 CLOSED 后不再"可见"（listing 侧策略）', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)
      expect(await engine.matchListing(listingId)).toMatchObject({ matched: 1, downgraded: 0 })

      await db.update(wishes).set({ status: 'CLOSED' }).where(eq(wishes.id, wishId))

      expect(await engine.matchListing(listingId)).toMatchObject({ matched: 0, downgraded: 1 })
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)
    })
  })

  // 两个方向写的是同一把唯一键（`(listing_id, wish_id)`），所以先 listing 后 wish
  // 不能变成两行 / 两条通知——这是"同一对不重复"的跨方向验证。
  test('两个方向交叉触发同一对：仍只有一行、一条通知', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      const fromListing = await engine.matchListing(listingId)
      const fromWish = await engine.matchWish(wishId)

      expect(fromListing.created).toBe(1)
      expect(fromWish.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(1)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// #322 M2：向量召回
//
// 这些用例**手工插入 `embeddings` 行**做受控 fixture（不经过 provider）：召回只取决于向量本身，
// 用 provider 只会引入不确定性与网络。所有向量的 `content_hash` 都按实体**当前**内容算，
// 否则引擎会判 `stale` 而退化——那正是另一条用例要覆盖的分支。
// ---------------------------------------------------------------------------

/** 第 `axis` 维为 1 的单位向量（float4 往返精确，余弦距离可手算）。 */
function axisVector(axis: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[axis] = 1
  return vector
}

/**
 * 与 `axisVector(0)` 的夹角随 `index` 单调增大的单位向量（距离 = 1 - cos(角度) 也单调增大）。
 * 给 Top-K 造"顺序确定"的候选池时用它：纯正交向量彼此距离都是 1，并列时排序不确定。
 */
function fanVector(index: number): number[] {
  const angle = (index + 1) * 0.01
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[0] = Math.cos(angle)
  vector[1] = Math.sin(angle)
  return vector
}

/**
 * 给商品写一份"与当前内容一致"的向量（model 默认就是引擎在用的那个）。
 *
 * 版本标记默认写实体当前的 `updated_at` ⇒ 引擎认为它**新鲜**；传 `stale: true` 可造
 * "实体编辑后向量还没重算"的 fixture（候选侧的新鲜度检查会把它挡在召回之外）。
 */
async function embedListing(
  listingId: string,
  vector: number[],
  model = TEST_EMBEDDING_MODEL,
  stale = false,
): Promise<void> {
  const row = (await db.select().from(listings).where(eq(listings.id, listingId)).limit(1))[0]
  if (!row) throw new Error('embedListing：商品不存在')
  await saveEmbedding(db, {
    entity: { kind: 'listing', id: listingId },
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: contentHashOf(
      buildListingEmbeddingText({
        title: row.title,
        description: row.description,
        category: row.category,
      }),
    ),
    embedding: vector,
    // 版本取实体**当前**的 `updated_at`：候选侧新鲜度判据要求它相等（毫秒截断比较）。
    // `stale = true` 构造"实体改过、向量还没重算"的候选。
    sourceUpdatedAt: stale ? new Date(row.updatedAt.getTime() - 60_000) : row.updatedAt,
  })
}

/** 给愿望写一份"与当前内容一致"的向量（`stale` 含义同 `embedListing`）。 */
async function embedWish(
  wishId: string,
  vector: number[],
  model = TEST_EMBEDDING_MODEL,
  stale = false,
): Promise<void> {
  const row = (await db.select().from(wishes).where(eq(wishes.id, wishId)).limit(1))[0]
  if (!row) throw new Error('embedWish：愿望不存在')
  await saveEmbedding(db, {
    entity: { kind: 'wish', id: wishId },
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: contentHashOf(
      buildWishEmbeddingText({
        keyword: row.keyword,
        description: row.description,
        category: row.category,
      }),
    ),
    embedding: vector,
    sourceUpdatedAt: stale ? new Date(row.updatedAt.getTime() - 60_000) : row.updatedAt,
  })
}

/** 引擎在目标向量未就绪时补投的 `EMBED_*` job（payload 里只有实体 id）。 */
async function embedJobs(kind: 'listing' | 'wish', id: string) {
  const key = kind === 'listing' ? 'listingId' : 'wishId'
  return db
    .select({ type: jobs.type, status: jobs.status })
    .from(jobs)
    .where(sql`${jobs.payload}->>${sql.raw(`'${key}'`)} = ${id}`)
}

describe('向量召回（#322 M2）', () => {
  test('目标向量就绪：走 vector-topk，语义分参与打分并落库', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0))
      await embedWish(wishId, axisVector(0))

      const result = await engine.matchListing(listingId)

      expect(result.recall).toBe('vector-topk')
      expect(result.fallbackReason).toBeNull()
      // 本 model 的向量只有这一条 ⇒ Top-K 里恰好一个候选。
      expect(result.vectorCandidates).toBe(1)

      // 两侧向量相同（cos = 1 ⇒ 语义分 100），结构三项全中 ⇒ v2 总分仍是 100。
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(100)
      // #322 M3：语义可用时落库 semantic_score + ranking_version = 2（读侧据此区分 v1/v2 行）。
      expect(rows[0]?.semanticScore).toBe(100)
      expect(rows[0]?.rankingVersion).toBe(RANKING_VERSION)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
      // 目标向量新鲜 ⇒ 不需要补投。
      expect(await embedJobs('listing', listingId)).toHaveLength(0)
    })
  })

  test('候选侧没有向量就进不了 Top-K：本轮不新建匹配，也不替候选投递', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      // 只给目标写向量：愿望侧没有 ⇒ 它词法上完全命中，也进不了召回集合。
      await embedListing(listingId, axisVector(0))

      const result = await engine.matchListing(listingId)

      expect(result.recall).toBe('vector-topk')
      expect(result.vectorCandidates).toBe(0)
      expect(result.evaluated).toBe(0)
      expect(result.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(0)
      // 候选缺向量是候选自己的 EMBED job 的事；召回侧不为它排队（否则一次召回会投出上百条 job）。
      expect(await embedJobs('wish', wishId)).toHaveLength(0)
    })
  })

  test('候选向量过期（实体改过、还没重算）不进 Top-K，重算后恢复（#333 复审 blocker）', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0))
      await embedWish(wishId, axisVector(0))

      // 候选实体被编辑（描述变了 ⇒ 已有向量与当前内容不再对应），而 EMBED_WISH 还没跑。
      // 这一版向量不许再进 Top-K：否则它会挤掉新鲜候选，还会被按 id 补算进打分。
      const bumped = new Date(Date.now() + 1000)
      await db
        .update(wishes)
        .set({ description: '编辑后的描述：与旧向量不再对应', updatedAt: bumped })
        .where(eq(wishes.id, wishId))

      const stale = await engine.matchListing(listingId)

      expect(stale.recall).toBe('vector-topk')
      expect(stale.vectorCandidates).toBe(0)
      expect(stale.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(0)

      // 重算向量（handler 把版本推进到实体当前值）后恢复召回。
      await embedWish(wishId, axisVector(0))

      const restored = await engine.matchListing(listingId)

      expect(restored.recall).toBe('vector-topk')
      expect(restored.vectorCandidates).toBe(1)
      expect(restored.created).toBe(1)
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(100)
    })
  })

  test('已有匹配掉出 Top-K：仍被 union 回来重算，旧高分不残留', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0))
      await embedWish(wishId, axisVector(0))

      // 第一轮：双方都有向量且词法命中 → 建行、100 分。
      expect(await engine.matchListing(listingId)).toMatchObject({
        created: 1,
        recall: 'vector-topk',
      })
      expect((await matchRows(listingId, wishId))[0]?.rankingVersion).toBe(RANKING_VERSION)

      // 让这一对掉出召回：删掉愿望的向量（候选侧无向量 ⇒ 不在 Top-K），并把关键词改成不再命中。
      await db.delete(embeddings).where(eq(embeddings.wishId, wishId))
      await db.update(wishes).set({ keyword: '完全无关的词' }).where(eq(wishes.id, wishId))

      const result = await engine.matchListing(listingId)

      expect(result.recall).toBe('vector-topk')
      expect(result.vectorCandidates).toBe(0)
      // 关键：#322 的"评估集合 = 新 Top-K ∪ 已有 matches"——它确实被拉回来评估了。
      expect(result.evaluated).toBe(1)
      expect(result.matched).toBe(0)
      expect(result.downgraded).toBe(1)

      // 旧高分（100）必须被覆盖成真实裸分（35 + 0 + 30 = 65），否则读接口再也挡不住这一行。
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(65)
      expect(rows[0]?.score).toBeLessThan(MATCH_SCORE_THRESHOLD)
      expect(rows[0]?.keywordScore).toBe(0)
      // 这一对拿不到 cosine（候选侧向量已被删除）⇒ 按对退回 v1 口径：语义分落 NULL、版本号 1。
      expect(rows[0]?.semanticScore).toBeNull()
      expect(rows[0]?.rankingVersion).toBe(RANKING_VERSION_V1)
    })
  })

  test('目标缺向量：退化为 v1 全量候选 + 补投 EMBED_* job（两个方向对称）', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      const fromListing = await engine.matchListing(listingId)

      expect(fromListing.recall).toBe('v1-fallback')
      expect(fromListing.fallbackReason).toBe('missing')
      expect(fromListing.vectorCandidates).toBe(0)
      // 退化不改变 v1 的行为：词法命中照样建行、照样发通知。
      expect(fromListing.created).toBe(1)
      expect(await matchRows(listingId, wishId)).toHaveLength(1)
      // 退化 = v1 口径：语义分落 NULL、版本号 1（读侧据此知道这行没有语义分）。
      const fallbackRows = await matchRows(listingId, wishId)
      expect(fallbackRows[0]?.semanticScore).toBeNull()
      expect(fallbackRows[0]?.rankingVersion).toBe(RANKING_VERSION_V1)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
      expect(await embedJobs('listing', listingId)).toEqual([
        { type: 'EMBED_LISTING', status: 'PENDING' },
      ])

      // 愿望方向同构（对称性是 #322 的硬要求）。
      const otherKeyword = uniqueKeyword()
      const listingB = await createListing(sellerId, otherKeyword)
      const wishB = await createWish(buyerId, otherKeyword)

      const fromWish = await engine.matchWish(wishB)

      expect(fromWish.recall).toBe('v1-fallback')
      expect(fromWish.fallbackReason).toBe('missing')
      expect(fromWish.created).toBe(1)
      expect(await matchRows(listingB, wishB)).toHaveLength(1)
      expect(await embedJobs('wish', wishB)).toEqual([{ type: 'EMBED_WISH', status: 'PENDING' }])
    })
  })

  test('目标向量过期（内容变了、指纹没跟上）：判 stale 并退化，不拿旧向量当新内容', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 候选仍然存在（v1 退化要靠它建行）；这里不需要 wishId。
      await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0))
      // 改了内容但不更新向量：指纹与当前内容不一致（EMBED job 还在路上时的真实状态）。
      await db
        .update(listings)
        .set({ title: `改名后的商品 ${keyword}` })
        .where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result.recall).toBe('v1-fallback')
      expect(result.fallbackReason).toBe('stale')
      expect(result.vectorCandidates).toBe(0)
      // 旧向量没被当成新内容的向量用：这一轮是 v1 全量候选（仍然按真实分数建行）。
      expect(result.created).toBe(1)
      expect(await embedJobs('listing', listingId)).toEqual([
        { type: 'EMBED_LISTING', status: 'PENDING' },
      ])
    })
  })

  test('只有别的模型的向量：判 model-mismatch，绝不用另一种模型的向量召回', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0), 'legacy-model-v9')
      await embedWish(wishId, axisVector(0), 'legacy-model-v9')

      const result = await engine.matchListing(listingId)

      expect(result.recall).toBe('v1-fallback')
      // 与 'missing' 区分开：换模型后需要的是 backfill，不是"从没生成过"。
      expect(result.fallbackReason).toBe('model-mismatch')
      expect(result.vectorCandidates).toBe(0)
      // 换模型后要按**当前**模型重建，所以仍然补投。
      expect(await embedJobs('listing', listingId)).toEqual([
        { type: 'EMBED_LISTING', status: 'PENDING' },
      ])
    })
  })

  test('Top-K 的 K 是硬边界：第 K+1 个候选（词法命中的那个）不再被召回', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      await embedListing(listingId, axisVector(0))

      // 造 K+1 个候选：距离随 index 单调增大，最后一个才是词法上完全命中的那个。
      const matchingIndex = MATCH_SEMANTIC_TOP_K
      const wishIds: string[] = []
      for (let index = 0; index <= MATCH_SEMANTIC_TOP_K; index += 1) {
        const id = newId()
        wishIds.push(id)
        await db.insert(wishes).values({
          id,
          userId: buyerId,
          // 只有最后一个与商品标题同词：其余是"只在语义上接近"的候选。
          keyword: index === matchingIndex ? keyword : `${keyword}-${index}`,
          category: ISOLATED_CATEGORY,
          budgetMaxCents: 20000,
        })
        // 用 helper 写向量（按当前内容算指纹 + 版本标记 = 实体当前版本 ⇒ 新鲜）。
        await embedWish(id, fanVector(index))
      }

      const truncated = await engine.matchListing(listingId)

      expect(truncated.recall).toBe('vector-topk')
      // 池子里有 K+1 个，Top-K 只放 K 个进来。
      expect(truncated.vectorCandidates).toBe(MATCH_SEMANTIC_TOP_K)
      // 词法命中的那个恰好是最远的第 K+1 个 ⇒ 被 K 挡住，本轮不新建匹配。
      expect(await matchRows(listingId, wishIds[matchingIndex] as string)).toHaveLength(0)

      // 移掉最近的候选后池子刚好 K 个，它就能进来了——证明"挡住它的确实是 K"，而不是别的条件。
      await db.delete(wishes).where(eq(wishes.id, wishIds[0] as string))

      const fitted = await engine.matchListing(listingId)

      expect(fitted.vectorCandidates).toBe(MATCH_SEMANTIC_TOP_K)
      expect(fitted.created).toBe(1)
      const rows = await matchRows(listingId, wishIds[matchingIndex] as string)
      expect(rows).toHaveLength(1)
      // v2 hybrid 口径（#322 M4 重标定锚点）：这个候选是最远的第 K+1 个（angle = 0.51
      // ⇒ cos ≈ 0.8727 ⇒ 已越过 CEILING 0.70，语义分饱和到 100），分类 / 词法 / 价格全中
      // ⇒ 0.30*100 + 0.32*100 + 0.15*100 + 0.23*100 = 100。
      // 注：M3 的 0.5/0.95 锚点下这里语义分只有 83（总分 95）；0.42/0.70 把 0.87 判为"完全相似"，
      // 这正是 M4 用 57 条实测 cos（真匹配中位 ≈ 0.64）重标定的直接后果。
      expect(rows[0]?.score).toBe(100)
    })
  })
})

// ---------------------------------------------------------------------------
// #322 M3：候选向量新鲜度（PR #338 评审 blocker 的回归）
//
// 评审指出的漏洞：候选实体被编辑后、EMBED_* 还没跑完（或失败）时，旧向量仍会进 Top-K 参与
// hybrid 打分——那是"当前的价格/分类事实 + 旧的语义"的混合版本，还会把过期候选排到新鲜候选
// 前面。修复后的不变量：**只有对应当前实体版本的向量才允许进召回与打分**，证明不了新鲜的一对
// 退回 v1 口径（`ranking_version = 1`、`semantic_score = NULL`）。
// ---------------------------------------------------------------------------
describe('候选向量新鲜度（#322 M3 评审 blocker）', () => {
  test('候选编辑后旧向量不进 Top-K：已有行退回 v1，重算向量后恢复 v2', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0))
      await embedWish(wishId, axisVector(0))

      // 先建立一条 v2 匹配行（两侧向量一致 ⇒ 语义分 100）。
      expect((await engine.matchListing(listingId)).recall).toBe('vector-topk')
      const before = (await matchRows(listingId, wishId))[0]
      expect(before?.rankingVersion).toBe(RANKING_VERSION)
      expect(before?.semanticScore).toBe(100)

      // 编辑候选（愿望）但**不重算向量**：库里那条向量对应的是旧内容，不再是当前版本。
      // `updated_at` 由 `$onUpdate(() => sql`now()`)` 取数据库钟（见 `packages/db/src/schema/common.ts`），
      // 版本必然不小于插入时写入的值，因此不需要在测试里手动推进时间戳。
      await db
        .update(wishes)
        .set({ keyword: `${keyword}-改过` })
        .where(eq(wishes.id, wishId))

      // 从商品方向再跑：目标向量新鲜，但候选的旧向量被新鲜度检查挡住 ⇒ 不进 Top-K（不占 K 名额），
      // 已有行仍被 union 回来重算，只是拿不到 cosine ⇒ 退回 v1 口径。
      const afterEdit = await engine.matchListing(listingId)

      expect(afterEdit.recall).toBe('vector-topk')
      expect(afterEdit.vectorCandidates).toBe(0)
      expect(afterEdit.evaluated).toBe(1)

      const downgraded = (await matchRows(listingId, wishId))[0]
      expect(downgraded?.rankingVersion).toBe(RANKING_VERSION_V1)
      expect(downgraded?.semanticScore).toBeNull()
      // v1 口径的裸分：分类 100 + 关键词 0（关键词已改掉）+ 价格 100 ⇒ 0.35*100 + 0.3*100 = 65。
      expect(downgraded?.score).toBe(65)

      // 重算向量（新内容 + 新版本）之后恢复 v2。
      await embedWish(wishId, axisVector(0))

      const restored = await engine.matchListing(listingId)

      expect(restored.vectorCandidates).toBe(1)
      const fresh = (await matchRows(listingId, wishId))[0]
      expect(fresh?.rankingVersion).toBe(RANKING_VERSION)
      expect(fresh?.semanticScore).toBe(100)
    })
  })

  test('候选编辑后旧向量连"新建"都进不来：重算向量后才建立 v2 匹配', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await embedListing(listingId, axisVector(0))
      // 先写向量、再编辑候选 ⇒ 库里那条向量对应的是旧内容。
      await embedWish(wishId, axisVector(0))
      // 先写向量、再编辑候选 ⇒ 库里那条向量对应的是旧内容。`updated_at` 由数据库钟推进
      // （`$onUpdate(() => sql`now()`)`，见 `packages/db/src/schema/common.ts`）：插入与更新同源，
      // 编辑后的版本一定不小于插入时的值，下面的重算不会被 `saveEmbedding` 的 CAS 静默丢弃。
      await db
        .update(wishes)
        .set({ keyword: `${keyword}-改过` })
        .where(eq(wishes.id, wishId))

      const staleRun = await engine.matchListing(listingId)

      // 没有已有行可 union ⇒ 过期的候选连"新建"的机会都没有（这正是评审要的：旧向量不能参与召回）。
      expect(staleRun.vectorCandidates).toBe(0)
      expect(staleRun.evaluated).toBe(0)
      expect(staleRun.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(0)

      await embedWish(wishId, axisVector(0))

      const freshRun = await engine.matchListing(listingId)

      expect(freshRun.vectorCandidates).toBe(1)
      expect(freshRun.created).toBe(1)
      const rows = await matchRows(listingId, wishId)
      // 结构分：分类 100 + 关键词 0 + 价格 100；语义分 100 ⇒ 0.30*100 + 0.32*100 + 0.23*100 = 85。
      expect(rows[0]?.score).toBe(85)
      expect(rows[0]?.rankingVersion).toBe(RANKING_VERSION)
      expect(rows[0]?.semanticScore).toBe(100)
    })
  })
})
