import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuthResponseSchema } from '@fish/contracts/auth/session'
import type { Campus } from '@fish/contracts/auth/user'
import { createDb, type Db } from '@fish/db/client'
import { sessions } from '@fish/db/schema/sessions'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
import type { CampusVerificationProvider } from './provider'
import { createAuthService } from './service'
import { createSessions } from './session'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

/**
 * 认证测试要造「重复学号」「过期会话」这类数据，跑在开发库上会互相污染，
 * 因此与 seed.test.ts 一样自建 scratch 库，顺带再验一次"migration 可在空库执行"。
 */
const scratchDatabase = `fish_auth_test_${process.pid}`
const databaseUrlFor = (name: string) => {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}
const scratchUrl = databaseUrlFor(scratchDatabase)

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

  test('库里是非法 avatarUrl 时降级为 null，而不是让前端解析 /me 抛错', async () => {
    const studentNo = '202101000112'
    await register({ studentNo, nickname: '测试癸' })
    const cookie = sessionCookie(await login(studentNo))

    // #6 可能把 object key（而非绝对 URL）写进 users.avatar_url，而契约声明是 z.url()
    await scratch
      .update(users)
      .set({ avatarUrl: 'listings/avatar.jpg' })
      .where(eq(users.studentNo, studentNo))

    const res = await app.request('/me', withCookie(cookie))
    expect(res.status).toBe(200)
    expect(AuthResponseSchema.parse(await res.json()).user.avatarUrl).toBeNull()
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

describe('Provider 边界', () => {
  test('真实 Provider 返回的权威校区可用，值域外的脏值回退到用户填写值', async () => {
    const stub = (campus: string): CampusVerificationProvider => ({
      // 断言只用于构造非法输入：真实教务系统返回的是外部字符串，落库前必须过运行时校验
      verify: async () => ({ status: 'VERIFIED', campus: campus as Campus }),
    })

    for (const [campus, expected] of [
      ['广州', '广州'],
      ['四会', '肇庆'], // 不在值域内 → 用注册时填的校区
    ] as const) {
      const service = createAuthService({
        db: scratch,
        sessions: createSessions(scratch),
        provider: stub(campus),
      })

      const { user } = await service.register({
        studentNo: campus === '广州' ? '202101000113' : '202101000114',
        password: DEMO_PASSWORD,
        nickname: '测试校区',
        campus: '肇庆',
      })

      expect(user.campus).toBe(expected)
      expect(user.authStatus).toBe('VERIFIED')
    }
  })
})

describe('注册原子性', () => {
  test('会话写入失败时回滚已创建的用户，不留下无法登录的账号', async () => {
    // 造一个「有 users 表、没有 sessions 表」的库，逼会话插入失败
    const partialDatabase = `${scratchDatabase}_partial`
    await admin.$client.unsafe(`create database "${partialDatabase}"`)
    const partial = createDb(databaseUrlFor(partialDatabase))

    try {
      await migrate(partial, { migrationsFolder })
      await partial.execute(sql`drop table "sessions"`)

      const partialApp = createApp({
        ...loadServerEnv(),
        DATABASE_URL: databaseUrlFor(partialDatabase),
      })
      const studentNo = '202101000116'
      const res = await partialApp.request(
        '/auth/register',
        post(registerBody({ studentNo, nickname: '原子性' })),
      )
      expect(res.status).toBe(500)

      // 用户插入与会话插入必须同属一个事务：否则会留下一个已占用学号、但登不进去的账号
      expect(await partial.select().from(users).where(eq(users.studentNo, studentNo))).toHaveLength(
        0,
      )
    } finally {
      await partial.$client.close()
      await admin.$client.unsafe(`drop database if exists "${partialDatabase}" with (force)`)
    }
  })
})

describe('未捕获异常', () => {
  test('走同一个错误信封，且日志不泄漏请求里的密码与学号', async () => {
    // 指向一个没有任何表的空库：注册必然抛未捕获异常，从而走到 app.onError
    const brokenDatabase = `${scratchDatabase}_broken`
    await admin.$client.unsafe(`create database "${brokenDatabase}"`)

    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))

    try {
      const brokenApp = createApp({
        ...loadServerEnv(),
        DATABASE_URL: databaseUrlFor(brokenDatabase),
      })
      const res = await brokenApp.request(
        '/auth/register',
        post(registerBody({ studentNo: '202101000115', password: 'probe-secret-pw' })),
      )

      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })

      // Drizzle 的包装错误 message 第二行是 `params: [...]`（含 password_hash），
      // 日志只允许取第一行；这条断言就是防止后人去掉那个 split
      const text = logged.join('\n')
      expect(text).not.toContain('probe-secret-pw')
      expect(text).not.toContain('202101000115')
      expect(text).not.toContain('params:')
      expect(text).toContain('at ') // 仍然保留调用帧，否则 500 无法定位
    } finally {
      console.error = originalError
      await admin.$client.unsafe(`drop database if exists "${brokenDatabase}" with (force)`)
    }
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
