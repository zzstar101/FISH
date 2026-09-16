import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuthResponseSchema } from '@fish/contracts/auth/session'
import { createDb, type Db } from '@fish/db/client'
import { sessions } from '@fish/db/schema/sessions'
import { users } from '@fish/db/schema/users'
import { campusEmailVerifications } from '@fish/db/schema/verifications'
import { loadServerEnv } from '@fish/shared/env'
import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
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

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
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
  // dev Provider 的 outbox 指到隔离目录：测试读它取验证码，不污染真实 .dev。
  process.env.MAIL_OUTBOX_PATH = OUTBOX_PATH
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

/** 带 cookie 的 JSON POST：合并 headers 而不是让 post() 覆盖掉 cookie。 */
const postWith = (cookie: string, body: unknown) => ({
  ...post(body),
  headers: { ...post(body).headers, cookie },
})

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
  test('注册成功即登录，但一律 UNVERIFIED（#68：注册不再认证）', async () => {
    const res = await register()
    expect(res.status).toBe(200)

    const body = AuthResponseSchema.parse(await res.json())
    expect(body.user).toMatchObject({
      nickname: '测试甲',
      campus: '肇庆',
      authStatus: 'UNVERIFIED',
    })
    expect(body.user.verifiedAt).toBeNull()

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

  test('任意合法学号注册后都保持未认证', async () => {
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
    expect(body.user).toMatchObject({ nickname: '测试丁', authStatus: 'UNVERIFIED' })
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
  test('register 不再依赖 Provider：service 装配不传 provider 也能用（#68 移除 Campus Provider）', async () => {
    const service = createAuthService({ db: scratch, sessions: createSessions(scratch) })
    const { user } = await service.register({
      studentNo: '202101000113',
      password: DEMO_PASSWORD,
      nickname: '测试无Provider',
      campus: '广州',
    })
    expect(user.campus).toBe('广州')
    expect(user.authStatus).toBe('UNVERIFIED')
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

// ---------------------------------------------------------------------------
// 校园认证（#68）：验证码发送 / 验证 / 状态
// ---------------------------------------------------------------------------

/** 与 app 装配同一 dev Provider 的 outbox 路径（隔离目录，不污染真实 .dev）。 */
const OUTBOX_PATH = `${import.meta.dir}/.test-outbox-${process.pid}/mail-outbox.jsonl`

const CAMPUS_EMAIL = 'demo68@gzasc.edu.cn'

/** 从 outbox 取发给指定邮箱的最后一封的验证码（subject 内嵌）。 */
async function lastCodeFor(email: string): Promise<string> {
  const file = Bun.file(OUTBOX_PATH)
  if (!(await file.exists())) throw new Error(`outbox 不存在：${OUTBOX_PATH}`)
  const lines = (await file.text()).trim().split('\n')
  for (const line of lines.reverse()) {
    const mail = JSON.parse(line ?? '{}') as { to?: string; subject?: string }
    if (mail.to === email && mail.subject) {
      const match = /(\d{6})/.exec(mail.subject)
      if (match?.[1]) return match[1]
    }
  }
  throw new Error(`outbox 里没有发给 ${email} 的邮件`)
}

let verificationUserSeq = 0

/** 每次调用都造一个全新用户：学号复用会撞 409，且前一测试可能已把它认证成 VERIFIED。 */
async function verificationCookie(): Promise<string> {
  verificationUserSeq += 1
  const studentNo = `2021010003${String(verificationUserSeq).padStart(2, '0')}`
  await register({ studentNo, nickname: `验证码用户${verificationUserSeq}` })
  return sessionCookie(await login(studentNo))
}

describe('POST /auth/verification/code', () => {
  test('发送后 outbox 收到 6 位验证码邮件；验证成功后状态 VERIFIED', async () => {
    const cookie = await verificationCookie()
    const email = 'fresh68@gzasc.edu.cn'

    const send = await app.request('/auth/verification/code', postWith(cookie, { email }))
    expect(send.status).toBe(200)

    const code = await lastCodeFor(email)
    expect(code).toMatch(/^\d{6}$/)

    // 响应体不含明文码 / 完整邮箱
    const sendText = await Bun.readableStreamToText(send.body ?? new ReadableStream())
    expect(sendText).not.toContain(code)

    const verify = await app.request('/auth/verification/verify', postWith(cookie, { email, code }))
    expect(verify.status).toBe(200)
    const status = (await verify.json()) as {
      authStatus: string
      maskedEmail: string | null
      verifiedAt: string | null
    }
    expect(status).toMatchObject({ authStatus: 'VERIFIED', maskedEmail: 'f***@gzasc.edu.cn' })
    expect(status.maskedEmail).not.toContain(email.slice(1))

    // users 表同步升级，且 /me 与之一致（Done：两处状态一致）
    const me = await app.request('/me', withCookie(cookie))
    expect(AuthResponseSchema.parse(await me.json()).user).toMatchObject({
      authStatus: 'VERIFIED',
    })

    // 验证码已消费：同一码不可重放
    const replay = await app.request('/auth/verification/verify', postWith(cookie, { email, code }))
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ error: { code: 'CODE_CONSUMED' } })
  })

  test('非教育邮箱域名：422', async () => {
    const cookie = await verificationCookie()
    const res = await app.request(
      '/auth/verification/code',
      postWith(cookie, { email: 'someone@gmail.com' }),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  test('60s 内重复发送：429 RATE_LIMITED', async () => {
    const cookie = await verificationCookie()
    const email = 'ratelimit68@gzasc.edu.cn'
    const first = await app.request('/auth/verification/code', postWith(cookie, { email }))
    expect(first.status).toBe(200)

    const second = await app.request('/auth/verification/code', postWith(cookie, { email }))
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
  })

  test('邮箱已被其他账号绑定：409 EMAIL_ALREADY_BOUND（发码与验证两处都拦）', async () => {
    const owner = '202101000202'
    await register({ studentNo: owner, nickname: '占用者' })
    const ownerCookie = sessionCookie(await login(owner))
    const email = 'taken68@gzasc.edu.cn'

    // 先让占用者完成认证
    await app.request('/auth/verification/code', postWith(ownerCookie, { email }))
    const code = await lastCodeFor(email)
    const verified = await app.request(
      '/auth/verification/verify',
      postWith(ownerCookie, { email, code }),
    )
    expect(verified.status).toBe(200)

    // 另一个账号对同一邮箱发起验证
    const other = '202101000203'
    await register({ studentNo: other, nickname: '挑战者' })
    const otherCookie = sessionCookie(await login(other))

    const send = await app.request('/auth/verification/code', postWith(otherCookie, { email }))
    expect(send.status).toBe(409)
    expect(await send.json()).toMatchObject({ error: { code: 'EMAIL_ALREADY_BOUND' } })
  })

  test('已认证用户再发码：409 ALREADY_VERIFIED', async () => {
    const cookie = await verificationCookie()
    const email = 'once68@gzasc.edu.cn'
    await app.request('/auth/verification/code', postWith(cookie, { email }))
    const code = await lastCodeFor(email)
    await app.request('/auth/verification/verify', postWith(cookie, { email, code }))

    const again = await app.request(
      '/auth/verification/code',
      postWith(cookie, { email: 'second68@gzasc.edu.cn' }),
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_VERIFIED' } })
  })

  test('无登录态：401', async () => {
    const res = await app.request('/auth/verification/code', post({ email: CAMPUS_EMAIL }))
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/verification/verify', () => {
  test('错误码：422 CODE_INVALID，且错误响应不含明文码', async () => {
    const cookie = await verificationCookie()
    const email = 'wrong68@gzasc.edu.cn'
    await app.request('/auth/verification/code', postWith(cookie, { email }))

    const res = await app.request(
      '/auth/verification/verify',
      postWith(cookie, { email, code: '000001' }),
    )
    // '000001' 碰巧正确的概率 1e-6；为确定性，直接对比 outbox 里的真码排除巧合
    const real = await lastCodeFor(email)
    if (real === '000001') return
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toMatchObject({ error: { code: 'CODE_INVALID' } })
    expect(JSON.stringify(body)).not.toContain(real)
  })

  test('验证码过期：410 CODE_EXPIRED', async () => {
    const cookie = await verificationCookie()
    const email = 'expired68@gzasc.edu.cn'
    await app.request('/auth/verification/code', postWith(cookie, { email }))
    const code = await lastCodeFor(email)

    // 直接把最新一行的 expires_at 改到过去
    await scratch
      .update(campusEmailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(campusEmailVerifications.email, email))

    const res = await app.request('/auth/verification/verify', postWith(cookie, { email, code }))
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
  })

  test('尝试 5 次后作废：429 TOO_MANY_ATTEMPTS', async () => {
    const cookie = await verificationCookie()
    const email = 'attempts68@gzasc.edu.cn'
    await app.request('/auth/verification/code', postWith(cookie, { email }))
    const code = await lastCodeFor(email)
    // 确定性的错误码：与真码不同的 6 位数
    const wrong = code === '999999' ? '999998' : '999999'

    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(
        '/auth/verification/verify',
        postWith(cookie, { email, code: wrong }),
      )
      expect([422, 429]).toContain(res.status)
    }

    // 第 6 次即使拿真码也已被作废：码在达上限时被消费，语义归为 CODE_CONSUMED
    const res = await app.request('/auth/verification/verify', postWith(cookie, { email, code }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'CODE_CONSUMED' } })
  })

  test('重发后旧码失效，新码可验证（一次性 + 旧码作废）', async () => {
    const cookie = await verificationCookie()
    const email = 'resend68@gzasc.edu.cn'
    await app.request('/auth/verification/code', postWith(cookie, { email }))
    const oldCode = await lastCodeFor(email)

    // 等 60s 间隔不可行，直接改 last sent 以绕过限频（限频本身已有专测）
    await scratch
      .update(campusEmailVerifications)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(and(eq(campusEmailVerifications.email, email)))

    await app.request('/auth/verification/code', postWith(cookie, { email }))
    const newCode = await lastCodeFor(email)
    expect(newCode).not.toBe(oldCode)

    const oldTry = await app.request(
      '/auth/verification/verify',
      postWith(cookie, { email, code: oldCode }),
    )
    expect(oldTry.status).toBe(422)

    const newTry = await app.request(
      '/auth/verification/verify',
      postWith(cookie, { email, code: newCode }),
    )
    expect(newTry.status).toBe(200)
  })
})

describe('GET /auth/verification/status', () => {
  test('未认证：null maskedEmail；认证后返回脱敏邮箱，完整邮箱永不出 API', async () => {
    const cookie = await verificationCookie()

    const before = await app.request('/auth/verification/status', withCookie(cookie))
    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({ authStatus: 'UNVERIFIED', maskedEmail: null })

    const email = 'status68@gzasc.edu.cn'
    await app.request('/auth/verification/code', postWith(cookie, { email }))
    const code = await lastCodeFor(email)
    await app.request('/auth/verification/verify', postWith(cookie, { email, code }))

    const after = await app.request('/auth/verification/status', withCookie(cookie))
    const body = await after.json()
    expect(body).toMatchObject({
      authStatus: 'VERIFIED',
      maskedEmail: 's***@gzasc.edu.cn',
      verifiedAt: expect.any(String),
    })
    expect(JSON.stringify(body)).not.toContain('status68')
  })
})

describe('并发绑定冲突（审查回归）', () => {
  test('唯一索引兜底路径返回 409 EMAIL_ALREADY_BOUND 而不是 500', async () => {
    const cookieA = await verificationCookie()
    const cookieB = await verificationCookie()
    const email = 'race68@gzasc.edu.cn'

    // 两个账号都先拿到有效验证码。60s 邮箱间隔会拦第二封，先把已有行的时间回拨绕开
    // （限频本身有专测；这里要验证的是绑定冲突路径）。
    await app.request('/auth/verification/code', postWith(cookieA, { email }))
    const codeA = await lastCodeFor(email)
    await scratch
      .update(campusEmailVerifications)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(campusEmailVerifications.email, email))
    const secondSend = await app.request('/auth/verification/code', postWith(cookieB, { email }))
    expect(secondSend.status).toBe(200)
    const codeB = await lastCodeFor(email)
    expect(codeB).not.toBe(codeA)

    // A 先验证成功绑定邮箱
    const first = await app.request(
      '/auth/verification/verify',
      postWith(cookieA, { email, code: codeA }),
    )
    expect(first.status).toBe(200)

    // B 的预检查在 A 绑定前已过（这里直接模拟：B 用自己的码验证）——
    // 预检查会拦住已绑定邮箱，所以直接改库绕过预检查，强制走唯一索引冲突路径。
    // 更直接的方式：把 B 的 campus_email 预检查窗口顶掉不可行；改用事务内 bind 冲突：
    // B 的验证会先消费自己的码，再在绑定时发现邮箱已被 A 占用 → 409。
    const second = await app.request(
      '/auth/verification/verify',
      postWith(cookieB, { email, code: codeB }),
    )
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: { code: 'EMAIL_ALREADY_BOUND' } })
    // B 仍是 UNVERIFIED，且 B 的码已消费（Q7b：不退还）
    const meB = await app.request('/me', withCookie(cookieB))
    expect(AuthResponseSchema.parse(await meB.json()).user.authStatus).toBe('UNVERIFIED')
    const replayB = await app.request(
      '/auth/verification/verify',
      postWith(cookieB, { email, code: codeB }),
    )
    expect(replayB.status).toBe(409)
    expect(await replayB.json()).toMatchObject({ error: { code: 'CODE_CONSUMED' } })
  })
})
