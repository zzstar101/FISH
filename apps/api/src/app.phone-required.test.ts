import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

/**
 * #514 验收：发布商品 / 重新上架 / 发布求购前必须已绑定手机号。
 * 走真实装配（`createApp` + 真实 `requireAuth` 读出的 `me.phoneBound`），而不是 router 替身。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_phone_required_app_test_${process.pid}`
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
  // stub 传输：`POST /auth/phone/bind` 的 code 即 11 位号码
  app = createApp(
    { ...loadServerEnv(), DATABASE_URL: scratchUrl },
    undefined,
    undefined,
    undefined,
    {
      transport: 'stub',
    },
  )
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const post = (body: unknown, cookie: string) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

async function registerUser(): Promise<string> {
  const response = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentNo: '202100009901',
      password: 'fish123456',
      nickname: '绑号验收',
    }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  return cookie
}

const wishBody = {
  keyword: '台灯',
  category: 'DIGITAL',
  budgetMinCents: 1000,
  budgetMaxCents: 5000,
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

describe('发布前必须绑定手机号（#514）', () => {
  test('未绑定 403 PHONE_REQUIRED → 同一会话绑定后放行', async () => {
    const cookie = await registerUser()
    const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, Bun.randomUUIDv7())

    const createListing = await app.request(
      '/listings',
      post(
        {
          title: '护眼台灯',
          description: '用了一学期',
          priceCents: 3000,
          category: 'DIGITAL',
          condition: 'GOOD',
          objectKeys: ['listings/x/a.jpg'],
        },
        cookie,
      ),
    )
    expect(createListing.status).toBe(403)
    expect(await errorCode(createListing)).toBe('PHONE_REQUIRED')

    const online = await app.request(`/listings/${listingId}/online`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(online.status).toBe(403)
    expect(await errorCode(online)).toBe('PHONE_REQUIRED')

    const createWish = await app.request('/wishes', post(wishBody, cookie))
    expect(createWish.status).toBe(403)
    expect(await errorCode(createWish)).toBe('PHONE_REQUIRED')

    const bind = await app.request('/auth/phone/bind', post({ code: '19900009901' }, cookie))
    expect(bind.status).toBe(200)

    // 同一会话、不重新登录：门禁每次都读 requireAuth 新查出的 me，绑定立即生效
    expect((await app.request('/wishes', post(wishBody, cookie))).status).toBe(201)
    // 商品的 201 需要真实上传的图片（core-smoke 覆盖）；这里只证明请求已越过门禁，到达参数校验
    const afterBind = await app.request('/listings', post({}, cookie))
    expect(afterBind.status).toBe(422)
    expect(await errorCode(afterBind)).toBe('VALIDATION_FAILED')
  })
})
