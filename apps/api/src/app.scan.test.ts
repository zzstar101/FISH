import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SCAN_CONFIRM_PAGE } from '@fish/contracts/auth/scan'
import { createDb, type Db } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

/**
 * 扫码登录四个端点的端到端（#197 T5）。
 *
 * 三份 app 实例对应三种 transport，因为它们的对外语义不同：
 * - `stub`：能建票，但没有真码（`qrCodeDataUrl: null`），走开发者工具；
 * - `live`：真出码（这里用打桩的全局 fetch 代替微信），失败要映射成 502；
 * - `off`：入口关闭，503。
 *
 * 限流用注入的 `clientIp` 控制：每个用例换一个 IP，避免互相吃掉额度。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)
const scratchDatabase = `fish_scan_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let stubApp: ReturnType<typeof createApp>
let liveApp: ReturnType<typeof createApp>
let offApp: ReturnType<typeof createApp>

/** 每个用例换一个 IP：限流桶按 IP 分桶，否则前一个用例会把额度吃掉。 */
let currentIp = 'ip-default'
const clientIp = () => currentIp

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  const env = { ...loadServerEnv(), DATABASE_URL: scratchUrl }
  stubApp = createApp(env, undefined, undefined, undefined, { transport: 'stub' }, clientIp)
  liveApp = createApp(
    env,
    undefined,
    undefined,
    undefined,
    {
      transport: 'live',
      appid: 'wx-test-appid',
      appSecret: 'test-secret',
      qrEnvVersion: 'release',
    },
    clientIp,
  )
  offApp = createApp(env, undefined, undefined, undefined, { transport: 'off' }, clientIp)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const jsonPost = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const plainPost = { method: 'POST' as const }

/** 从 Set-Cookie 里取出会话 cookie。 */
function sessionCookie(res: Response): string {
  const found = res.headers.getSetCookie().find((value) => value.startsWith('fish_session='))
  if (!found) throw new Error(`响应未下发 fish_session：${res.headers.getSetCookie().join(' | ')}`)
  return found.split(';')[0] ?? ''
}

type CreatedTicket = { ticket: string; verifier: string; qrCodeDataUrl: string | null }

async function createTicket(app: ReturnType<typeof createApp>): Promise<CreatedTicket> {
  const res = await app.request('/auth/wechat/scan/ticket', plainPost)
  expect(res.status).toBe(200)
  return (await res.json()) as CreatedTicket
}

/**
 * 打桩全局 fetch：live 出码要走微信的 stable_token 与 getwxacodeunlimit 两条请求。
 * 记录 `init` 是为了能断言**实际发出去的出码参数**（scene / page / env_version）。
 */
function stubWechatFetch(handler: (url: URL, init: RequestInit | undefined) => Response) {
  const original = globalThis.fetch
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.href : String(input))
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** 每次调用都新建一份：Response 的 body 只能读一次，复用同一个会被消费掉。 */
const wechatTokenResponse = () =>
  new Response(JSON.stringify({ access_token: 'tok-test', expires_in: 7200 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('建票端点', () => {
  test('stub：能建票但没有真码；响应带 no-store；字段形状符合契约', async () => {
    currentIp = 'ip-stub-create'
    const res = await stubApp.request('/auth/wechat/scan/ticket', plainPost)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as CreatedTicket
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.verifier).toMatch(/^[0-9a-f]{64}$/)
    // stub 没有 AppSecret，生成不了真码：显式 null，不用普通二维码冒充。
    expect(body.qrCodeDataUrl).toBeNull()
  })

  test('live：出码成功时返回 image/* 的 data URL，且出码参数正确', async () => {
    currentIp = 'ip-live-create'
    const { calls, restore } = stubWechatFetch((url) =>
      url.pathname === '/cgi-bin/stable_token'
        ? wechatTokenResponse()
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
    )
    try {
      const body = await createTicket(liveApp)
      expect(body.qrCodeDataUrl).toMatch(/^data:image\/jpeg;base64,/)

      // 出码参数接错的后果是「真机扫开的是错页面 / 拿不到 ticket」，而只看 data URL 前缀
      // 是发现不了的——所以这里把实际发出去的 body 钉死。
      const qrCall = calls.find((call) => call.url.pathname === '/wxa/getwxacodeunlimit')
      expect(qrCall).toBeDefined()
      expect(JSON.parse(String(qrCall?.init?.body))).toEqual({
        scene: body.ticket,
        page: SCAN_CONFIRM_PAGE,
        // release 要求页面已发布：check_path 必须为 true。
        check_path: true,
        env_version: 'release',
      })
    } finally {
      restore()
    }
  })

  test('live：平台取码失败 → 502 WECHAT_QR_UNAVAILABLE（与 503 WECHAT_DISABLED 区分开）', async () => {
    currentIp = 'ip-live-fail'
    const { restore } = stubWechatFetch((url) =>
      url.pathname === '/cgi-bin/stable_token'
        ? wechatTokenResponse()
        : new Response(JSON.stringify({ errcode: 40129, errmsg: 'invalid scene' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    )
    try {
      const res = await liveApp.request('/auth/wechat/scan/ticket', plainPost)
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ error: { code: 'WECHAT_QR_UNAVAILABLE' } })
    } finally {
      restore()
    }
  })

  test('off：入口关闭 503 WECHAT_DISABLED', async () => {
    currentIp = 'ip-off'
    const res = await offApp.request('/auth/wechat/scan/ticket', plainPost)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'WECHAT_DISABLED' } })
  })

  test('限流：同一 IP 第 11 次建票 → 429 RATE_LIMITED', async () => {
    currentIp = 'ip-rate-limited'
    for (let i = 0; i < 10; i += 1) {
      expect((await stubApp.request('/auth/wechat/scan/ticket', plainPost)).status).toBe(200)
    }
    const blocked = await stubApp.request('/auth/wechat/scan/ticket', plainPost)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
  })
})

describe('查状态 / 确认 / 兑换', () => {
  test('完整链路：建票 → 小程序确认 → 浏览器兑换 → 新会话可用', async () => {
    currentIp = 'ip-flow'
    const created = await createTicket(stubApp)

    // 小程序侧：微信登录拿会话（stub provider）
    const login = await stubApp.request('/auth/wechat/session', jsonPost({ code: 'wx-code-flow' }))
    expect(login.status).toBe(200)
    const miniappCookie = sessionCookie(login)

    // 确认
    const confirm = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}/confirm`, {
      method: 'POST',
      headers: { cookie: miniappCookie },
    })
    expect(confirm.status).toBe(204)
    expect(confirm.headers.get('cache-control')).toBe('no-store')

    // 状态：只有持正确 verifier 才看得到 confirmed + 账号投影
    const status = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}`, {
      headers: { 'X-Scan-Verifier': created.verifier },
    })
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    const statusBody = (await status.json()) as { status: string; user?: { id: string } }
    expect(statusBody.status).toBe('confirmed')
    expect(statusBody.user?.id).toBeTruthy()

    // 兑换：拿新会话
    const exchange = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}/exchange`, {
      method: 'POST',
      headers: { 'X-Scan-Verifier': created.verifier },
    })
    expect(exchange.status).toBe(200)
    expect(exchange.headers.get('cache-control')).toBe('no-store')
    const webCookie = sessionCookie(exchange)

    const me = await stubApp.request('/me', { headers: { cookie: webCookie } })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { user: { id: string } }
    if (!statusBody.user) throw new Error('confirmed 状态缺少 user 投影')
    expect(meBody.user.id).toBe(statusBody.user.id)

    // 兑换后：同一张票再查状态 / 再兑换都是统一 404
    const afterStatus = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}`, {
      headers: { 'X-Scan-Verifier': created.verifier },
    })
    expect(afterStatus.status).toBe(404)
    const afterExchange = await stubApp.request(
      `/auth/wechat/scan/ticket/${created.ticket}/exchange`,
      { method: 'POST', headers: { 'X-Scan-Verifier': created.verifier } },
    )
    expect(afterExchange.status).toBe(404)
  })

  test('verifier 错或形状非法：一律 404 SCAN_TICKET_INVALID（不是 422）', async () => {
    currentIp = 'ip-verifier'
    const created = await createTicket(stubApp)

    const wrong = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}`, {
      headers: { 'X-Scan-Verifier': 'f'.repeat(64) },
    })
    expect(wrong.status).toBe(404)
    expect(await wrong.json()).toMatchObject({ error: { code: 'SCAN_TICKET_INVALID' } })

    // 形状非法（不是 64 hex）：同样走统一 404——不能给匿名调用者「参数错」这种区分信号。
    const malformed = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}`, {
      headers: { 'X-Scan-Verifier': 'not-a-verifier' },
    })
    expect(malformed.status).toBe(404)
    expect(await malformed.json()).toMatchObject({ error: { code: 'SCAN_TICKET_INVALID' } })

    const malformedTicket = await stubApp.request('/auth/wechat/scan/ticket/short', {
      headers: { 'X-Scan-Verifier': created.verifier },
    })
    expect(malformedTicket.status).toBe(404)
  })

  test('确认需要登录：匿名 401；未确认的票不可兑换 404', async () => {
    currentIp = 'ip-confirm-guard'
    const created = await createTicket(stubApp)

    const anonymous = await stubApp.request(
      `/auth/wechat/scan/ticket/${created.ticket}/confirm`,
      plainPost,
    )
    expect(anonymous.status).toBe(401)
    // 401 是 requireAuth 在进 handler 之前返回的：no-store 必须由中间件覆盖，否则这条漏。
    expect(anonymous.headers.get('cache-control')).toBe('no-store')

    const exchange = await stubApp.request(`/auth/wechat/scan/ticket/${created.ticket}/exchange`, {
      method: 'POST',
      headers: { 'X-Scan-Verifier': created.verifier },
    })
    expect(exchange.status).toBe(404)
  })
})
