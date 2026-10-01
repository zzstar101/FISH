import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.wishes.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_comments_mine_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

const listingId = '01990000-0000-7000-8000-0000000000c1'
/** 路由参数与响应里的商品 id 都是**公开 ID**（`lst_…`）；内部 uuid 只用于建数据。 */
const listingPublicId = encodePublicId(PUBLIC_ID_PREFIX.listing, listingId)
const sellerId = '01990000-0000-7000-8000-0000000000c9'

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  await db.execute(sql`
    INSERT INTO users (id, student_no, password_hash, nickname)
    VALUES (${sellerId}, ${`cmtapp${process.pid}`}, 'test-hash', '留言验收卖家')
  `)
  const listingNo = await reserveTestListingNo(db, listingId)
  await db.execute(sql`
    INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listingId}, ${listingNo}, ${sellerId}, '商品', '描述', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

let serial = 0

/** 走真实注册拿会话 cookie：证明的是 app 级接线，而不是 router 的单测。 */
async function signUp(): Promise<string> {
  const studentNo = `2021${String(process.pid % 10000).padStart(4, '0')}${String(serial++).padStart(4, '0')}`
  const response = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentNo, password: 'fish123456', nickname: '留言验收' }),
  })
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

const json = (body: unknown, cookie?: string) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})

async function listMine(cookie: string) {
  const response = await app.request('/me/comments', { headers: { cookie } })
  return {
    status: response.status,
    body: (await response.json()) as {
      items: {
        comment: { id: string; listingId: string; parentId: string | null }
        listing: { id: string; moderationStatus: string | null }
      }[]
      nextCursor: string | null
      total: number
    },
  }
}

describe('app 级接线：本人留言两条路径都要求登录', () => {
  test('匿名 GET /me/comments 与 DELETE /comments/:id 都 401 UNAUTHENTICATED', async () => {
    for (const [method, path] of [
      ['GET', '/me/comments'],
      ['DELETE', '/comments/cmt_01jc000000e00800000000000x'],
    ] as const) {
      const response = await app.request(path, { method })
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      )
    }
  })
})

describe('app 级接线：本人留言读 + 删除', () => {
  test('空态 → 发一条 → 出现在本人列表并带商品卡片 → 删除 → 回到空态', async () => {
    const cookie = await signUp()

    const before = await listMine(cookie)
    expect(before.status).toBe(200)
    expect(before.body).toEqual({ items: [], nextCursor: null, total: 0 })

    const created = await app.request(
      `/listings/${listingPublicId}/comments`,
      json({ content: '还在吗？' }, cookie),
    )
    expect(created.status).toBe(201)

    const after = await listMine(cookie)
    expect(after.body.total).toBe(1)
    expect(after.body.items).toHaveLength(1)
    const item = after.body.items[0]
    // 内嵌商品卡片（公开投影：审核态不透出），端上不必逐条回查详情
    expect(item?.listing.id).toBe(listingPublicId)
    expect(item?.listing.moderationStatus).toBeNull()
    // 卖家公开子集（#191）：卡片必须带 seller，端上才能直接渲染卖家而不再回查。
    // 只允许四个公开字段 —— 多一个就是学号 / 密码哈希 / 邮箱从卡片往外漏。
    const cardSeller = item?.listing.seller
    expect(cardSeller?.id.startsWith('usr_')).toBe(true)
    expect(cardSeller?.nickname).toBe('留言验收卖家')
    expect(cardSeller?.avatarUrl).toBeNull()
    expect(Object.keys(cardSeller ?? {}).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'nickname',
    ])
    expect(item?.comment.listingId).toBe(listingPublicId)
    expect(item?.comment.parentId).toBeNull()

    const commentId = item?.comment.id
    if (!commentId) throw new Error('列表里没有留言 id')

    const removed = await app.request(`/comments/${commentId}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ deleted: 1 })

    expect((await listMine(cookie)).body.total).toBe(0)

    // 重复删除幂等：不是错误，也不假装删掉了东西。
    const again = await app.request(`/comments/${commentId}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ deleted: 0 })
  })

  test('删顶层留言：`deleted` 是 DB 行数（含他人回复），不参与「我的留言」总数', async () => {
    const cookie = await signUp()
    const other = await signUp()

    const top = (await (
      await app.request(
        `/listings/${listingPublicId}/comments`,
        json({ content: '顶层留言' }, cookie),
      )
    ).json()) as { id: string }
    await app.request(`/comments/${top.id}/replies`, json({ content: '我自己的回复' }, cookie))
    // 别人的回复：级联删除会连它一起删掉。它**不计入我的总数**，但计入**对方**的总数
    // —— 回复也属于作者自己的留言列表。
    await app.request(`/comments/${top.id}/replies`, json({ content: '别人的回复' }, other))

    // 我的总数 = 顶层 1 + 我自己的回复 1 = 2；对方的总数 = 他写的那条回复 = 1。
    expect((await listMine(cookie)).body.total).toBe(2)
    expect((await listMine(other)).body.total).toBe(1)

    const removed = await app.request(`/comments/${top.id}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    // DB 行数：1 条父留言 + 2 条回复（其中一条是别人的）。
    expect(await removed.json()).toEqual({ deleted: 3 })
    // 而我的总数只减 2 —— 端上**不能**拿 `deleted` 去减，否则会漂成负数。
    expect((await listMine(cookie)).body.total).toBe(0)
    // 跨账号影响是**真实存在**的：级联把别人写的回复也删了，对方的总数同样从 1 掉到 0。
    // 这是「删自己的留言会连带影响别人的列表」这个语义的固定点，如实断言，不用注释带过。
    expect((await listMine(other)).body.total).toBe(0)
  })

  test('分页完整性：逐页拉到 nextCursor 为 null，各页互不相交且并集等于全量', async () => {
    const cookie = await signUp()
    for (let i = 0; i < 5; i += 1) {
      await app.request(
        `/listings/${listingPublicId}/comments`,
        json({ content: `留言 ${i}` }, cookie),
      )
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page += 1) {
      const url = `/me/comments?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      const response = await app.request(url, { headers: { cookie } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        items: { comment: { id: string } }[]
        nextCursor: string | null
        total: number
      }
      expect(body.total).toBe(5)
      for (const item of body.items) seen.push(item.comment.id)
      cursor = body.nextCursor
      if (cursor === null) break
    }

    // 不重不漏：5 条各自恰好出现一次，且页码收敛（nextCursor 最终为 null）。
    expect(cursor).toBeNull()
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  test('别人的留言删不掉：404（语义是「存在但不是本人的」，不是「不存在」）', async () => {
    const owner = await signUp()
    const intruder = await signUp()
    const created = await app.request(
      `/listings/${listingPublicId}/comments`,
      json({ content: '我的留言' }, owner),
    )
    const commentId = ((await created.json()) as { id: string }).id

    const denied = await app.request(`/comments/${commentId}`, {
      method: 'DELETE',
      headers: { cookie: intruder },
    })
    expect(denied.status).toBe(404)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'COMMENT_NOT_FOUND',
    )
    // 原留言还在：越权尝试没有产生任何副作用。
    expect((await listMine(owner)).body.total).toBe(1)
    await app.request(`/comments/${commentId}`, { method: 'DELETE', headers: { cookie: owner } })
  })

  test('非法游标与越权参数：422', async () => {
    const cookie = await signUp()
    for (const query of ['cursor=garbage', 'limit=51', 'authorId=usr_01jc000000e00800000000000a']) {
      const response = await app.request(`/me/comments?${query}`, { headers: { cookie } })
      expect(response.status).toBe(422)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    }
  })

  test('只看得到自己的留言（跨账号无泄漏）', async () => {
    const a = await signUp()
    const b = await signUp()
    await app.request(`/listings/${listingPublicId}/comments`, json({ content: 'A 的留言' }, a))

    expect((await listMine(a)).body.total).toBe(1)
    expect((await listMine(b)).body.total).toBe(0)
  })
})
