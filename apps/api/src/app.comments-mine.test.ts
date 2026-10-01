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

  test('删顶层留言回报真实条数（含被级联删掉的回复）', async () => {
    const cookie = await signUp()
    const topId = (async () => {
      const response = await app.request(
        `/listings/${listingPublicId}/comments`,
        json({ content: '顶层留言' }, cookie),
      )
      return ((await response.json()) as { id: string }).id
    })()
    const parentId = await topId
    await app.request(`/comments/${parentId}/replies`, json({ content: '第一条回复' }, cookie))
    await app.request(`/comments/${parentId}/replies`, json({ content: '第二条回复' }, cookie))

    expect((await listMine(cookie)).body.total).toBe(3)

    const removed = await app.request(`/comments/${parentId}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    // 1 条父留言 + 2 条被级联删掉的回复：端上据此正确减计数，而不是本地假设「少一条」。
    expect(await removed.json()).toEqual({ deleted: 3 })
    expect((await listMine(cookie)).body.total).toBe(0)
  })

  test('别人的留言删不掉：404 同码，不泄漏存在性', async () => {
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
