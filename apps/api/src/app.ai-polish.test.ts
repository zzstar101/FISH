import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { aiPolishRequests } from '@fish/db/schema/ai-polish-requests'
import { loadServerEnv } from '@fish/shared/env'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createAiPolishStub } from '../scripts/ai-polish-stub'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.comments.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_ai_polish_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const stub = createAiPolishStub()
let db: Db
let app: ReturnType<typeof createApp>
/** 上游指向一个没人监听的端口：用来验证 502 而不是 500。 */
let deadUpstreamApp: ReturnType<typeof createApp>
/** 起在本套件里的 stub 服务，`afterAll` 必须停掉（同 realtime / marketplace-flow 的约定）。 */
let stubServer: ReturnType<typeof Bun.serve> | undefined

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  const server = Bun.serve({ port: 0, fetch: stub.fetch })
  stubServer = server
  const env = { ...loadServerEnv(), DATABASE_URL: scratchUrl }

  app = createApp(env, undefined, undefined, {
    transport: 'stub',
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  deadUpstreamApp = createApp(env, undefined, undefined, {
    transport: 'stub',
    baseUrl: 'http://127.0.0.1:1',
  })
})

afterAll(async () => {
  // `?.` 兜住"beforeAll 中途失败、还没赋值"的情况——裸写 `stop` 会抛 TypeError 把真因盖掉。
  try {
    stubServer?.stop(true)
  } catch (error) {
    console.error('[ai-polish] 关闭 stub 服务失败', error)
  }
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

let serial = 0
async function registerUser(): Promise<{ id: string; cookie: string }> {
  serial += 1
  const response = await app.request(
    '/auth/register',
    post({
      studentNo: `2021000000${String(serial).padStart(2, '0')}`,
      password: PASSWORD,
      nickname: `润色验收${serial}`,
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

const BODY = {
  title: '罗技 K380 键盘',
  description: '九成新，自用一年，联系 13812345678 详聊',
  category: 'DIGITAL',
}

async function rowsOf(userId: string) {
  return db.select().from(aiPolishRequests).where(eq(aiPolishRequests.userId, userId))
}

describe('POST /ai/polish-candidates 接线验收', () => {
  test('未登录 401，不给匿名者烧配额', async () => {
    const response = await app.request('/ai/polish-candidates', post(BODY))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: '请先登录' },
    })
  })

  test('stub 端到端：脏候选被三层过滤，只剩一条且标记已回填', async () => {
    const user = await registerUser()
    const response = await app.request('/ai/polish-candidates', post(BODY, user.cookie))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      provider: string
      redacted: boolean
      candidates: { id: string; text: string }[]
    }

    expect(body.provider).toBe('stub')
    expect(body.redacted).toBe(true)
    // stub 故意返回三条：超长那条与"原价 88888 元"那条都必须被丢掉。
    expect(body.candidates).toHaveLength(1)
    expect(body.candidates[0]?.id).toBe('candidate-1')
    // 回填把用户自己的号码还给他；送上游的那份不含号码。
    expect(body.candidates[0]?.text).toBe('九成新，自用一年，联系 13812345678 详聊，校内自提优先')
    expect(stub.received.at(-1)?.messages?.[1]?.content).not.toContain('13812345678')
    expect(stub.received.at(-1)?.messages?.[1]?.content).toContain('[fish-phone-1]')

    const rows = await rowsOf(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('OK')
    expect(rows[0]?.candidateCount).toBe(1)
    expect(rows[0]?.filteredCount).toBe(2)
    expect(rows[0]?.promptVersion).toBeTruthy()
    // 表里绝不存用户文本（设计 §6.2）。
    const serialized = JSON.stringify(rows[0])
    expect(serialized).not.toContain('九成新')
    expect(serialized).not.toContain('13812345678')
  })

  test('长描述（494~500 字）在 stub 下仍返回候选：第一条候选不会因拼后缀越过 500', async () => {
    // 另两条候选（'长'*501、带 88888 的那条）必被丢，所以这条守住的是"干净候选不能自己超长"。
    const user = await registerUser()
    const description = '啊'.repeat(495)

    const response = await app.request(
      '/ai/polish-candidates',
      post({ ...BODY, description }, user.cookie),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { candidates: { text: string }[] }
    expect(body.candidates).toHaveLength(1)
    expect(body.candidates[0]?.text).toBe(description)

    const rows = await rowsOf(user.id)
    expect(rows[0]?.filteredCount).toBe(2)
  })

  test('参数不合法一律 422：空描述、超 500、多余字段、非法分类', async () => {
    const user = await registerUser()
    const cases = [
      { ...BODY, description: '   ' },
      { ...BODY, description: '啊'.repeat(501) },
      { ...BODY, extra: '不该被接受' },
      { ...BODY, category: 'NOT_A_CATEGORY' },
    ]

    for (const body of cases) {
      const response = await app.request('/ai/polish-candidates', post(body, user.cookie))
      expect(response.status).toBe(422)
      const payload = (await response.json()) as { error: { code: string; details?: unknown[] } }
      expect(payload.error.code).toBe('VALIDATION_FAILED')
      expect(payload.error.details?.length).toBeGreaterThan(0)
    }

    // 校验失败不占配额：一行都不该落。
    expect(await rowsOf(user.id)).toHaveLength(0)
  })

  test('连点即 429：带结构化 retryAfterSeconds，且被拒请求不写行', async () => {
    const user = await registerUser()
    const first = await app.request('/ai/polish-candidates', post(BODY, user.cookie))
    expect(first.status).toBe(200)

    const second = await app.request('/ai/polish-candidates', post(BODY, user.cookie))
    expect(second.status).toBe(429)
    const payload = (await second.json()) as {
      error: { code: string; message: string; retryAfterSeconds?: number }
    }
    expect(payload.error.code).toBe('AI_POLISH_QUOTA')
    expect(payload.error.retryAfterSeconds).toBeGreaterThan(0)
    expect(payload.error.retryAfterSeconds).toBeLessThanOrEqual(5)
    // 被拒的那次不写行：否则"拒一次就少一次额度"。
    expect(await rowsOf(user.id)).toHaveLength(1)
  })

  test('上游连不上 → 502 AI_UPSTREAM_ERROR（不是 500），并回写 outcome', async () => {
    const user = await registerUser()
    const response = await deadUpstreamApp.request('/ai/polish-candidates', post(BODY, user.cookie))

    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('AI_UPSTREAM_ERROR')

    const rows = await rowsOf(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('UPSTREAM_ERROR')
  })
})
