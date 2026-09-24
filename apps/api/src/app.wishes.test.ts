import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { createDb, type Db } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
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

/** 与 auth router.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_wishes_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
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
  headers: {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
})

async function registerUser(serial: string): Promise<string> {
  const response = await app.request(
    '/auth/register',
    post({
      studentNo: `2021000000${serial}`,
      password: PASSWORD,
      nickname: `验收用户${serial}`,
    }),
  )
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  return cookie
}

function jobsRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

async function createWish(cookie: string): Promise<WishDto> {
  const response = await app.request(
    '/wishes',
    post(
      {
        keyword: '机械键盘',
        category: 'DIGITAL',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
        acceptSimilar: true,
      },
      cookie,
    ),
  )
  expect(response.status).toBe(201)
  return (await response.json()) as WishDto
}

describe('wishes API wiring (#7)', () => {
  test('unauthenticated requests are rejected instead of reaching the router', async () => {
    const response = await app.request('/wishes')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })

    // 身份只认会话：伪造请求头不得被信任
    const forged = await app.request('/wishes', {
      headers: { 'x-user-id': '00000000-0000-0000-0000-000000000000' },
    })
    expect(forged.status).toBe(401)
  })

  test('create writes a PENDING MATCH_WISH job for the created wish', async () => {
    const cookie = await registerUser('01')
    const wish = await createWish(cookie)

    const jobs = jobsRows(
      await db.execute(sql`
        SELECT type, status, payload FROM jobs WHERE payload->>'wishId' = ${wish.id}
      `),
    )

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'MATCH_WISH',
      status: 'PENDING',
      payload: { wishId: wish.id },
    })
  })

  test('owner can read/update/close; another user only gets 403', async () => {
    const ownerCookie = await registerUser('02')
    const otherCookie = await registerUser('03')
    const wish = await createWish(ownerCookie)

    expect(
      (await app.request(`/wishes/${wish.id}`, { headers: { cookie: otherCookie } })).status,
    ).toBe(403)
    expect(
      (
        await app.request(`/wishes/${wish.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: otherCookie },
          body: JSON.stringify({ keyword: '被改写的愿望' }),
        })
      ).status,
    ).toBe(403)
    expect((await app.request(`/wishes/${wish.id}/fulfill`, post({}, otherCookie))).status).toBe(
      403,
    )

    const detail = await app.request(`/wishes/${wish.id}`, { headers: { cookie: ownerCookie } })
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as WishDto).userId).toBe(wish.userId)

    const patch = await app.request(`/wishes/${wish.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ budgetMaxCents: 30000 }),
    })
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as WishDto).budgetMaxCents).toBe(30000)

    const close = await app.request(`/wishes/${wish.id}/close`, post({}, ownerCookie))
    expect(close.status).toBe(200)
    expect(((await close.json()) as WishDto).status).toBe('CLOSED')

    const list = await app.request('/wishes', { headers: { cookie: ownerCookie } })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ total: 1 })
  })

  // #43：`/wishes` 是本域唯一的挂载点（与 listings / matches 同为根级）。
  // #52 曾并存一个 `/api/wishes` 过渡别名（当时 `WISH_ROUTES.base` 还是浏览器路径语义），
  // 随 `WISH_ROUTES` 收敛到根级（#53）已删除。给正典路径留 router 级覆盖：
  // 否则它只有需要 Docker 的 core-smoke 盖得到，CI 拦不住。
  test('wishes router is mounted at the root-level /wishes path', async () => {
    const cookie = await registerUser('04')

    const created = await app.request(
      '/wishes',
      post(
        {
          keyword: '网络摄像头',
          category: 'DIGITAL',
          budgetMinCents: 5000,
          budgetMaxCents: 20000,
          acceptSimilar: true,
        },
        cookie,
      ),
    )
    expect(created.status).toBe(201)
    const wish = (await created.json()) as WishDto
    expect(wish.keyword).toBe('网络摄像头')

    // 读路径也在同一个 router 上（同一个 store / service，而不是两份各自缓存的需求池）。
    const detail = await app.request(`/wishes/${wish.id}`, { headers: { cookie } })
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as WishDto).id).toBe(wish.id)

    // 未挂载会是 404，而不是认证失败。
    expect((await app.request('/wishes')).status).toBe(401)

    // 过渡别名已删除：重新引入会立刻撞上这条断言（它当初只为 #53 的迁移期存在）。
    expect((await app.request('/api/wishes')).status).toBe(404)
  })

  // 放在最后：需求池服务内有 60s 缓存，必须是本文件第一次、且数据已就绪时调用
  test('pool returns k-anonymous aggregates over HTTP without any user identity', async () => {
    for (const serial of ['05', '06', '07', '08']) {
      const cookie = await registerUser(serial)
      await createWish(cookie)
    }
    const cookie = await registerUser('09')

    const response = await app.request('/wishes/pool', { headers: { cookie } })
    expect(response.status).toBe(200)

    const raw = await response.text()
    expect(raw).not.toContain('userId')
    expect(raw).not.toContain('wishId')

    const body = JSON.parse(raw) as { items: Record<string, unknown>[] }
    const item = body.items.find((entry) => entry.keyword === '机械键盘')
    expect(item).toBeDefined()
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'category',
      'keyword',
      'medianBudgetCents',
      'wantCount',
    ])
  })
})
