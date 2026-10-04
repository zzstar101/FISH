import { describe, expect, test } from 'bun:test'
import { buildListingEmbeddingText, contentHashOf } from '@fish/contracts/embedding/text'
import { createDb, type Db } from '@fish/db/client'
import { findEmbedding, saveEmbedding } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { conversations } from '@fish/db/schema/conversations'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { favorites } from '@fish/db/schema/favorites'
import { idRekeys } from '@fish/db/schema/id-rekeys'
import { jobs } from '@fish/db/schema/jobs'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { messages } from '@fish/db/schema/messages'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { legacyMediaToken } from '../uploads/legacy-url'
import { createListingService, ListingServiceError } from './service'
import type { CreateListingRecord, FeedCursorKey, ListingStore } from './store'
import { createSqlListingStore } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlListingStore(db)

let seq = 0
const uniqueStudentNo = () => `listing-store-${Date.now()}-${seq++}`

async function createUser(client: Db): Promise<string> {
  const rows = await client
    .insert(users)
    .values({
      studentNo: uniqueStudentNo(),
      passwordHash: 'test-not-a-real-hash',
      nickname: '集成测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

function record(
  sellerId: string,
  overrides: Partial<CreateListingRecord> = {},
): CreateListingRecord {
  return {
    id: newId(),
    sellerId,
    title: '集成测试商品',
    description: '集成测试描述',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    urgent: false,
    negotiable: false,
    free: false,
    objectKeys: [`listings/${sellerId}/a.jpg`],
    duplicateWindowStart: new Date(Date.now() - 5_000),
    ...overrides,
  }
}

/** 每个用例自建、自清自己的数据（同 packages/db/src/schema.test.ts 的约定）。 */
async function withSeller(run: (sellerId: string, otherSellerId: string) => Promise<void>) {
  const sellerId = await createUser(db)
  const otherSellerId = await createUser(db)
  const userIds = [sellerId, otherSellerId]

  try {
    await run(sellerId, otherSellerId)
  } finally {
    const owned = await db
      .select({ id: listings.id })
      .from(listings)
      .where(inArray(listings.sellerId, userIds))
    const listingIds = owned.map((row) => row.id)

    if (listingIds.length > 0) {
      // jobs 与 listings 没有外键关系，只能按 payload 清理；
      // 审核记录引用 users（非级联），必须比 users 先删。
      await db.delete(jobs).where(inArray(sql`${jobs.payload}->>'listingId'`, listingIds))
      await db
        .delete(listingModerationRecords)
        .where(inArray(listingModerationRecords.sellerId, userIds))
      await db.delete(listings).where(inArray(listings.id, listingIds))
    }
    // 没有商品的用例（如编辑被阻塞）仍可能留下审核记录：sellerId 引用是 RESTRICT。
    await db
      .delete(listingModerationRecords)
      .where(inArray(listingModerationRecords.sellerId, userIds))
    await db.delete(users).where(inArray(users.id, userIds))
  }
}

async function insertListingWithTime(
  sellerId: string,
  input: { createdAt: Date; priceCents: number; status?: 'ACTIVE' | 'OFFLINE' },
): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title: `分页商品 ${input.priceCents}`,
    description: '分页测试',
    priceCents: input.priceCents,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: input.status ?? 'ACTIVE',
    createdAt: input.createdAt,
  })
  return id
}

test('真实 ID 重键映射允许原商品继续引用旧对象键，不放行其他用户的键', async () => {
  await withSeller(async (sellerId, otherSellerId) => {
    const oldId = crypto.randomUUID()
    const objectKey = `listings/${oldId}/${crypto.randomUUID()}.jpg`
    await db.insert(idRekeys).values({ resourceTable: 'users', oldId, newId: sellerId })
    try {
      const input = record(sellerId, { objectKeys: [objectKey] })
      await store.createListingAtomic(input)
      const service = createListingService({
        store,
        storage: {
          presignPut: () => ({
            url: 'https://upload.test',
            headers: {},
            expiresAt: new Date().toISOString(),
          }),
          stat: async () => ({ size: 100, contentType: 'image/jpeg' }),
          publicUrl: (key) =>
            `https://web.test/api/uploads/legacy/${legacyMediaToken(key, 'test-secret-for-legacy-media-longer-than-32-characters')}`,
        },
      })
      const result = await service.updateListing(sellerId, input.id, {
        title: '保留历史对象的商品',
        objectKeys: [objectKey],
      })
      expect(result.images[0]?.url).toContain('/api/uploads/legacy/')
      expect(result.images[0]?.url).not.toContain(oldId)
      expect(await store.legacyUserIds(sellerId)).toEqual([oldId])
      await expect(
        service.updateListing(otherSellerId, input.id, { objectKeys: [objectKey] }),
      ).rejects.toMatchObject({ code: 'IMAGE_REFERENCE_INVALID' })
    } finally {
      await db
        .delete(idRekeys)
        .where(and(eq(idRekeys.resourceTable, 'users'), eq(idRekeys.oldId, oldId)))
    }
  })
})

test('发布在世界内写入商品、有序图片与 MATCH_LISTING job', async () => {
  await withSeller(async (sellerId) => {
    const input = record(sellerId, {
      objectKeys: [`listings/${sellerId}/a.jpg`, `listings/${sellerId}/b.jpg`],
    })

    const result = await store.createListingAtomic(input)
    expect(result).toEqual({ kind: 'created', listingId: input.id })

    const images = await db
      .select({ objectKey: listingImages.objectKey, sortOrder: listingImages.sortOrder })
      .from(listingImages)
      .where(eq(listingImages.listingId, input.id))
      .orderBy(listingImages.sortOrder)
    expect(images).toEqual([
      { objectKey: `listings/${sellerId}/a.jpg`, sortOrder: 0 },
      { objectKey: `listings/${sellerId}/b.jpg`, sortOrder: 1 },
    ])

    const queued = await db
      .select({ type: jobs.type, payload: jobs.payload, status: jobs.status })
      .from(jobs)
      .where(sql`${jobs.payload}->>'listingId' = ${input.id}`)
      // 用队列自己的领取键排序：`(run_at, id)`（见 `apps/worker/src/jobs/queue.ts` 的 `claimNext`）。
      // 注意它等价的是**入队时刻**的领取序：非致命失败重试或 `kill -9` 回收会把 `run_at` 推后
      // （M4 §6.1 末尾），此后执行序可能反转。
      .orderBy(jobs.runAt, jobs.id)
    // #322 M1：一次成功创建投两条 job——v1 的匹配重算 + 语义向量刷新（成对投递，避免漏掉一边）。
    expect(queued).toHaveLength(2)
    expect(queued.map((job) => job.type).sort()).toEqual(['EMBED_LISTING', 'MATCH_LISTING'])
    expect(queued.every((job) => job.status === 'PENDING')).toBe(true)
    // #322 M4 顺序不变量：EMBED_LISTING 必须在**入队序**里排在 MATCH_LISTING 前面（同事务、run_at
    // 相同，所以首轮领取序 = 入队序）。反序会让首轮 MATCH 跑在向量落库之前，引擎按 M2 降级契约落
    // `ranking_version = 1`。重试/回收会推后 `run_at`，那种反转是已知边界（M4 §6.1 末尾）。
    expect(queued.map((job) => job.type)).toEqual(['EMBED_LISTING', 'MATCH_LISTING'])
  })
})

// ---------------------------------------------------------------------------
// #322 M2 复审 blocker：内容一变就让旧向量当场失效（写路径失效，而不是靠时间戳证明新鲜）
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = 'stub-deterministic-v1'

function unitVector(axis: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === axis ? 1 : 0))
}

/** 实体当前的 `updated_at`：向量行要记的版本号，也是"新鲜"判据的一端。 */
async function currentVersion(listingId: string): Promise<Date> {
  const rows = await db
    .select({ updatedAt: listings.updatedAt })
    .from(listings)
    .where(eq(listings.id, listingId))
  const row = rows[0]
  if (!row) throw new Error('listing 不存在')
  return row.updatedAt
}

test('编辑内容后旧向量当场失效；只改价格不删向量（#333 复审 blocker）', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    const listingId = created.listingId
    const facts = { title: '集成测试商品', description: '集成测试描述', category: 'DIGITAL' }

    await saveEmbedding(db, {
      entity: { kind: 'listing', id: listingId },
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: contentHashOf(buildListingEmbeddingText(facts)),
      embedding: unitVector(0),
      sourceUpdatedAt: await currentVersion(listingId),
    })

    // 改标题 ⇒ 内容指纹变了 ⇒ 写路径在同一事务里删掉旧向量，不取决于 worker 何时跑到 EMBED_LISTING。
    // 这正是"时间戳之外还要内容判据"的落地点：库里此刻不会留下任何描述旧内容的向量。
    const result = await store.updateListingAtomic({
      id: listingId,
      sellerId,
      apply: () => ({ kind: 'write' as const, fields: { title: '改过标题的商品' } }),
    })
    expect(result).toEqual({ kind: 'updated' })
    expect(await findEmbedding(db, { kind: 'listing', id: listingId }, EMBEDDING_MODEL)).toBeNull()

    // 新内容的向量落库后，只改价格（不进 embedding 文本）不该把它删掉：指纹一致 ⇒ EMBED_LISTING
    // 重跑走 unchanged 分支，不重复调用 provider。
    await saveEmbedding(db, {
      entity: { kind: 'listing', id: listingId },
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: contentHashOf(buildListingEmbeddingText({ ...facts, title: '改过标题的商品' })),
      embedding: unitVector(1),
      sourceUpdatedAt: await currentVersion(listingId),
    })

    await store.updateListingAtomic({
      id: listingId,
      sellerId,
      apply: () => ({ kind: 'write' as const, fields: { priceCents: 18800 } }),
    })

    const kept = await findEmbedding(db, { kind: 'listing', id: listingId }, EMBEDDING_MODEL)
    expect(kept?.embedding).toEqual(unitVector(1))
  })
})

test('商品物理删除后编号仍占用，不能指派给新商品', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    const row = (
      await db
        .select({ listingNo: listings.listingNo })
        .from(listings)
        .where(eq(listings.id, created.listingId))
    )[0]
    expect(row?.listingNo?.toString()).toMatch(/^[1-9][0-9]{11}$/)
    const listingNo = row?.listingNo
    if (listingNo === null || listingNo === undefined) throw new Error('未获得商品编号')

    await db.delete(jobs).where(sql`${jobs.payload}->>'listingId' = ${created.listingId}`)
    await db.delete(listings).where(eq(listings.id, created.listingId))
    expect(
      (await db.select().from(listingNumbers).where(eq(listingNumbers.listingNo, listingNo)))[0]
        ?.listingId,
    ).toBe(created.listingId)
    await expect(
      db.insert(listingNumbers).values({ listingNo, listingId: newId() }).execute(),
    ).rejects.toThrow()
  })
})

test('5 秒窗口内的同内容重复提交命中已有商品，不新建也不重复投递', async () => {
  await withSeller(async (sellerId) => {
    const first = await store.createListingAtomic(record(sellerId))
    const second = await store.createListingAtomic(record(sellerId))

    expect(second).toEqual({ kind: 'duplicate', listingId: first.listingId })

    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.sellerId, sellerId))
    expect(rows).toHaveLength(1)

    const queued = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`${jobs.payload}->>'listingId' = ${first.listingId}`)
    // 命中重复窗口时**不投递**：这里的两条仍然只是第一次创建投下的（#322 M1 起 MATCH + EMBED）。
    expect(queued).toHaveLength(2)
  })
})

test('窗口之外的同内容提交是新商品', async () => {
  await withSeller(async (sellerId) => {
    await store.createListingAtomic(record(sellerId, { duplicateWindowStart: new Date(0) }))
    const second = await store.createListingAtomic(
      record(sellerId, { duplicateWindowStart: new Date(Date.now() + 60_000) }),
    )

    expect(second.kind).toBe('created')
    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.sellerId, sellerId))
    expect(rows).toHaveLength(2)
  })
})

test('去重只看同卖家的内容；不同商品名不会互相压制', async () => {
  await withSeller(async (sellerId) => {
    await store.createListingAtomic(record(sellerId, { title: '商品 A' }))
    const other = await store.createListingAtomic(record(sellerId, { title: '商品 B' }))

    expect(other.kind).toBe('created')
  })
})

test('feed 只返回请求的状态，并按 (createdAt, id) 翻页且不重不漏', async () => {
  await withSeller(async (sellerId) => {
    // 同一 createdAt 的三条：专门用来验证 tie-break（少了 id 比较就会跳项或重复）
    const sameTime = new Date('2026-09-12T03:00:00.000Z')
    const ids = [
      await insertListingWithTime(sellerId, { createdAt: sameTime, priceCents: 100 }),
      await insertListingWithTime(sellerId, { createdAt: sameTime, priceCents: 200 }),
      await insertListingWithTime(sellerId, { createdAt: sameTime, priceCents: 300 }),
      await insertListingWithTime(sellerId, {
        createdAt: new Date('2026-09-11T03:00:00.000Z'),
        priceCents: 400,
      }),
    ]
    const offlineId = await insertListingWithTime(sellerId, {
      createdAt: new Date('2026-09-12T04:00:00.000Z'),
      priceCents: 500,
      status: 'OFFLINE',
    })

    const collected: string[] = []
    let cursor: FeedCursorKey | null = null
    for (let page = 0; page < 5; page += 1) {
      const rows = await store.listFeed({
        limit: 2,
        cursor,
        sort: 'newest',
        status: 'ACTIVE',
        sellerId,
      })
      const pageRows = rows.slice(0, 2)
      const boundary = pageRows[1]
      cursor = boundary
        ? { kind: 'newest', createdAt: boundary.createdAtCursor, id: boundary.listing.id }
        : null

      collected.push(...pageRows.map((row) => row.listing.id))
      if (rows.length <= 2) break
    }

    // id DESC 的 tie-break：同 createdAt 的三条按 id 倒序
    expect([...ids].sort().reverse()).toEqual(expect.arrayContaining(collected.slice(0, 3)))
    expect(collected.slice(0, 3)).toEqual([...ids.slice(0, 3)].sort().reverse())
    expect(collected).toHaveLength(4)
    expect(new Set(collected).size).toBe(4)
    expect(collected).not.toContain(offlineId)
  })
})

// 回归：游标过去携带毫秒精度的 ISO 时间（Date.toISOString()），而 created_at 是微秒精度的
// timestamptz。截断后，同一毫秒内排在边界行之后的商品两个比较分支都不成立 → 翻页时永久消失。
// 契约 §2.1 明确承诺"同毫秒不重复、不漏项"。
test('同一毫秒内不同微秒的商品在翻页中不会漏项', async () => {
  await withSeller(async (sellerId) => {
    const newer = await insertListingWithTime(sellerId, {
      createdAt: new Date('2026-09-12T03:00:00.123Z'),
      priceCents: 100,
    })
    const older = await insertListingWithTime(sellerId, {
      createdAt: new Date('2026-09-12T03:00:00.123Z'),
      priceCents: 100,
    })

    // 用 SQL 精确指定微秒：同一毫秒（.123）内的 700µs 与 300µs
    await db.execute(
      sql`update listings set created_at = '2026-09-12T03:00:00.123700Z'::timestamptz where id = ${newer}`,
    )
    await db.execute(
      sql`update listings set created_at = '2026-09-12T03:00:00.123300Z'::timestamptz where id = ${older}`,
    )

    const first = await store.listFeed({
      limit: 1,
      cursor: null,
      sort: 'newest',
      status: 'ACTIVE',
      sellerId,
    })
    const boundary = first[0]
    expect(boundary?.listing.id).toBe(newer)

    const second = await store.listFeed({
      limit: 1,
      cursor: boundary
        ? { kind: 'newest', createdAt: boundary.createdAtCursor, id: boundary.listing.id }
        : null,
      sort: 'newest',
      status: 'ACTIVE',
      sellerId,
    })

    expect(second.map((row) => row.listing.id)).toEqual([older])
  })
})

test('feed 返回的游标时间是微秒精度的 UTC ISO 文本', async () => {
  await withSeller(async (sellerId) => {
    const id = await insertListingWithTime(sellerId, { createdAt: new Date(), priceCents: 100 })
    const rows = await store.listFeed({
      limit: 1,
      cursor: null,
      sort: 'newest',
      status: 'ACTIVE',
      sellerId,
    })

    expect(rows[0]?.listing.id).toBe(id)
    expect(rows[0]?.createdAtCursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })
})

test('feed 的 priceAsc 按价格升序并返回封面', async () => {
  await withSeller(async (sellerId) => {
    const cheap = await insertListingWithTime(sellerId, { createdAt: new Date(), priceCents: 100 })
    const pricey = await insertListingWithTime(sellerId, {
      createdAt: new Date(),
      priceCents: 90000,
    })
    await db
      .insert(listingImages)
      .values({ listingId: cheap, objectKey: 'listings/x/cover.jpg', sortOrder: 0 })

    const rows = await store.listFeed({
      limit: 10,
      cursor: null,
      sort: 'priceAsc',
      status: 'ACTIVE',
      sellerId,
    })

    expect(rows.map((row) => row.listing.id)).toEqual([cheap, pricey])
    expect(rows[0]?.coverObjectKey).toBe('listings/x/cover.jpg')
    expect(rows[1]?.coverObjectKey).toBeNull()
  })
})

// 回归：`q` 里的 `%` / `_` 必须当字面量。否则 `?q=%` 会匹配整张表、
// `?q=a_b` 会把 `_` 当单字符通配 —— 契约 §2.1 写的是"匹配范围"，用户期待字面子串。
test('feed 的搜索把 % / _ / \\ 当字面量而不是通配符', async () => {
  await withSeller(async (sellerId) => {
    const percent = await insertListingWithTime(sellerId, {
      createdAt: new Date(),
      priceCents: 100,
    })
    await db.update(listings).set({ title: '折扣 100% 出' }).where(eq(listings.id, percent))
    const underscore = await insertListingWithTime(sellerId, {
      createdAt: new Date(),
      priceCents: 200,
    })
    await db.update(listings).set({ title: 'a_b 商品' }).where(eq(listings.id, underscore))
    const wildcardMatch = await insertListingWithTime(sellerId, {
      createdAt: new Date(),
      priceCents: 300,
    })
    await db.update(listings).set({ title: 'axb 商品' }).where(eq(listings.id, wildcardMatch))

    const search = async (q: string) =>
      (
        await store.listFeed({
          limit: 10,
          cursor: null,
          sort: 'newest',
          status: 'ACTIVE',
          sellerId,
          search: q,
        })
      ).map((row) => row.listing.id)

    expect(await search('%')).toEqual([percent])
    expect(await search('100%')).toEqual([percent])
    expect(await search('a_b')).toEqual([underscore])
    expect(await search('_')).toEqual([underscore])

    // 反斜杠也必须被转义：否则 `q=\` 会让 pattern 以转义符结尾，PG 直接报
    // "LIKE pattern must not end with escape character" → 500。
    const backslash = await insertListingWithTime(sellerId, {
      createdAt: new Date(),
      priceCents: 400,
    })
    await db.update(listings).set({ title: 'C:\\ 盘符' }).where(eq(listings.id, backslash))
    expect(await search('C:\\')).toEqual([backslash])
    expect(await search('\\')).toEqual([backslash])
  })
})

// 回归：编辑的"状态机"不能只靠 service 读一次（check-then-act）——
// 锁内读到的行已变成 RESERVED / SOLD 时必须回 `locked`，而不是把它改掉。
// 关键差异：判定用的是 `SELECT ... FOR UPDATE` 拿到的**那一行**，不是事务外的首次读。
// 旧实现里首次读与 UPDATE 之间可以变（#11 的交易流程），仍会写入已锁定的行。
test('编辑在 SQL 层拒绝 RESERVED / SOLD 状态的行', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    await db.update(listings).set({ status: 'RESERVED' }).where(eq(listings.id, created.listingId))

    const result = await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      apply: () => ({ kind: 'write' as const, fields: { title: '不该生效' } }),
    })

    expect(result).toEqual({ kind: 'locked' })
    // 行确实没被改：只有 `apply` 产出的字段会被写入，而这里根本没走到写入。
    const rows = await db
      .select({ title: listings.title })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    expect(rows[0]?.title).toBe('集成测试商品')
  })
})

// 回归（评审 blocker 1）：`SELECT ... FOR UPDATE` 让并发审核写入不可能交错。
//
// 复现路径就是评审描述的那个：A 发只改价格的 PATCH，基于旧标题（干净）算出 APPROVED；
// B 同时把标题改成"加微信"算出 REVIEW 并先提交；A 后提交时把 moderation_status
// 写回 APPROVED —— 最终库里出现"待审内容 + APPROVED"。
//
// 旧实现下（无行锁）B 的 UPDATE 会立即完成，然后 A 在 300ms 后盖掉它 → 两个断言都挂。
// 新实现下 A 持锁期间 B 被真阻塞（第二个断言），B 只能在 A 提交后写入 → 最终一定 REVIEW。
test('updateListingAtomic 持锁期间并发写入被阻塞，不会留下待审内容 + APPROVED', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    const other = createDb(databaseUrl)

    let bSettled = false
    let aCommitted = false

    // A：只改价格的 PATCH。像 service 一样把审核结论写进去（此处固定为 APPROVED，
    // 对应"基于旧标题算出来"的那个快照）；锁内停留 300ms，给 B 一个插入窗口。
    const a = store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      apply: async () => {
        await Bun.sleep(300)
        aCommitted = true
        return {
          kind: 'write' as const,
          fields: { priceCents: 30000, moderationStatus: 'APPROVED' },
        }
      },
    })

    // B：把标题改成命中 REVIEW 的词（模拟另一个并发 PATCH 的最终写入）。
    const b = (async () => {
      await Bun.sleep(100)
      const updated = await other
        .update(listings)
        .set({ title: '加微信联系', moderationStatus: 'REVIEW', status: 'OFFLINE' })
        .where(eq(listings.id, created.listingId))
        .returning({ id: listings.id })
      bSettled = true
      return updated
    })()

    // A 仍在锁内（还没提交）时，B 必须被行锁挡住。
    await Bun.sleep(200)
    expect(aCommitted).toBe(false)
    expect(bSettled).toBe(false)

    expect(await a).toEqual({ kind: 'updated' })
    await b

    const rows = await db
      .select({ title: listings.title, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    // 关键断言：不存在"标题 = 加微信联系 但 moderation_status = APPROVED"这一组合。
    expect(rows[0]).toEqual({ title: '加微信联系', moderationStatus: 'REVIEW' })
  })
})

test('编辑图片是全量替换：旧行被删掉而不是追加', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(
      record(sellerId, {
        objectKeys: [`listings/${sellerId}/a.jpg`, `listings/${sellerId}/b.jpg`],
      }),
    )

    const result = await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      objectKeys: [`listings/${sellerId}/c.jpg`],
      apply: () => ({ kind: 'write' as const, fields: { title: '改过的标题' } }),
    })

    expect(result).toEqual({ kind: 'updated' })
    const rows = await db
      .select({ title: listings.title })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    expect(rows[0]?.title).toBe('改过的标题')
    const images = await db
      .select({ objectKey: listingImages.objectKey, sortOrder: listingImages.sortOrder })
      .from(listingImages)
      .where(eq(listingImages.listingId, created.listingId))
    expect(images).toEqual([{ objectKey: `listings/${sellerId}/c.jpg`, sortOrder: 0 }])
  })
})

test('他人不能改自己的商品（SQL 层按 sellerId 约束）', async () => {
  await withSeller(async (sellerId, otherSellerId) => {
    const created = await store.createListingAtomic(record(sellerId))

    const result = await store.updateListingAtomic({
      id: created.listingId,
      sellerId: otherSellerId,
      apply: () => ({ kind: 'write' as const, fields: { title: '越权修改' } }),
    })

    expect(result).toEqual({ kind: 'not-owner' })
  })
})

test('setStatus 只从指定状态迁移，幂等与并发都由它兜底', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))

    expect(await store.setStatus({ id: created.listingId, from: 'OFFLINE', to: 'ACTIVE' })).toBe(
      false,
    )
    expect(await store.setStatus({ id: created.listingId, from: 'ACTIVE', to: 'OFFLINE' })).toBe(
      true,
    )
    expect(await store.setStatus({ id: created.listingId, from: 'ACTIVE', to: 'OFFLINE' })).toBe(
      false,
    )

    const rows = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    expect(rows[0]?.status).toBe('OFFLINE')
  })
})

// 回归（评审 blocker 2）：审核中的商品（REVIEW → OFFLINE）不能被卖家直接重新上架。
// 前置条件必须写在 SQL 的 UPDATE 谓词里，而不是 service 先查一次 —— 否则服务重启/并发
// 下就会出现"商品 ACTIVE 但内容是待审"的状态。
test('REVIEW / BLOCKED 的商品不能迁回 ACTIVE（审核前置条件写在 SQL 谓词里）', async () => {
  await withSeller(async (sellerId) => {
    for (const moderationStatus of ['REVIEW', 'BLOCKED'] as const) {
      const created = await store.createListingAtomic(
        record(sellerId, { moderationStatus: 'REVIEW' }),
      )
      // 构造目标状态：内容待审 + OFFLINE（与 service 的 createListing 一致）。
      await db
        .update(listings)
        .set({ status: 'OFFLINE', moderationStatus })
        .where(eq(listings.id, created.listingId))

      expect(await store.setStatus({ id: created.listingId, from: 'OFFLINE', to: 'ACTIVE' })).toBe(
        false,
      )
      const rows = await db
        .select({ status: listings.status })
        .from(listings)
        .where(eq(listings.id, created.listingId))
      expect(rows[0]?.status).toBe('OFFLINE')

      // 对照：人工审核通过（APPROVED）后就能重新上架。
      await db
        .update(listings)
        .set({ moderationStatus: 'APPROVED' })
        .where(eq(listings.id, created.listingId))
      expect(await store.setStatus({ id: created.listingId, from: 'OFFLINE', to: 'ACTIVE' })).toBe(
        true,
      )
    }
  })
})

// 真库上的端到端：两个并发 PATCH（一个改成 free、一个只改价格）在行锁上被串行化。
//
// 旧实现下两边都基于旧快照通过校验，后写的那一方撞上 DB 的 listings_free_price_cents_zero，
// 只能靠把 PG 错误映射成 422 来兜。新实现把合并校验放在行锁内，所以第二个事务读到的是
// 第一个已提交的结果，service 自己就拒绝（422），不依赖 DB 报错。
//
// 断言与先后顺序无关：无论谁先拿到锁，结果都只能是两种合法终态之一，且绝不能是 500。
test('并发 free / price PATCH 在行锁内被串行化，最终状态满足契约 §7.1', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(
      record(sellerId, { priceCents: 0, free: false }),
    )
    const service = createListingService({
      store,
      storage: {
        presignPut: () => ({
          url: 'https://s3.test/put',
          headers: {},
          expiresAt: '2026-09-12T04:00:00.000Z',
        }),
        stat: async () => ({ size: 1024, contentType: 'image/jpeg' }),
        publicUrl: (key) => `https://cdn.test/${key}`,
      },
    })

    const settled = await Promise.allSettled([
      service.updateListing(sellerId, created.listingId, { free: true }),
      service.updateListing(sellerId, created.listingId, { priceCents: 5000 }),
    ])

    // 恰好一个成功、一个是 422（绝不能是 500：那说明锁内校验没生效、靠 DB 报错兜了底）。
    const fulfilled = settled.filter((item) => item.status === 'fulfilled')
    const rejected = settled.filter((item) => item.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ListingServiceError)
      expect((rejected[0].reason as ListingServiceError).status).toBe(422)
      expect((rejected[0].reason as ListingServiceError).code).toBe('VALIDATION_FAILED')
    }

    // 合法终态只有两种：先改 free（则价格必须仍为 0）或先改价格（则 free 仍为 false）。
    const rows = await db
      .select({ priceCents: listings.priceCents, free: listings.free })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    const row = rows[0]
    expect(row).toBeDefined()
    if (!row) throw new Error('行不存在')
    // 契约 §7.1 的不变量：`free ⟹ priceCents = 0`。
    expect(row.free && row.priceCents !== 0).toBe(false)
    // 合法终态只有两种：先改 free（价格保持 0）或先改价格（free 保持 false）。
    expect([
      [true, 0],
      [false, 5000],
    ]).toContainEqual([row.free, row.priceCents])
  })
})

// 兜底路径：service 的锁内合并校验之外，DB 的 CHECK 报错也必须被映射成 422（而不是 500）。
// 真实触发方式：包一层的 store 在 `apply` 之后、UPDATE 时额外塞进 `free = true`，
// 模拟一个绕过 service 的写入方（契约对它的要求与前者相同）。
test('service 把真库的 free/price CHECK 冲突映射成 422', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(
      record(sellerId, { priceCents: 0, free: false }),
    )

    const racingStore: ListingStore = {
      ...store,
      async updateListingAtomic(input) {
        return db.transaction(async (tx) => {
          const rows = await tx.select().from(listings).where(eq(listings.id, input.id)).limit(1)
          const current = rows[0]
          if (!current) return { kind: 'not-found' as const }
          const plan = await input.apply(input, { ...current, objectKeys: [] })
          if (plan.kind === 'blocked') return { kind: 'rejected' as const }
          // 在计划之外偷偷把 free 改成 true —— service 的合并校验看不到这一步。
          await tx
            .update(listings)
            .set({ ...plan.fields, free: true, updatedAt: new Date() })
            .where(eq(listings.id, input.id))
          return { kind: 'updated' as const }
        })
      },
    }
    const service = createListingService({
      store: racingStore,
      storage: {
        presignPut: () => ({
          url: 'https://s3.test/put',
          headers: {},
          expiresAt: '2026-09-12T04:00:00.000Z',
        }),
        stat: async () => ({ size: 1024, contentType: 'image/jpeg' }),
        publicUrl: (key) => `https://cdn.test/${key}`,
      },
    })

    let thrown: unknown
    try {
      await service.updateListing(sellerId, created.listingId, { priceCents: 5000 })
      throw new Error('期望抛出 ListingServiceError，但没有')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ListingServiceError)
    if (thrown instanceof ListingServiceError) {
      expect(thrown.status).toBe(422)
      expect(thrown.code).toBe('VALIDATION_FAILED')
      expect(thrown.details?.[0]?.field).toBe('priceCents')
    }

    // 事务回滚：价格没有被写入。
    const rows = await db
      .select({ priceCents: listings.priceCents, free: listings.free })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    expect(rows[0]?.priceCents).toBe(0)
  })
})

/**
 * #8 的 job payload 契约是 `z.strictObject({ listingId: z.uuid() })` —— `.strictObject` 意味着
 * 多塞任何字段都会让 worker 判该 job `FAILED`。这里按结构断言（#8 的契约包在另一条分支上，
 * 本分支不引入跨 Issue 的 import）：键恰好一个、值是本商品的 id。
 */
async function matchJobsFor(listingId: string) {
  const rows = await db.execute<{ listingId: string; keys: number }>(sql`
    select payload->>'listingId' as "listingId",
           (select count(*)::int from jsonb_object_keys(payload)) as keys
    from jobs
    where type = 'MATCH_LISTING' and payload->>'listingId' = ${listingId}
  `)
  return rows
}

// 回归：编辑改变打分输入（标题/描述/价格/分类），必须重算匹配；否则 matches 里那一对永远是旧分数。
test('编辑商品后追加一条 MATCH_LISTING job', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    // 创建本身就投了一条
    expect(await matchJobsFor(created.listingId)).toHaveLength(1)

    await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      apply: () => ({ kind: 'write' as const, fields: { priceCents: 30000 } }),
    })

    const jobsAfterEdit = await matchJobsFor(created.listingId)
    expect(jobsAfterEdit).toHaveLength(2)
    // payload 必须恰好是 { listingId }（#8 的 strictObject）
    expect(jobsAfterEdit[0]?.keys).toBe(1)
    expect(jobsAfterEdit[0]?.listingId).toBe(created.listingId)
  })
})

test('下架与重新上架各追加一条 MATCH_LISTING job', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))

    expect(await store.setStatus({ id: created.listingId, from: 'ACTIVE', to: 'OFFLINE' })).toBe(
      true,
    )
    expect(await matchJobsFor(created.listingId)).toHaveLength(2)

    expect(await store.setStatus({ id: created.listingId, from: 'OFFLINE', to: 'ACTIVE' })).toBe(
      true,
    )
    expect(await matchJobsFor(created.listingId)).toHaveLength(3)
  })
})

test('没有真正改到行时不投 job（不存在的、别人的、被锁定的、状态没变的）', async () => {
  await withSeller(async (sellerId, otherSellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    const before = (await matchJobsFor(created.listingId)).length

    // 不存在的商品
    const missingId = newId()
    expect(
      await store.updateListingAtomic({
        id: missingId,
        sellerId,
        apply: () => ({ kind: 'write' as const, fields: { title: '不存在' } }),
      }),
    ).toEqual({ kind: 'not-found' })
    expect(await store.setStatus({ id: missingId, from: 'ACTIVE', to: 'OFFLINE' })).toBe(false)
    // 别人的商品
    await store.updateListingAtomic({
      id: created.listingId,
      sellerId: otherSellerId,
      apply: () => ({ kind: 'write' as const, fields: { title: '越权' } }),
    })
    // 状态谓词不匹配（当前是 ACTIVE，却要求从 OFFLINE 迁走）
    expect(await store.setStatus({ id: created.listingId, from: 'OFFLINE', to: 'ACTIVE' })).toBe(
      false,
    )
    // 被锁定（#11 交易流程写的状态）
    await db.update(listings).set({ status: 'RESERVED' }).where(eq(listings.id, created.listingId))
    await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      apply: () => ({ kind: 'write' as const, fields: { title: '锁定后编辑' } }),
    })
    await store.setStatus({ id: created.listingId, from: 'ACTIVE', to: 'OFFLINE' })

    expect(await matchJobsFor(created.listingId)).toHaveLength(before)
  })
})

/**
 * §7.13 要求"投递与写入**同一事务**"，但只断言"job 多了一条"是发现不了违反的：
 * 把投递挪到事务提交之后，那些用例照样绿。这里真造一次 job 写入失败（触发器按 payload 拦下），
 * 断言**商品也没有被改** —— 只有同事务才可能。
 */
test('job 写入失败时商品改动一起回滚（投递确实在同一事务里）', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId, { priceCents: 16000 }))

    // 只拦这一个商品的 job，不影响并行执行的其它测试文件。
    // 必须用 sql.raw 内联 id：函数体是 dollar-quoted 字符串，绑定参数在 PG 解析时无法定类型
    // （`42P18 could not determine data type of parameter $1`）。id 是本用例 newId() 生成的 UUID。
    await db.execute(
      sql.raw(`
      create or replace function fish_test_block_job() returns trigger as $$
      begin
        if new.payload->>'listingId' = '${created.listingId}' then
          raise exception 'job blocked by test';
        end if;
        return new;
      end $$ language plpgsql
    `),
    )
    await db.execute(
      sql`create trigger fish_test_block_job before insert on jobs for each row execute function fish_test_block_job()`,
    )

    try {
      await expect(
        store.updateListingAtomic({
          id: created.listingId,
          sellerId,
          apply: () => ({ kind: 'write' as const, fields: { priceCents: 30000 } }),
        }),
      ).rejects.toThrow()

      const rows = await db
        .select({ priceCents: listings.priceCents })
        .from(listings)
        .where(eq(listings.id, created.listingId))
      expect(rows[0]?.priceCents).toBe(16000)
    } finally {
      await db.execute(sql`drop trigger if exists fish_test_block_job on jobs`)
      await db.execute(sql`drop function if exists fish_test_block_job()`)
    }
  })
})

test('重复投递在商品被删除后仍能写入（重投递不依赖商品存在）', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    await db
      .delete(listings)
      .where(and(eq(listings.id, created.listingId), eq(listings.sellerId, sellerId)))

    await store.enqueueMatchJob(created.listingId)

    const queued = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`${jobs.payload}->>'listingId' = ${created.listingId}`)
    expect(queued.length).toBeGreaterThanOrEqual(1)
  })
})

/**
 * 回归（评审 F-B）：审核记录的 jsonb 数组必须是**真数组**，不能是「JSON 字符串套 JSON」。
 *
 * 裸数组在 drizzle + bun-sql 下会被 stringify 两次（见 `@fish/db/json`）；读路径会 parse 两次
 * 而「看起来正常」，所以只有**在 SQL 层做 containment / 长度查询**才能发现。验收标准
 * 「审核结果持久化，可由 moderation store 查询供 #73 接入」正是要求这一点可用。
 */
test('审核记录写入的 matched_rules 是 jsonb 数组，可在 SQL 层做 @> 与长度查询', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(
      record(sellerId, {
        moderationStatus: 'REVIEW',
        moderation: {
          decision: 'REVIEW',
          matchedRules: ['EXTERNAL_CONTACT'],
          matchedTermsMasked: ['加*信'],
          ruleVersion: 'test-v1',
          provider: 'LOCAL',
          providerRequestId: null,
          suggestion: 'Review',
          label: null,
          subLabel: 'EXTERNAL_CONTACT',
          score: null,
        },
      }),
    )

    const rows = await db.execute<{
      typeof: string
      len: number
      contains: boolean
      masked: string
    }>(sql`
      SELECT jsonb_typeof(matched_rules) AS "typeof",
             jsonb_array_length(matched_rules) AS len,
             (matched_rules @> '["EXTERNAL_CONTACT"]'::jsonb) AS contains,
             jsonb_array_length(matched_terms_masked) AS masked
      FROM listing_moderation_records
      WHERE listing_id = ${created.listingId}
    `)

    // 旧实现下这里全是 'string' / 报错 / false。
    expect(rows[0]?.typeof).toBe('array')
    expect(rows[0]?.len).toBe(1)
    expect(rows[0]?.contains).toBe(true)
    expect(rows[0]?.masked).toBe(1)
  })
})

/**
 * 回归（评审 F-B 的对象分支）：job payload 也必须仍是 jsonb **object**。
 * `jsonParam` 改成 `::text::jsonb` 后容易写坏这一支，而 #8 的 worker 全靠 `payload->>'listingId'`。
 */
test('job payload 仍是 jsonb object（jsonParam 改造后的回归）', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    const rows = await db.execute<{ typeof: string; listingId: string }>(sql`
      SELECT jsonb_typeof(payload) AS "typeof", payload->>'listingId' AS "listingId"
      FROM jobs WHERE payload->>'listingId' = ${created.listingId}
    `)
    expect(rows[0]?.typeof).toBe('object')
    expect(rows[0]?.listingId).toBe(created.listingId)
  })
})

/**
 * 回归（评审 F-C）：`blocked` 计划必须由 store 在**锁内事务**里写审计，且商品不被改动。
 *
 * 旧实现让 `apply` 返回 null 回滚事务、再由 service 在事务外补写审计 —— 锁已释放，
 * 记录的 titleSnapshot 可能与被拒内容不一致，中途失败还会静默丢审计行。
 * 这里断言：审计行带着**锁内读到并合并后**的内容落库，商品保持原样。
 */
test('BLOCK 计划在锁内写审计且不改商品', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId, { title: '原标题' }))

    const result = await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      apply: () => ({
        kind: 'blocked' as const,
        moderation: {
          title: '原标题 加微信',
          description: '描述',
          decision: 'BLOCK',
          matchedRules: ['EXTERNAL_CONTACT'],
          matchedTermsMasked: ['加*信'],
          ruleVersion: 'test-v1',
          provider: 'LOCAL',
          providerRequestId: null,
          suggestion: 'Block',
          label: null,
          subLabel: 'EXTERNAL_CONTACT',
          score: null,
        },
      }),
    })

    expect(result).toEqual({ kind: 'rejected' })

    // 商品没被改。
    const rows = await db
      .select({ title: listings.title })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    expect(rows[0]?.title).toBe('原标题')

    // 审计行落了库，且快照 = 被拒内容。
    const audit = await db
      .select({
        decision: listingModerationRecords.decision,
        title: listingModerationRecords.titleSnapshot,
        rules: listingModerationRecords.matchedRules,
      })
      .from(listingModerationRecords)
      .where(eq(listingModerationRecords.listingId, created.listingId))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.decision).toBe('BLOCK')
    expect(audit[0]?.title).toBe('原标题 加微信')
    expect(audit[0]?.rules).toEqual(['EXTERNAL_CONTACT'])
  })
})

/**
 * 回归（评审 F-A）：卖家查自己的商品且**不传 status** 时必须能看到非 ACTIVE 的行。
 *
 * REVIEW 会被写成 `status = 'OFFLINE'`，而前端「我发布的」正是 `?sellerId=me`（不带 status）。
 * 旧实现把缺省 status 硬编码为 ACTIVE，于是「F4：本人查询包含未审核商品」只解除了 moderation
 * 过滤、行仍被 status 过滤掉 —— 功能等于没生效（真库实测可见条数为 0）。
 */
test('本人不传 status 时返回全部状态（含 OFFLINE 的 REVIEW 行）；公开查询仍只看 ACTIVE', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    await db
      .update(listings)
      .set({ status: 'OFFLINE', moderationStatus: 'REVIEW' })
      .where(eq(listings.id, created.listingId))

    // 走 service（而不是直接调 store）：F-A 的缺陷在 service 把缺省 status 钉成 ACTIVE，
    // 只有经 service 的请求形状才能复现，直接调 store 会因为「不传 status 就不过滤」而假绿。
    const service = createListingService({
      store,
      storage: {
        presignPut: () => ({
          url: 'https://s3.test/put',
          headers: {},
          expiresAt: '2026-09-12T04:00:00.000Z',
        }),
        stat: async () => ({ size: 1024, contentType: 'image/jpeg' }),
        publicUrl: (key) => `https://cdn.test/${key}`,
      },
    })

    // 前端「我发布的」的真实请求形状：带 sellerId、**不带 status**。
    const own = await service.listFeed(sellerId, { sellerId, sort: 'newest', limit: 20 })
    expect(own.items.map((item) => item.id)).toContain(
      encodePublicId(PUBLIC_ID_PREFIX.listing, created.listingId),
    )

    // 公开 Feed：同样不带 status，但看不见审核中的商品。
    const publicFeed = await service.listFeed(null, { sort: 'newest', limit: 20 })
    expect(publicFeed.items.map((item) => item.id)).not.toContain(
      encodePublicId(PUBLIC_ID_PREFIX.listing, created.listingId),
    )
  })
})

describe('deleteListingAtomic（不过审商品的物理删除）', () => {
  /** 直插一条指定状态 / 审核态的商品（不走 service：这里测的就是 store 的删除口径）。 */
  async function insertListing(
    sellerId: string,
    input: { status: 'ACTIVE' | 'OFFLINE'; moderationStatus: 'APPROVED' | 'BLOCKED' | 'REVIEW' },
  ): Promise<string> {
    const id = newId()
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: '待删除商品',
      description: '删除测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: input.status,
      moderationStatus: input.moderationStatus,
    })
    return id
  }

  test('删除不过审商品时同事务清掉收藏与会话（含消息），商品行消失', async () => {
    await withSeller(async (sellerId, otherSellerId) => {
      const listingId = await insertListing(sellerId, {
        status: 'OFFLINE',
        moderationStatus: 'BLOCKED',
      })
      // otherSellerId 兼任买家（会话 CHECK 只要求 buyer ≠ seller）
      await db.insert(favorites).values({ userId: otherSellerId, listingId })
      const conversationId = newId()
      await db.insert(conversations).values({
        id: conversationId,
        listingId,
        buyerId: otherSellerId,
        sellerId,
      })
      await db.insert(messages).values({
        conversationId,
        senderId: otherSellerId,
        type: 'TEXT',
        content: '还想看看这个',
      })

      await expect(store.deleteListingAtomic({ id: listingId, sellerId })).resolves.toEqual({
        kind: 'deleted',
      })

      // 商品行没了；NO ACTION 的两张表被显式清掉（messages 随 conversations 级联）
      expect(await store.findState(listingId)).toBeNull()
      expect(
        await db
          .select({ id: favorites.userId })
          .from(favorites)
          .where(eq(favorites.listingId, listingId)),
      ).toEqual([])
      expect(
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.listingId, listingId)),
      ).toEqual([])
      expect(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, conversationId)),
      ).toEqual([])
    })
  })

  test('审核中 / 已下架 / 在售状态一律拒绝删除，行保持原样', async () => {
    await withSeller(async (sellerId) => {
      const cases = [
        { status: 'ACTIVE', moderationStatus: 'APPROVED' },
        { status: 'OFFLINE', moderationStatus: 'APPROVED' },
        { status: 'OFFLINE', moderationStatus: 'REVIEW' },
      ] as const
      for (const item of cases) {
        const listingId = await insertListing(sellerId, item)
        await expect(store.deleteListingAtomic({ id: listingId, sellerId })).resolves.toEqual({
          kind: 'not-deletable',
        })
        // 拒绝必须是「什么都没动」，不是删了一半
        expect(await store.findState(listingId)).not.toBeNull()
      }
    })
  })

  /*
   * 治理下架在库里与「审核引擎 / 人工终审的 BLOCKED」**形态完全相同**
   * （`status = OFFLINE` + `moderation_status = BLOCKED`，见 `governance/service.ts` 的 delist），
   * 唯一的分辨依据是 `governance_delisted_at`。这一档是删除判据里唯一额外读的列，
   * 少了它，卖家就能把自己被平台下架的商品当作「不过审」一键清除，把治理证据抹掉。
   */
  test('治理下架的 BLOCKED 商品拒绝删除：与「不过审」同形，靠 governance_delisted_at 分开', async () => {
    await withSeller(async (sellerId) => {
      const listingId = await insertListing(sellerId, {
        status: 'OFFLINE',
        moderationStatus: 'BLOCKED',
      })
      // 模拟治理 delist 的写法（只补这一列，其余形态与上面那条完全相同）
      await db
        .update(listings)
        .set({ governanceDelistedAt: new Date() })
        .where(eq(listings.id, listingId))

      await expect(store.deleteListingAtomic({ id: listingId, sellerId })).resolves.toEqual({
        kind: 'not-deletable',
      })
      expect(await store.findState(listingId)).not.toBeNull()

      // 反证：清掉治理标记后同一条商品变得可删 —— 证明拒绝确实来自那一列，而不是别的条件
      await db
        .update(listings)
        .set({ governanceDelistedAt: null })
        .where(eq(listings.id, listingId))
      await expect(store.deleteListingAtomic({ id: listingId, sellerId })).resolves.toEqual({
        kind: 'deleted',
      })
    })
  })

  test('带交易记录的不过审商品拒绝删除；交易清掉后才能删', async () => {
    await withSeller(async (sellerId, otherSellerId) => {
      const listingId = await insertListing(sellerId, {
        status: 'OFFLINE',
        moderationStatus: 'BLOCKED',
      })
      // 曾经在售过：留了一笔已取消的交易
      await db.insert(transactions).values({
        listingId,
        buyerId: otherSellerId,
        sellerId,
        amountCents: 900,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      })

      await expect(store.deleteListingAtomic({ id: listingId, sellerId })).resolves.toEqual({
        kind: 'not-deletable',
      })
      expect(await store.findState(listingId)).not.toBeNull()

      // 凭证消失（测试收尾自己清，不能留给 withSeller 的 listings 清理撞外键）
      await db.delete(transactions).where(eq(transactions.listingId, listingId))
      await expect(store.deleteListingAtomic({ id: listingId, sellerId })).resolves.toEqual({
        kind: 'deleted',
      })
      expect(await store.findState(listingId)).toBeNull()
    })
  })

  test('别人的商品回 not-owner，不存在的 id 回 not-found', async () => {
    await withSeller(async (sellerId, otherSellerId) => {
      const listingId = await insertListing(sellerId, {
        status: 'OFFLINE',
        moderationStatus: 'BLOCKED',
      })

      await expect(
        store.deleteListingAtomic({ id: listingId, sellerId: otherSellerId }),
      ).resolves.toEqual({ kind: 'not-owner' })
      expect(await store.findState(listingId)).not.toBeNull()

      await expect(store.deleteListingAtomic({ id: newId(), sellerId })).resolves.toEqual({
        kind: 'not-found',
      })
    })
  })
})

/**
 * #228：UPDATE 的文本审核在**事务外**完成，锁内必须拿 `expected` 复核同一份内容。
 * 这里断言两件事：内容没变才写；内容变过返回 `conflict` 且**一个字节都不写**（含审计行）。
 */
test('updateListingAtomic 用 expected 做 CAS：内容变过就 conflict 且不写库', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    const moderation = {
      title: '集成测试商品',
      description: '集成测试描述',
      decision: 'ALLOW' as const,
      matchedRules: [],
      matchedTermsMasked: [],
      ruleVersion: 'biz-228',
      provider: 'TENCENT_TMS',
      providerRequestId: 'req-1',
      suggestion: 'Pass',
      label: null,
      subLabel: null,
      score: null,
    }
    // `record()` 默认带一张图：CAS 比对的是**图片组**，expected 必须用同一组键。
    const expected = {
      title: '集成测试商品',
      description: '集成测试描述',
      moderationStatus: 'APPROVED' as const,
      objectKeys: [`listings/${sellerId}/a.jpg`],
    }

    const written = await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      expected,
      apply: () => ({ kind: 'write', fields: { title: '改过标题的商品' }, moderation }),
    })
    expect(written.kind).toBe('updated')

    // provider 元数据真的落库了（#228 §6），且能在 SQL 层按列查询。
    const rows = await db.execute<{
      provider: string
      requestId: string
      suggestion: string
      ruleVersion: string
    }>(sql`
      SELECT provider,
             provider_request_id AS "requestId",
             suggestion,
             rule_version AS "ruleVersion"
      FROM listing_moderation_records
      WHERE listing_id = ${created.listingId}
    `)
    expect(rows[0]).toMatchObject({
      provider: 'TENCENT_TMS',
      requestId: 'req-1',
      suggestion: 'Pass',
      ruleVersion: 'biz-228',
    })

    // expected 已经落后（标题被上一步改掉）→ CAS 失败：商品与审计都不动。
    const stale = await store.updateListingAtomic({
      id: created.listingId,
      sellerId,
      expected,
      apply: () => ({ kind: 'write', fields: { title: '不该写进去的标题' }, moderation }),
    })
    expect(stale.kind).toBe('conflict')

    const after = await db
      .select({ title: listings.title })
      .from(listings)
      .where(eq(listings.id, created.listingId))
    expect(after[0]?.title).toBe('改过标题的商品')
    const count = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM listing_moderation_records WHERE listing_id = ${created.listingId}
    `)
    expect(count[0]?.n).toBe('1')
  })
})

/**
 * `findCardsByIds` 是 #323 R4 推荐 Feed 新增的读路径：排序结果的顺序由推荐层给出，商品层
 * 只负责"给我这几件的卡片"。它同时是**可见性的最后一道闸**——候选集与真正发出去的卡片之间
 * 隔着排序耗时，这中间商品可能已被下架、被审核拦下或被治理下架。
 */
describe('findCardsByIds（#323 R4 按 id 取卡的读路径）', () => {
  async function insertListing(
    sellerId: string,
    input: {
      status?: 'ACTIVE' | 'OFFLINE'
      moderationStatus?: 'APPROVED' | 'BLOCKED' | 'REVIEW'
      governanceDelistedAt?: Date | null
    } = {},
  ): Promise<string> {
    const id = newId()
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: '按 id 取卡商品',
      description: '推荐读路径测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: input.status ?? 'ACTIVE',
      moderationStatus: input.moderationStatus ?? 'APPROVED',
      ...(input.governanceDelistedAt === undefined
        ? {}
        : { governanceDelistedAt: input.governanceDelistedAt }),
    })
    return id
  }

  test('只回可见商品：下架 / 未过审 / 治理下架 / 不存在 的 id 全部被跳过', async () => {
    await withSeller(async (sellerId) => {
      const visible = await insertListing(sellerId)
      const offline = await insertListing(sellerId, { status: 'OFFLINE' })
      const blocked = await insertListing(sellerId, { moderationStatus: 'BLOCKED' })
      const review = await insertListing(sellerId, { moderationStatus: 'REVIEW' })
      const delisted = await insertListing(sellerId, {
        moderationStatus: 'BLOCKED',
        governanceDelistedAt: new Date(),
      })

      const entries = await store.findCardsByIds(
        [visible, offline, blocked, review, delisted, newId()],
        { viewerUserId: null },
      )

      // 一次查询就把六种形态判完：调用方（推荐 service）据此把不可见的商品从快照里剔除、
      // 让后续 position 顺延 —— 漏一种形态就会发出"服务端认为不可见"的卡片。
      expect(entries.map((entry) => entry.listing.id)).toEqual([visible])
    })
  })

  test('浏览者视角排除自己的商品（与公开 Feed 同一口径）', async () => {
    await withSeller(async (sellerId, otherSellerId) => {
      const mine = await insertListing(sellerId)
      const theirs = await insertListing(otherSellerId)

      const asSeller = await store.findCardsByIds([mine, theirs], { viewerUserId: sellerId })
      expect(asSeller.map((entry) => entry.listing.id)).toEqual([theirs])

      const anonymous = await store.findCardsByIds([mine, theirs], { viewerUserId: null })
      expect(anonymous.map((entry) => entry.listing.id).sort()).toEqual([mine, theirs].sort())
    })
  })

  test('回带卡片投影需要的卖家公开字段与封面键', async () => {
    await withSeller(async (sellerId) => {
      const input = record(sellerId, { objectKeys: [`listings/${sellerId}/cover.jpg`] })
      await store.createListingAtomic(input)

      const [entry] = await store.findCardsByIds([input.id], { viewerUserId: null })
      expect(entry?.listing.title).toBe('集成测试商品')
      expect(entry?.seller.id).toBe(sellerId)
      expect(entry?.seller.nickname).toBe('集成测试')
      expect(entry?.coverObjectKey).toBe(`listings/${sellerId}/cover.jpg`)
      // 游标键也要有：卡片投影之外，列表读路径复用同一个 `FeedEntry` 形状。
      expect(typeof entry?.createdAtCursor).toBe('string')
    })
  })

  test('空 id 列表直接回空数组（不为了让 SQL 报错而发一次 in () 查询）', async () => {
    expect(await store.findCardsByIds([], { viewerUserId: null })).toEqual([])
  })
})

/*
 * 想要数（`ListingCardSchema.wants`）= 与该商品已建立会话的买家数（#74 口径）。
 * 这条链路横跨四个读路径（feed / 按 id 取卡 / 详情 / 其它域的卡片投影），而它们
 * 各自在 SQL 里塞一个 `listingWantsCount` 子查询 —— 漏一处不会报错，只会让那个页面
 * 上的数字悄悄变成 0。所以这里用真实会话行把它钉死。
 */
describe('想要数（已建会话的买家数）', () => {
  /**
   * 本组自建自清的夹具。**不复用 `withSeller`**：它只按卖家清商品，而 `conversations`
   * 对 `listings` 是 NO ACTION（会话是有价值的数据，不随商品连坐），本组的会话行会挡住
   * 商品删除。所以这里按「会话 → 商品 → 用户」的顺序显式清。
   */
  async function withBuyers(
    run: (ids: { sellerId: string; buyerA: string; buyerB: string }) => Promise<void>,
  ) {
    const sellerId = await createUser(db)
    const buyerA = await createUser(db)
    const buyerB = await createUser(db)
    const userIds = [sellerId, buyerA, buyerB]
    try {
      await run({ sellerId, buyerA, buyerB })
    } finally {
      const owned = await db
        .select({ id: listings.id })
        .from(listings)
        .where(inArray(listings.sellerId, userIds))
      const listingIds = owned.map((row) => row.id)
      if (listingIds.length > 0) {
        await db.delete(conversations).where(inArray(conversations.listingId, listingIds))
        await db.delete(listings).where(inArray(listings.id, listingIds))
      }
      await db.delete(users).where(inArray(users.id, userIds))
    }
  }

  /** 直插一条在售商品（不走 service：本组测的是读路径的计数，不是发布流程）。 */
  async function insertActiveListing(sellerId: string): Promise<string> {
    const id = newId()
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: '想要数测试商品',
      description: '想要数',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
    })
    return id
  }

  async function addConversation(listingId: string, sellerId: string, buyerId: string) {
    await db.insert(conversations).values({ id: newId(), listingId, buyerId, sellerId })
  }

  test('三个读路径都算出会话买家数；没有会话的商品是 0（不是「没查」）', async () => {
    await withBuyers(async ({ sellerId, buyerA, buyerB }) => {
      const listingId = await insertActiveListing(sellerId)
      const untouched = await insertActiveListing(sellerId)
      await addConversation(listingId, sellerId, buyerA)
      await addConversation(listingId, sellerId, buyerB)

      const feed = await store.listFeed({
        limit: 10,
        cursor: null,
        sort: 'newest',
        status: 'ACTIVE',
      })
      const wantsOfFeed = (id: string) => feed.find((entry) => entry.listing.id === id)?.wants
      const [fromIds] = await store.findCardsByIds([listingId], { viewerUserId: null })
      const detail = await store.findDetail(listingId)

      expect(wantsOfFeed(listingId)).toBe(2)
      expect(fromIds?.wants).toBe(2)
      expect(detail?.wants).toBe(2)

      // 一件谁都没聊过的商品必须是 0 —— 这一条正是「计数没查」与「确实没人想要」的分界，
      // 契约把 `wants` 定成必填非空就是为了让两者在页面上不再长得一样。
      expect(wantsOfFeed(untouched)).toBe(0)
      expect((await store.findDetail(untouched))?.wants).toBe(0)
    })
  })

  test('同一买家对同一商品只算一次（(listing, buyer) 唯一）', async () => {
    await withBuyers(async ({ sellerId, buyerA }) => {
      const listingId = await insertActiveListing(sellerId)
      await addConversation(listingId, sellerId, buyerA)
      // 唯一索引挡第二次插入；这里断言的是计数口径本身（`count(*)` 数行，不是数消息）。
      await db
        .insert(conversations)
        .values({ id: newId(), listingId, buyerId: buyerA, sellerId })
        .onConflictDoNothing()

      expect((await store.findDetail(listingId))?.wants).toBe(1)
    })
  })
})
