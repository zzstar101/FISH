import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { authLoginAttempts } from '@fish/db/schema/auth-attempts'
import { loadServerEnv } from '@fish/shared/env'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

/**
 * 登录限流要造「连续失败」「失败历史在窗口外」「并发失败」三类状态，跑在开发库上会互相污染，
 * 因此与 router.test.ts 同规格自建 scratch 库。
 */
const scratchDatabase = `fish_login_throttle_test_${process.pid}`
const databaseUrlFor = (name: string) => {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}
const scratchUrl = databaseUrlFor(scratchDatabase)
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const admin = createDb(databaseUrl)
let scratch: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  process.env.MAIL_TRANSPORT = 'outbox'
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const PASSWORD = 'fish123456'
const WRONG = 'wrongpass1234'

const jsonPost = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const login = (studentNo: string, password: string) =>
  app.request('/auth/login', jsonPost({ studentNo, password }))

const register = async (studentNo: string) =>
  app.request(
    '/auth/register',
    jsonPost({ studentNo, password: PASSWORD, nickname: '限流测试', campus: '肇庆' }),
  )

const attemptRow = async (studentNo: string) =>
  (
    await scratch.select().from(authLoginAttempts).where(eq(authLoginAttempts.principal, studentNo))
  )[0] ?? null

/** 从 Set-Cookie 取会话 cookie（与 router.test.ts 同一手法）。 */
function sessionCookie(res: Response): string {
  const session = res.headers.getSetCookie().find((value) => value.startsWith('fish_session='))
  if (!session) throw new Error('响应未下发 fish_session')
  return session.split(';')[0] ?? ''
}

const failNTimes = async (studentNo: string, times: number) => {
  for (let i = 0; i < times; i += 1) await login(studentNo, WRONG)
}

describe('登录口令防爆破（#132）', () => {
  test('达阈值后即使口令正确也拒绝，返回 429 LOGIN_LOCKED', async () => {
    // 修复前本用例必然失败：那时失败次数不受任何约束，正确口令永远 200。
    const studentNo = '202101900001'
    await register(studentNo)

    for (let i = 0; i < 5; i += 1) {
      expect((await login(studentNo, WRONG)).status).toBe(401)
    }

    const locked = await login(studentNo, PASSWORD)
    expect(locked.status).toBe(429)
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('LOGIN_LOCKED')
    expect((await attemptRow(studentNo))?.failedAttempts).toBe(5)
  })

  test('成功登录清零计数（否则正常用户会因历史手滑被锁）', async () => {
    const studentNo = '202101900002'
    await register(studentNo)

    await failNTimes(studentNo, 4)
    expect((await login(studentNo, PASSWORD)).status).toBe(200)
    expect(await attemptRow(studentNo)).toBeNull()

    // 再犯 4 次仍然没到阈值：清零真的生效，而不是"累计到 8"。
    await failNTimes(studentNo, 4)
    expect((await login(studentNo, PASSWORD)).status).toBe(200)
  })

  test('窗口外的失败不复活计数', async () => {
    const studentNo = '202101900003'
    await register(studentNo)
    await failNTimes(studentNo, 4)

    await scratch.execute(
      sql`update auth_login_attempts set last_failure_at = now() - interval '11 minutes' where principal = ${studentNo}`,
    )

    await login(studentNo, WRONG)
    expect((await login(studentNo, PASSWORD)).status).toBe(200)
  })

  test('并发失败不会把阈值放大（SELECT … FOR UPDATE 的意义）', async () => {
    const studentNo = '202101900004'
    await register(studentNo)

    await Promise.all(Array.from({ length: 10 }, () => login(studentNo, WRONG)))

    // 计数恰好停在阈值：锁定期内不再推进。若失败计数是"跨事务先读后写"，
    // 10 个并发会把 failed_attempts 写成远小于 5 的值，攻击者实际能撞远超 5 次。
    expect((await attemptRow(studentNo))?.failedAttempts).toBe(5)
    expect((await login(studentNo, PASSWORD)).status).toBe(429)
  })

  test('未注册学号同样计数：探测账号存在性有代价', async () => {
    const studentNo = '202101900005'

    for (let i = 0; i < 5; i += 1) {
      expect((await login(studentNo, WRONG)).status).toBe(401)
    }
    expect((await login(studentNo, WRONG)).status).toBe(429)
  })

  test('锁定只作用于登录，不影响已登录会话（决策 3-A）', async () => {
    const studentNo = '202101900006'
    const cookie = sessionCookie(await register(studentNo))

    await failNTimes(studentNo, 5)
    expect((await login(studentNo, PASSWORD)).status).toBe(429)
    expect((await app.request('/me', { headers: { cookie } })).status).toBe(200)
  })
})
