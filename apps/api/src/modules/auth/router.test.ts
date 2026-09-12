import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuthResponseSchema } from '@fish/contracts/auth/session'
import { createDb, type Db } from '@fish/db/client'
import { sessions } from '@fish/db/schema/sessions'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

/**
 * 认证测试要造「重复学号」「过期会话」这类数据，跑在开发库上会互相污染，
 * 因此与 seed.test.ts 一样自建 scratch 库，顺带再验一次"migration 可在空库执行"。
 */
const scratchDatabase = `fish_auth_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const migrationsFolder = new URL('../../../../../packages/db/src/migrations', import.meta.url)
  .pathname

const admin = createDb(databaseUrl)
let scratch: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const DEMO_PASSWORD = 'fish123456'

const post = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const registerBody = (overrides: Record<string, unknown> = {}) => ({
  studentNo: '202101000101',
  password: DEMO_PASSWORD,
  nickname: '测试甲',
  campus: '肇庆',
  ...overrides,
})

/** 从 Set-Cookie 里取出会话 cookie，用于后续带 cookie 的请求。 */
function sessionCookie(res: Response): string {
  const cookies = res.headers.getSetCookie()
  const session = cookies.find((value) => value.startsWith('fish_session='))
  if (!session) {
    throw new Error(`响应未下发 fish_session：${cookies.join(' | ') || '(无 Set-Cookie)'}`)
  }
  return session.split(';')[0] ?? ''
}

const withCookie = (cookie: string) => ({ headers: { cookie } })

const register = (overrides: Record<string, unknown> = {}) =>
  app.request('/auth/register', post(registerBody(overrides)))

const login = (studentNo: string, password: string = DEMO_PASSWORD) =>
  app.request('/auth/login', post({ studentNo, password }))

/** 该用户的会话行，用于断言「登出只吊销当前这一行」「过期行被顺手删除」。 */
async function sessionRows(studentNo: string) {
  const owner = await scratch
    .select({ id: users.id })
    .from(users)
    .where(eq(users.studentNo, studentNo))
    .limit(1)
  const userId = owner[0]?.id
  if (!userId) throw new Error(`用户 ${studentNo} 不存在`)
  return scratch.select().from(sessions).where(eq(sessions.userId, userId))
}

describe('POST /auth/register', () => {
  test('20xx 级学号：创建账号、下发会话 cookie 并直接已认证', async () => {
    const res = await register()
    expect(res.status).toBe(200)

    const body = AuthResponseSchema.parse(await res.json())
    expect(body.user).toMatchObject({ nickname: '测试甲', campus: '肇庆', authStatus: 'VERIFIED' })
    expect(body.user.verifiedAt).not.toBeNull()

    const setCookie = res.headers.getSetCookie().join(' | ')
    expect(setCookie).toContain('fish_session=')
    expect(setCookie).toContain('HttpOnly')
    // 本地是 http：加了 Secure 浏览器会直接丢掉 cookie
    expect(setCookie).not.toContain('Secure')
  })

  test('WEB_ORIGIN 为 https 时会话 cookie 带 Secure', async () => {
    const secureApp = createApp({
      ...loadServerEnv(),
      DATABASE_URL: scratchUrl,
      WEB_ORIGIN: 'https://fish.example.com',
    })

    const res = await secureApp.request(
      '/auth/login',
      post({ studentNo: '202101000101', password: DEMO_PASSWORD }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().join(' | ')).toContain('Secure')
  })

  test('12 位但非 20xx 级学号：注册成功，但保持未认证', async () => {
    const res = await register({ studentNo: '199901000102', nickname: '测试乙' })
    expect(res.status).toBe(200)

    const body = AuthResponseSchema.parse(await res.json())
    expect(body.user.authStatus).toBe('UNVERIFIED')
    expect(body.user.verifiedAt).toBeNull()
  })

  test('学号已存在：409 STUDENT_NO_TAKEN（含并发同号）', async () => {
    expect((await register({ studentNo: '202101000103', nickname: '测试丙' })).status).toBe(200)

    const again = await register({ studentNo: '202101000103', nickname: '测试丙二号' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'STUDENT_NO_TAKEN' } })

    // 并发下两个请求都可能通过「先查一次」的快速路径，必须由唯一约束兜底成 409
    const concurrent = await Promise.all([
      register({ studentNo: '202101000104', nickname: '并发一号' }),
      register({ studentNo: '202101000104', nickname: '并发二号' }),
    ])
    expect(concurrent.map((res) => res.status).sort()).toEqual([200, 409])
  })

  test('非法入参：422 VALIDATION_FAILED（密码过短 / 学号含字母 / 多余字段）', async () => {
    const bodies = [
      registerBody({ password: 'short' }),
      registerBody({ studentNo: '20210100010a' }),
      { ...registerBody(), extra: 'nope' },
    ]

    for (const body of bodies) {
      const res = await app.request('/auth/register', post(body))
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    }
  })
})

describe('POST /auth/login', () => {
  test('学号密码正确：返回与 /me 同构的用户资料并下发 cookie', async () => {
    await register({ studentNo: '202101000105', nickname: '测试丁' })

    const res = await login('202101000105')
    expect(res.status).toBe(200)

    const body = AuthResponseSchema.parse(await res.json())
    expect(body.user).toMatchObject({ nickname: '测试丁', authStatus: 'VERIFIED' })
    expect(sessionCookie(res).startsWith('fish_session=')).toBe(true)
  })

  test('密码错误与学号不存在都返回 401 INVALID_CREDENTIALS（不泄漏账号是否存在）', async () => {
    await register({ studentNo: '202101000106', nickname: '测试戊' })

    for (const res of [
      await login('202101000106', 'wrong-password'),
      await login('202101000107'),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } })
    }
  })
})

describe('GET /me', () => {
  test('返回昵称/头像/校区/认证状态，且响应体不含学号与密码哈希', async () => {
    const studentNo = '202101000108'
    await register({ studentNo, nickname: '测试己' })

    const res = await app.request('/me', withCookie(sessionCookie(await login(studentNo))))
    expect(res.status).toBe(200)

    const text = await res.text()
    expect(Object.keys(AuthResponseSchema.parse(JSON.parse(text)).user).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'campus',
      'id',
      'nickname',
      'verifiedAt',
    ])
    // 「不公开完整学号」的硬断言：学号、哈希、列名都不允许出现在响应里
    expect(text).not.toContain(studentNo)
    expect(text).not.toContain('passwordHash')
    expect(text).not.toContain('password_hash')
  })

  test('无 cookie 与伪造令牌都是 401 UNAUTHENTICATED', async () => {
    for (const res of [
      await app.request('/me'),
      await app.request('/me', withCookie('fish_session=deadbeef')),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    }
  })

  test('会话过期：401，且只删掉被访问的过期行', async () => {
    const studentNo = '202101000109'
    await register({ studentNo, nickname: '测试庚' })
    const cookie = sessionCookie(await login(studentNo))

    const before = await sessionRows(studentNo)
    expect(before.length).toBe(2) // 注册顺带登录 + 这次登录

    const owner = before[0]
    if (!owner) throw new Error('未找到会话行')
    await scratch
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, owner.userId))

    const res = await app.request('/me', withCookie(cookie))
    expect(res.status).toBe(401)

    const after = await sessionRows(studentNo)
    expect(after).toHaveLength(1)
  })
})

describe('POST /auth/logout', () => {
  test('清除 cookie 并吊销会话，重复调用仍是 204', async () => {
    const studentNo = '202101000110'
    await register({ studentNo, nickname: '测试辛' })
    const cookie = sessionCookie(await login(studentNo))

    const res = await app.request('/auth/logout', { ...withCookie(cookie), method: 'POST' })
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie().join(' | ')).toContain('Max-Age=0')
    expect((await app.request('/me', withCookie(cookie))).status).toBe(401)

    expect(
      (await app.request('/auth/logout', { ...withCookie(cookie), method: 'POST' })).status,
    ).toBe(204)
    expect((await app.request('/auth/logout', { method: 'POST' })).status).toBe(204)
  })

  test('每次登录一行会话，登出只吊销当前这一行', async () => {
    const studentNo = '202101000111'
    await register({ studentNo, nickname: '测试壬' })
    const before = (await sessionRows(studentNo)).length

    const first = sessionCookie(await login(studentNo))
    const second = sessionCookie(await login(studentNo))
    expect(first).not.toBe(second)
    expect(await sessionRows(studentNo)).toHaveLength(before + 2)

    await app.request('/auth/logout', { ...withCookie(first), method: 'POST' })

    expect((await app.request('/me', withCookie(first))).status).toBe(401)
    expect((await app.request('/me', withCookie(second))).status).toBe(200)
    expect(await sessionRows(studentNo)).toHaveLength(before + 1)
  })
})
