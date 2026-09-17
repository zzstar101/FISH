import { expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { users } from '@fish/db/schema/users'
import { and, eq, inArray, sql } from 'drizzle-orm'
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
    expect(queued).toHaveLength(1)
    expect(queued[0]?.type).toBe('MATCH_LISTING')
    expect(queued[0]?.status).toBe('PENDING')
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
    expect(queued).toHaveLength(1)
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
      apply: () => ({ fields: { title: '不该生效' } }),
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
        return { fields: { priceCents: 30000, moderationStatus: 'APPROVED' } }
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
      apply: () => ({ fields: { title: '改过的标题' } }),
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
      apply: () => ({ fields: { title: '越权修改' } }),
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
          const plan = await input.apply(input, current)
          if (!plan) return { kind: 'rejected' as const, current }
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
      apply: () => ({ fields: { priceCents: 30000 } }),
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
        apply: () => ({ fields: { title: '不存在' } }),
      }),
    ).toEqual({ kind: 'not-found' })
    expect(await store.setStatus({ id: missingId, from: 'ACTIVE', to: 'OFFLINE' })).toBe(false)
    // 别人的商品
    await store.updateListingAtomic({
      id: created.listingId,
      sellerId: otherSellerId,
      apply: () => ({ fields: { title: '越权' } }),
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
      apply: () => ({ fields: { title: '锁定后编辑' } }),
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
          apply: () => ({ fields: { priceCents: 30000 } }),
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
