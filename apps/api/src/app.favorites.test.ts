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
const scratchDatabase = `fish_favorites_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

const listingId = '01990000-0000-7000-8000-0000000000b1'
const listingPublicId = encodePublicId(PUBLIC_ID_PREFIX.listing, listingId)
const missingPublicId = encodePublicId(
  PUBLIC_ID_PREFIX.listing,
  '01990000-0000-7000-8000-0000000000ff',
)
const relation = (id: string) => `/listings/${id}/favorite`

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  const sellerId = '01990000-0000-7000-8000-0000000000a9'
  await db.execute(sql`
    INSERT INTO users (id, student_no, password_hash, nickname)
    VALUES (${sellerId}, ${`favapp${process.pid}`}, 'test-hash', '收藏验收卖家')
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

/** 走真实注册拿会话 cookie：证明的是 app 级接线，而不是 router 的单测。 */
let signUpSerial = 0

async function signUp(): Promise<string> {
  // 学号在库里唯一：每个用例都要一个新账号，否则第二次注册会撞唯一约束。
  // pid 段必须补足 4 位：`StudentNoSchema` 是 `/^\d{12}$/`，pid 只有 3 位时整串会少一位 → 422。
  const studentNo = `2021${String(process.pid % 10000).padStart(4, '0')}${String(signUpSerial++).padStart(4, '0')}`
  const response = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentNo, password: 'fish123456', nickname: '收藏验收' }),
  })
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

describe('app 级接线：收藏两条路径都要求登录', () => {
  test('匿名访问四条路由都 401 UNAUTHENTICATED（证明路径挂对了、requireAuth 生效）', async () => {
    for (const [method, path] of [
      ['GET', '/me/favorites'],
      ['GET', relation(listingPublicId)],
      ['POST', relation(listingPublicId)],
      ['DELETE', relation(listingPublicId)],
    ] as const) {
      const response = await app.request(path, { method })
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      )
    }
  })
})

describe('app 级接线：收藏完整链路', () => {
  test('收藏 → 列表 → 读状态 → 取消，且重复操作幂等', async () => {
    const cookie = await signUp()

    const before = (await (await app.request('/me/favorites', { headers: { cookie } })).json()) as {
      total: number
    }
    expect(before.total).toBe(0)

    for (const _ of [1, 2]) {
      const added = await app.request(relation(listingPublicId), {
        method: 'POST',
        headers: { cookie },
      })
      expect(added.status).toBe(200)
      expect(await added.json()).toEqual({ favorited: true })
    }

    const listed = (await (await app.request('/me/favorites', { headers: { cookie } })).json()) as {
      items: { listing: { id: string; moderationStatus: string | null } }[]
      total: number
      nextCursor: string | null
    }
    // 重复收藏只留一行：total 仍是 1，不是 2。
    expect(listed.total).toBe(1)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.listing.id).toBe(listingPublicId)
    // 公开投影：收藏者不是卖家，审核态不透出。
    expect(listed.items[0]?.listing.moderationStatus).toBeNull()

    const state = await app.request(relation(listingPublicId), { headers: { cookie } })
    expect(await state.json()).toEqual({ favorited: true })

    for (const _ of [1, 2]) {
      const removed = await app.request(relation(listingPublicId), {
        method: 'DELETE',
        headers: { cookie },
      })
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ favorited: false })
    }

    const after = (await (await app.request('/me/favorites', { headers: { cookie } })).json()) as {
      total: number
    }
    expect(after.total).toBe(0)
  })

  test('收藏不存在的商品 404 LISTING_NOT_FOUND；取消它仍然 200（无条件幂等）', async () => {
    const cookie = await signUp()

    const added = await app.request(relation(missingPublicId), {
      method: 'POST',
      headers: { cookie },
    })
    expect(added.status).toBe(404)
    expect(((await added.json()) as { error: { code: string } }).error.code).toBe(
      'LISTING_NOT_FOUND',
    )

    const removed = await app.request(relation(missingPublicId), {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ favorited: false })
  })

  test('非法商品 id 与不存在同码 404', async () => {
    const cookie = await signUp()
    const response = await app.request('/listings/not-a-listing-id/favorite', {
      method: 'POST',
      headers: { cookie },
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'LISTING_NOT_FOUND',
    )
  })

  test('商品售出后：读得到状态、也取消得掉（失效条目不能只能进不能出）', async () => {
    // 回归用例：曾把「收藏」那条 ACTIVE 判据套到读状态与取消上，结果 SOLD 商品的详情页
    // （公开可读）读不到收藏态、列表里的失效条目也取消不掉。
    const cookie = await signUp()
    await app.request(relation(listingPublicId), { method: 'POST', headers: { cookie } })

    await db.execute(sql`UPDATE listings SET status = 'SOLD' WHERE id = ${listingId}`)
    try {
      const state = await app.request(relation(listingPublicId), { headers: { cookie } })
      expect(state.status).toBe(200)
      expect(await state.json()).toEqual({ favorited: true })

      const removed = await app.request(relation(listingPublicId), {
        method: 'DELETE',
        headers: { cookie },
      })
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ favorited: false })
    } finally {
      await db.execute(sql`UPDATE listings SET status = 'ACTIVE' WHERE id = ${listingId}`)
    }
  })
})
