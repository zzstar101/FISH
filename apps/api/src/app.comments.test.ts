import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { loadServerEnv } from '@fish/shared/env'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.wishes.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_comments_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  // 上一次崩溃的运行可能留下同名库（名称带 pid，正常不会撞），先清再建，
  // 让重跑不会在 beforeAll 直接失败。
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const PASSWORD = 'fish123456'

const post = (body: unknown, cookie?: string) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})

async function registerUser(serial: string): Promise<{ id: string; cookie: string }> {
  const response = await app.request(
    '/auth/register',
    post({
      studentNo: `2021000000${serial}`,
      password: PASSWORD,
      nickname: `留言验收${serial}`,
      campus: '肇庆',
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  return { id: body.user.id, cookie }
}

async function createListing(sellerId: string): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    sellerId,
    title: '留言接线验收商品',
    description: '留言接线验收',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  return id
}

/**
 * 这条覆盖的是**真实 app.ts 的挂载**：router 级用例自己重搭了一个父 app，
 * 盖不到「挂在了 `/`」「POST 路由确实挂了 requireAuth」这两点（与 app.wishes.test.ts 同一动机）。
 */
describe('comments API wiring (#111)', () => {
  test('GET is anonymous; writes are 401 without a session', async () => {
    const listingId = await createListing((await registerUser('01')).id)

    const anonRead = await app.request(`/listings/${listingId}/comments`)
    expect(anonRead.status).toBe(200)
    expect(await anonRead.json()).toEqual({ items: [], nextCursor: null })

    const anonCreate = await app.request(
      `/listings/${listingId}/comments`,
      post({ content: '还在吗' }),
    )
    expect(anonCreate.status).toBe(401)
    expect(await anonCreate.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })

    // 回复路由的 requireAuth 也要杆住：漏挂时上面那条读接口仍然 200，单靠它拦不住。
    const anonReply = await app.request(`/comments/${newId()}/replies`, post({ content: '还在吗' }))
    expect(anonReply.status).toBe(401)
    expect(await anonReply.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  test('non-uuid listing id is 404, not a 500 from the uuid column', async () => {
    const response = await app.request('/listings/not-a-uuid/comments')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'LISTING_NOT_FOUND' } })
  })

  test('comment then reply round-trips through the real store, with server-side isSeller', async () => {
    const seller = await registerUser('02')
    const buyer = await registerUser('03')
    const listingId = await createListing(seller.id)

    const created = await app.request(
      `/listings/${listingId}/comments`,
      post({ content: '还在吗？' }, buyer.cookie),
    )
    expect(created.status).toBe(201)
    const comment = (await created.json()) as { id: string; isSeller: boolean }
    expect(comment.isSeller).toBe(false)

    const replied = await app.request(
      `/comments/${comment.id}/replies`,
      post({ content: '在的' }, seller.cookie),
    )
    expect(replied.status).toBe(201)
    expect(((await replied.json()) as { isSeller: boolean }).isSeller).toBe(true)

    const list = await app.request(`/listings/${listingId}/comments`)
    expect(await list.json()).toMatchObject({
      items: [{ id: comment.id, isSeller: false, replies: [{ isSeller: true }] }],
      nextCursor: null,
    })
  })
})
