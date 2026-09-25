import { expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { comments } from '@fish/db/schema/comments'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { inArray } from 'drizzle-orm'
import { createCommentService } from './service'
import { createSqlCommentStore } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlCommentStore(db)

let seq = 0
const uniqueStudentNo = () => `comment-${Date.now()}-${seq++}`

async function createUser(client: Db, nickname: string): Promise<string> {
  const rows = await client
    .insert(users)
    .values({ studentNo: uniqueStudentNo(), passwordHash: 'test-not-a-real-hash', nickname })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

/** 每个用例自建、自清自己的数据（同 listings store.test.ts 的约定）。 */
async function withFixture(
  run: (fixture: { sellerId: string; buyerId: string; listingId: string }) => Promise<void>,
) {
  const sellerId = await createUser(db, '卖家')
  const buyerId = await createUser(db, '买家')
  const id = newId()
  const listingRows = await db
    .insert(listings)
    .values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: '集成测试商品',
      description: '集成测试描述',
      priceCents: 16000,
      category: 'DIGITAL',
      condition: 'GOOD',
    })
    .returning({ id: listings.id })
  const listingId = listingRows[0]?.id
  if (!listingId) throw new Error('insert listings 未返回行')

  try {
    await run({ sellerId, buyerId, listingId })
  } finally {
    // comments 随 listing CASCADE；listing 的外键是 NO ACTION，故先删商品再删用户。
    await db.delete(listings).where(inArray(listings.id, [listingId]))
    await db.delete(users).where(inArray(users.id, [sellerId, buyerId]))
  }
}

test('顶层留言按 (created_at, id) 倒序翻页，同微秒的行不重不漏', async () => {
  await withFixture(async ({ buyerId, listingId }) => {
    // 三条**同一微秒**的留言：少了 id 做 tie-break 就会在翻页边界重复或跳项。
    const sameInstant = new Date('2026-09-12T03:40:10.123456Z')
    const ids = [201, 202, 203].map((n) => `01930000-0000-7000-8000-${String(n).padStart(12, '0')}`)
    for (const id of ids) {
      await db.insert(comments).values({
        id,
        listingId,
        authorId: buyerId,
        parentId: null,
        content: `留言 ${id}`,
        createdAt: sameInstant,
      })
    }

    const first = await store.listTopLevel(listingId, 2, null)
    expect(first).toHaveLength(2)

    const last = first.at(-1)
    if (!last) throw new Error('第一页为空')
    const second = await store.listTopLevel(listingId, 2, {
      createdAt: last.createdAtCursor,
      id: last.id,
    })

    const allIds = [...first, ...second].map((row) => row.id)
    expect(new Set(allIds).size).toBe(allIds.length)
    expect(new Set(allIds)).toEqual(new Set(ids))
  })
})

test('回复只挂在对应父留言下，并按时间正序返回', async () => {
  await withFixture(async ({ sellerId, buyerId, listingId }) => {
    const parentId = await store.insert({
      listingId,
      authorId: buyerId,
      parentId: null,
      content: '顶层',
    })
    const otherParentId = await store.insert({
      listingId,
      authorId: buyerId,
      parentId: null,
      content: '另一条顶层',
    })
    await store.insert({ listingId, authorId: sellerId, parentId, content: '回复一' })

    const replies = await store.listReplies([parentId])
    expect(replies).toHaveLength(1)
    expect(replies[0]?.parentId).toBe(parentId)

    expect(await store.listReplies([otherParentId])).toEqual([])
    expect(await store.listReplies([])).toEqual([])
  })
})

test('isSeller 由服务端按 listing.sellerId 判定，回复继承父留言所属商品', async () => {
  await withFixture(async ({ sellerId, buyerId, listingId }) => {
    const service = createCommentService({ store })

    const created = await service.createComment(buyerId, listingId, { content: '还在吗' })
    expect(created.isSeller).toBe(false)

    const reply = await service.createReply(sellerId, created.id, { content: '还在的' })
    expect(reply.listingId).toBe(listingId)
    expect(reply.isSeller).toBe(true)

    const page = await service.listComments(listingId, { limit: 20 })
    expect(page.items[0]?.id).toBe(created.id)
    expect(page.items[0]?.replies[0]?.isSeller).toBe(true)
  })
})
