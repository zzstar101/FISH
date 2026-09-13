import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import type { ProfileResponse } from '@fish/contracts/profile/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { WISH_ROUTES } from '@fish/contracts/wishes/routes'
import { createDb, type Db } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
import { websocket } from '../../ws'

/**
 * #42 的双账号链路验收（Marketplace Flow）。
 *
 * 走**真实 HTTP + 真实 WebSocket**：`Bun.serve({ fetch: app.fetch, websocket })` 与
 * `apps/api/src/index.ts` 同一套接线，不 mock 任何一层；数据只落在 scratch 库，
 * 全程不改 schema、不需要临时 SQL 兜底，可反复重跑。
 *
 * 放在 transactions 目录：链路的核心不变量（`ACTIVE → RESERVED → SOLD`、
 * `PENDING_MEETUP → COMPLETED`）由交易域拥有，chat / profile 是它的上下游。
 *
 * 链路：B 建会话（可复用）→ 双方收发 TEXT（HTTP + WS 实时）→ 断线重连靠历史接口恢复
 *      → B 提案 → A 接受（Listing RESERVED）→ 双方 confirm（Transaction COMPLETED、Listing SOLD）
 *      → 双方 `/profile` 反映最终状态。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与其它集成测试相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_marketplace_flow_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let server: ReturnType<typeof Bun.serve>
let baseUrl = ''
let wsBaseUrl = ''

const PASSWORD = 'fish123456'
const SELLER_NO = '202199000001'
const BUYER_NO = '202199000002'
const OUTSIDER_NO = '202199000003'

let sellerCookie = ''
let buyerCookie = ''
let outsiderCookie = ''
let listingId = ''
let conversationId = ''

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  const app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
  server = Bun.serve({
    port: 0, // 由系统分配端口：不与本地 dev 服务的 3000 抢，多个测试进程也能并行
    fetch: app.fetch,
    websocket,
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  wsBaseUrl = `ws://127.0.0.1:${server.port}`

  sellerCookie = await register(SELLER_NO, '卖家')
  buyerCookie = await register(BUYER_NO, '买家')
  outsiderCookie = await register(OUTSIDER_NO, '路人')

  // 商品由「卖家」拥有：走 SQL fixture 而不是 #6 的发布接口（要图片直传），
  // 避免验收依赖另一个 Domain 的上传链路。
  listingId = await insertListing(await userIdOf(SELLER_NO))
})

afterAll(async () => {
  // teardown 绝不能掩盖真正的失败原因：beforeAll 中途失败时 server / db 可能尚未赋值，
  // 裸写 `server.stop(true)` 会抛 `TypeError: undefined is not an object`，把上面真正的
  // 错误（例如 migrate 失败）盖掉，排查时只看得到 TypeError。
  try {
    server?.stop(true)
    if (db) await db.$client.close()
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
    await admin.$client.close()
  } catch (error) {
    console.error('[marketplace-flow] teardown 失败（不影响验收结论）', error)
  }
})

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

async function api(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function register(studentNo: string, nickname: string): Promise<string> {
  const response = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ studentNo, password: PASSWORD, nickname, campus: '肇庆' }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  return cookie
}

async function userIdOf(studentNo: string): Promise<string> {
  const row = rows(
    await db.execute(sql`SELECT id FROM users WHERE student_no = ${studentNo}`),
  )[0] as { id: string }
  return row.id
}

async function insertListing(
  sellerId: string,
  id = '01990000-0000-7000-8000-0000000000b1',
): Promise<string> {
  // id 必须显式给：主键默认值在 Drizzle 层（$defaultFn），DB 侧没有 default。
  const row = rows(
    await db.execute(sql`
      INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
      VALUES (${id}, ${sellerId}, 'K380 键盘', '验收用商品', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
      RETURNING id
    `),
  )[0] as { id: string }
  return row.id
}

async function listingStatus(id = listingId): Promise<string> {
  const row = rows(
    await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${id}`),
  )[0] as { status: string }
  return row.status
}

/** 等一个条件成立（WS 是异步推送，不能假设到达顺序）；超时即失败，避免测试挂死。 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error(`等待超时：${what}`)
}

type RealtimeFrame = { type: string; conversationId?: string; message?: MessageDto }

/** 连上真实 `/ws/chat`（cookie 鉴权与 HTTP 同一套 session），返回收集到的帧。 */
async function connectRealtime(cookie: string) {
  const frames: RealtimeFrame[] = []
  const socket = new WebSocket(`${wsBaseUrl}/ws/chat`, { headers: { cookie } })
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as RealtimeFrame)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 3000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败（未认证或 upgrade 被拒）'))
    })
  })
  return { socket, frames }
}

describe('marketplace flow 双账号验收（#42）', () => {
  test('B 建会话：同 (listing, buyer) 复用而不是重复新建', async () => {
    const created = await api('/conversations', {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId }),
    })
    expect(created.status).toBe(201)
    const conversation = await json<{ id: string; listing: { id: string } }>(created)
    conversationId = conversation.id
    expect(conversation.listing.id).toBe(listingId)

    const reused = await api('/conversations', {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId }),
    })
    expect(reused.status).toBe(200)
    expect((await json<{ id: string }>(reused)).id).toBe(conversationId)

    // 会话列表只应有一条（复用没有产生第二行）
    const list = await api('/conversations?limit=20', { cookie: buyerCookie })
    expect(list.status).toBe(200)
    const page = await json<{ items: { id: string }[] }>(list)
    expect(page.items.map((item) => item.id)).toEqual([conversationId])
  })

  test('双方收发 TEXT：HTTP 落库、顺序稳定', async () => {
    const sent = await api(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ content: '  这台键盘还在吗  ' }),
    })
    expect(sent.status).toBe(201)
    const buyerMessage = await json<MessageDto>(sent)
    expect(buyerMessage.content).toBe('这台键盘还在吗') // trim 在服务端做
    expect(buyerMessage.type).toBe('TEXT')
    expect(buyerMessage.sender?.id).toBe(await userIdOf(BUYER_NO))

    const reply = await api(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({ content: '还在，160 可以出' }),
    })
    expect(reply.status).toBe(201)

    const history = await api(`/conversations/${conversationId}/messages?limit=30`, {
      cookie: buyerCookie,
    })
    const page = await json<{ items: MessageDto[] }>(history)
    expect(page.items.map((item) => item.content)).toEqual(['这台键盘还在吗', '还在，160 可以出'])
  })

  test('WS：在线双方都能收到 message.new（先落库、再推送）', async () => {
    const seller = await connectRealtime(sellerCookie)
    const buyer = await connectRealtime(buyerCookie)
    try {
      const sent = await api(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        cookie: buyerCookie,
        body: JSON.stringify({ content: '我今晚可以来拿' }),
      })
      expect(sent.status).toBe(201)

      await waitFor(
        () => seller.frames.some((frame) => frame.type === 'message.new'),
        '卖家连接收到 message.new',
      )
      await waitFor(
        () => buyer.frames.some((frame) => frame.type === 'message.new'),
        '买家连接收到 message.new',
      )
      const pushed = seller.frames.find((frame) => frame.type === 'message.new')
      expect(pushed?.conversationId).toBe(conversationId)
      expect(pushed?.message?.content).toBe('我今晚可以来拿')
    } finally {
      seller.socket.close()
      buyer.socket.close()
    }
  })

  test('断线重连：断开期间的推送不会让已落库的消息丢失', async () => {
    const seller = await connectRealtime(sellerCookie)
    seller.socket.close() // 先断开

    // 断线期间买家继续发消息
    const offline = await api(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ content: '我到楼下了' }),
    })
    expect(offline.status).toBe(201)

    // 重连后靠历史接口恢复（契约：离线重连不丢持久消息）
    const reconnected = await connectRealtime(sellerCookie)
    try {
      const history = await api(`/conversations/${conversationId}/messages?limit=30`, {
        cookie: sellerCookie,
      })
      const page = await json<{ items: MessageDto[] }>(history)
      expect(page.items.map((item) => item.content)).toContain('我到楼下了')
    } finally {
      reconnected.socket.close()
    }
  })

  test('B 提案 → A 接受：Listing RESERVED、Transaction PENDING_MEETUP、会话内留 SYSTEM 消息', async () => {
    const proposed = await api('/transactions/proposals', {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ conversationId, amountCents: 15000 }),
    })
    expect(proposed.status).toBe(201)
    expect((await json<MessageDto>(proposed)).type).toBe('SYSTEM')

    const accepted = await api('/transactions', {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({ conversationId, amountCents: 15000 }),
    })
    expect(accepted.status).toBe(201)
    const dto = await json<TransactionDto>(accepted)
    expect(dto.status).toBe('PENDING_MEETUP')
    expect(dto.amountCents).toBe(15000)
    expect(dto.listing.status).toBe('RESERVED')
    expect(await listingStatus()).toBe('RESERVED')

    // 会话里应能看到两条协议消息：提案与接受
    const history = await api(`/conversations/${conversationId}/messages?limit=50`, {
      cookie: sellerCookie,
    })
    const page = await json<{ items: MessageDto[] }>(history)
    const systemTypes = page.items
      .filter((item) => item.type === 'SYSTEM')
      .map((item) => (JSON.parse(item.content) as { type: string }).type)
    expect(systemTypes).toEqual(['tx.proposal', 'tx.accepted'])
  })

  test('双方 confirm：Transaction COMPLETED、Listing SOLD', async () => {
    const list = await api('/transactions?role=seller', { cookie: sellerCookie })
    const page = await json<{ items: TransactionDto[] }>(list)
    const transactionId = page.items[0]?.id
    if (!transactionId) throw new Error('卖家应能看到刚创建的交易')

    const first = await api(`/transactions/${transactionId}/confirm`, {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(first.status).toBe(200)
    expect((await json<TransactionDto>(first)).status).toBe('PENDING_MEETUP') // 只点了一边

    const second = await api(`/transactions/${transactionId}/confirm`, {
      method: 'POST',
      cookie: sellerCookie,
    })
    expect(second.status).toBe(200)
    const completed = await json<TransactionDto>(second)
    expect(completed.status).toBe('COMPLETED')
    expect(completed.completedAt).not.toBeNull()
    expect(await listingStatus()).toBe('SOLD')
  })

  test('双方 /profile 反映最终状态（role、完成数、商品状态一致）', async () => {
    const sellerProfile = await json<ProfileResponse>(
      await api('/profile', { cookie: sellerCookie }),
    )
    const buyerProfile = await json<ProfileResponse>(await api('/profile', { cookie: buyerCookie }))

    // 交易摘要内嵌商品与对方，且 role 按查看者视角解析
    const sellerTx = sellerProfile.transactions[0]
    expect(sellerTx?.role).toBe('seller')
    expect(sellerTx?.status).toBe('COMPLETED')
    expect(sellerTx?.listing.status).toBe('SOLD')

    const buyerTx = buyerProfile.transactions[0]
    expect(buyerTx?.role).toBe('buyer')
    expect(buyerTx?.counterpart.id).toBe(await userIdOf(SELLER_NO))
    expect(buyerTx?.id).toBe(sellerTx?.id)

    // 统计与列表口径一致：完成后不再计入在售，完成数各计一笔
    expect(sellerProfile.stats.completedTransactions).toBe(1)
    expect(sellerProfile.listings.find((item) => item.id === listingId)?.status).toBe('SOLD')
    expect(buyerProfile.stats.completedTransactions).toBe(1)

    // 只返回本人数据：路人看不到这笔交易
    const outsiderProfile = await json<ProfileResponse>(
      await api('/profile', { cookie: outsiderCookie }),
    )
    expect(outsiderProfile.transactions).toHaveLength(0)
  })

  test('完成后他人再接受同一商品：409（不产生第二笔 live 交易）', async () => {
    const outsiderConversation = await api('/conversations', {
      method: 'POST',
      cookie: outsiderCookie,
      body: JSON.stringify({ listingId }),
    })
    expect(outsiderConversation.status).toBe(201)

    const rejected = await api('/transactions', {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({
        conversationId: (await json<{ id: string }>(outsiderConversation)).id,
        amountCents: 16000,
      }),
    })
    expect(rejected.status).toBe(409)
    expect(await json<{ error: { code: string } }>(rejected)).toMatchObject({
      error: { code: 'LISTING_NOT_ACTIVE' },
    })
    expect(await listingStatus()).toBe('SOLD')
  })

  test('取消路径：Listing 回 ACTIVE，CANCELLED 上的 confirm 被拒', async () => {
    // 另起一个未成交商品：上面的商品已 SOLD，不能再走取消
    const secondListingId = await insertListing(
      await userIdOf(SELLER_NO),
      '01990000-0000-7000-8000-0000000000b2',
    )
    const conversation = await api('/conversations', {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId: secondListingId }),
    })
    const secondConversationId = (await json<{ id: string }>(conversation)).id

    await api('/transactions/proposals', {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ conversationId: secondConversationId, amountCents: 9000 }),
    })
    const accepted = await api('/transactions', {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({ conversationId: secondConversationId, amountCents: 9000 }),
    })
    expect(accepted.status).toBe(201)
    const transactionId = (await json<TransactionDto>(accepted)).id
    expect(await listingStatus(secondListingId)).toBe('RESERVED')

    const cancelled = await api(`/transactions/${transactionId}/cancel`, {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(cancelled.status).toBe(200)
    expect((await json<TransactionDto>(cancelled)).status).toBe('CANCELLED')
    // 取消后恢复可用性：商品回到 ACTIVE
    expect(await listingStatus(secondListingId)).toBe('ACTIVE')

    // 终态不接受前进：CANCELLED 上 confirm → 409
    const afterCancel = await api(`/transactions/${transactionId}/confirm`, {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(afterCancel.status).toBe(409)
  })

  test('非法终态转换：COMPLETED 上 cancel 被拒，商品不被回退', async () => {
    const list = await api('/transactions?role=seller&status=COMPLETED', { cookie: sellerCookie })
    const page = await json<{ items: TransactionDto[] }>(list)
    const completedId = page.items[0]?.id
    if (!completedId) throw new Error('应能按 status 过滤出已完成的交易')

    const cancelled = await api(`/transactions/${completedId}/cancel`, {
      method: 'POST',
      cookie: sellerCookie,
    })
    expect(cancelled.status).toBe(409)
    expect(await listingStatus()).toBe('SOLD')
  })

  test('Profile 与 Wish 一致：愿望接口写入后，profile 的愿望与统计同口径', async () => {
    // 用契约常量而不是硬编码路径：PR #44 把 wishes 路由从 /api/wishes 收敛到根级 /wishes，
    // 契约常量在两种状态下都指向当前真实路径。
    const created = await api(WISH_ROUTES.base, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({
        keyword: '机械键盘',
        category: 'DIGITAL',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
      }),
    })
    expect(created.status).toBe(201)
    const createdWish = await json<{ id: string }>(created)

    const activeWishes = await json<{ items: { id: string }[] }>(
      await api(`${WISH_ROUTES.base}?status=ACTIVE&page=1&pageSize=20`, { cookie: buyerCookie }),
    )
    const profile = await json<ProfileResponse>(await api('/profile', { cookie: buyerCookie }))

    // #38 修过的坑：同一份数据在 /wishes 与 /profile 必须给出一致的条数，
    // 否则个人中心「愿望 N 条」与愿望页对不上。
    expect(profile.wishes.map((wish) => wish.id)).toContain(createdWish.id)
    expect(profile.stats.activeWishes).toBe(activeWishes.items.length)
  })
})
