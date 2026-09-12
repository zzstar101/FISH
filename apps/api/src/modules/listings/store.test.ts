import { expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { CreateListingRecord, FeedCursorKey } from './store'
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
      // jobs 与 listings 没有外键关系，只能按 payload 清理
      await db.delete(jobs).where(inArray(sql`${jobs.payload}->>'listingId'`, listingIds))
      await db.delete(listings).where(inArray(listings.id, listingIds))
    }
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
// UPDATE 必须自带 status 谓词，否则并发变成 RESERVED 的行仍会被改掉。
test('编辑在 SQL 层拒绝 RESERVED / SOLD 状态的行', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(record(sellerId))
    await db.update(listings).set({ status: 'RESERVED' }).where(eq(listings.id, created.listingId))

    const updated = await store.updateListing({
      id: created.listingId,
      sellerId,
      fields: { title: '不该生效' },
    })

    expect(updated).toBeNull()
  })
})

test('编辑图片是全量替换：旧行被删掉而不是追加', async () => {
  await withSeller(async (sellerId) => {
    const created = await store.createListingAtomic(
      record(sellerId, {
        objectKeys: [`listings/${sellerId}/a.jpg`, `listings/${sellerId}/b.jpg`],
      }),
    )

    const updated = await store.updateListing({
      id: created.listingId,
      sellerId,
      fields: { title: '改过的标题' },
      objectKeys: [`listings/${sellerId}/c.jpg`],
    })

    expect(updated?.title).toBe('改过的标题')
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

    const updated = await store.updateListing({
      id: created.listingId,
      sellerId: otherSellerId,
      fields: { title: '越权修改' },
    })

    expect(updated).toBeNull()
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
