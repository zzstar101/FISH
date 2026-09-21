import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CHAT_ROUTES, REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import { PROFILE_ROUTES } from '@fish/contracts/profile/routes'
import type { ProfileResponse } from '@fish/contracts/profile/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
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
 *
 * 运行方式：**必须整文件跑**（`bun test <本文件>`）。用例之间有状态依赖（共享 listing / conversation），
 * 用 `-t` 过滤单跑会因缺少前序铺垫而失败、并产生误导性报错。要求「连续跑 5 次」时：
 *
 *     bun test --rerun-each 5 apps/api/src/modules/transactions/marketplace-flow.test.ts
 *
 * 跨域路径一律取自契约常量（`CHAT_ROUTES` / `TRANSACTION_ROUTES` / `PROFILE_ROUTES` / `WISH_ROUTES`）——
 * 契约文件明确禁止在别处硬编码这些路径，硬编码会让契约漂移时验收不报红，与集成 Gate 的目的相反。
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
  // teardown 有两条相互冲突的要求，不能用一个 try/catch 同时满足：
  // ① 必须兜住「beforeAll 中途失败」——那时 server / db 尚未赋值，裸写 `server.stop(true)`
  //    会抛 `TypeError: undefined is not an object`，把真因（例如 migrate 失败）盖掉；
  // ② 又不能把 `drop database` 一起吞掉——否则 close 抛错时库不删、异常只进日志，
  //    测试仍绿却静默残留 scratch 库。
  // 因此各步骤单独 guard，drop 放在最后且始终尝试执行。
  try {
    server?.stop(true)
  } catch (error) {
    console.error('[marketplace-flow] 关闭服务失败', error)
  }
  try {
    if (db) await db.$client.close()
  } catch (error) {
    console.error('[marketplace-flow] 关闭业务连接池失败', error)
  }
  // ③ `drop database` **不能吞异常**：吞掉之后库没删成、错误只进 console，测试仍旧全绿，
  //    scratch 库静默残留（`with (force)` 已兜住残留连接，真正失败时会一直留在实例上）。
  //    这里让它直接冒泡成红灯。`if exists` 保证 beforeAll 早期失败时仍是 no-op。
  try {
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  } finally {
    await admin.$client.close()
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

/** 会话列表里本次验收那一行（列表按 lastMessageAt 降序，用 id 定位而不是取 items[0]）。 */
async function conversationRow(cookie: string): Promise<ConversationDto> {
  const page = await json<{ items: ConversationDto[] }>(
    await api(`${CHAT_ROUTES.base}?limit=50`, { cookie }),
  )
  const row = page.items.find((item) => item.id === conversationId)
  if (!row) throw new Error('会话列表里找不到本次验收的会话')
  return row
}

/** 某商品下的交易行数：用于断言「拒绝不建交易」「并发只有一个成功」这类不变量。 */
async function transactionCountFor(listing: string): Promise<number> {
  const row = rows(
    await db.execute(
      sql`SELECT count(*)::int AS n FROM transactions WHERE listing_id = ${listing}`,
    ),
  )[0] as { n: number }
  return Number(row.n)
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

type RealtimeFrame = {
  type: string
  conversationId?: string
  message?: MessageDto
  /** `conversation.read`：谁的读位被推进、推进到哪一刻 */
  readerId?: string
  readAt?: string
}

/**
 * 连上真实 `/ws/chat`（cookie 鉴权与 HTTP 同一套 session），返回收集到的帧。
 * 不传 cookie 时用于验证契约语义②：未认证在 upgrade 前就被拒，**连接不会建立**。
 */
async function connectRealtime(cookie?: string) {
  const frames: RealtimeFrame[] = []
  const socket = new WebSocket(
    `${wsBaseUrl}${REALTIME_WS_PATH}`,
    cookie ? { headers: { cookie } } : undefined,
  )
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
    const created = await api(CHAT_ROUTES.base, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId }),
    })
    expect(created.status).toBe(201)
    const conversation = await json<{ id: string; listing: { id: string } }>(created)
    conversationId = conversation.id
    expect(conversation.listing.id).toBe(listingId)

    const reused = await api(CHAT_ROUTES.base, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId }),
    })
    expect(reused.status).toBe(200)
    expect((await json<{ id: string }>(reused)).id).toBe(conversationId)

    // 会话列表只应有一条（复用没有产生第二行）
    const list = await api(`${CHAT_ROUTES.base}?limit=20`, { cookie: buyerCookie })
    expect(list.status).toBe(200)
    const page = await json<{ items: { id: string }[] }>(list)
    expect(page.items.map((item) => item.id)).toEqual([conversationId])
  })

  test('双方收发 TEXT：HTTP 落库、顺序稳定', async () => {
    const sent = await api(CHAT_ROUTES.messages(conversationId), {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ content: '  这台键盘还在吗  ' }),
    })
    expect(sent.status).toBe(201)
    const buyerMessage = await json<MessageDto>(sent)
    expect(buyerMessage.content).toBe('这台键盘还在吗') // trim 在服务端做
    expect(buyerMessage.type).toBe('TEXT')
    expect(buyerMessage.sender?.id).toBe(await userIdOf(BUYER_NO))

    const reply = await api(CHAT_ROUTES.messages(conversationId), {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({ content: '还在，160 可以出' }),
    })
    expect(reply.status).toBe(201)

    const history = await api(`${CHAT_ROUTES.messages(conversationId)}?limit=30`, {
      cookie: buyerCookie,
    })
    const page = await json<{ items: MessageDto[] }>(history)
    expect(page.items.map((item) => item.content)).toEqual(['这台键盘还在吗', '还在，160 可以出'])
  })

  test('已读状态与 lastMessage：未读数随对方消息增长，read 后归零', async () => {
    // 先把双方的读位置推到当前时刻，作为确定起点——不依赖 last_read_at 的初始值。
    for (const cookie of [sellerCookie, buyerCookie]) {
      const read = await api(CHAT_ROUTES.read(conversationId), { method: 'POST', cookie })
      expect(read.status).toBe(200)
      expect((await json<ConversationDto>(read)).unreadCount).toBe(0)
    }

    // 买家再发一条：只应让**卖家**未读 +1（自己发的不算自己的未读）
    await api(CHAT_ROUTES.messages(conversationId), {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ content: '能便宜点吗' }),
    })

    const sellerRow = await conversationRow(sellerCookie)
    expect(sellerRow.role).toBe('seller')
    expect(sellerRow.unreadCount).toBe(1)
    expect(sellerRow.lastMessage).toMatchObject({
      type: 'TEXT',
      content: '能便宜点吗',
      senderId: await userIdOf(BUYER_NO),
    })

    const buyerRow = await conversationRow(buyerCookie)
    expect(buyerRow.role).toBe('buyer')
    expect(buyerRow.unreadCount).toBe(0)
    expect(buyerRow.lastMessage?.content).toBe('能便宜点吗')
    expect(buyerRow.counterpart.id).toBe(await userIdOf(SELLER_NO))

    // read 把未读推进到当前时刻 → 归零（列表与 read 响应两处口径一致）
    const read = await api(CHAT_ROUTES.read(conversationId), {
      method: 'POST',
      cookie: sellerCookie,
    })
    expect(read.status).toBe(200)
    expect((await json<ConversationDto>(read)).unreadCount).toBe(0)
    expect((await conversationRow(sellerCookie)).unreadCount).toBe(0)
  })

  test('WS：在线双方都收到 message.new，且不泄漏给非参与者', async () => {
    const seller = await connectRealtime(sellerCookie)
    const buyer = await connectRealtime(buyerCookie)
    const outsider = await connectRealtime(outsiderCookie) // 必须真的连上，才能验证「收不到」
    try {
      const sent = await api(CHAT_ROUTES.messages(conversationId), {
        method: 'POST',
        cookie: buyerCookie,
        body: JSON.stringify({ content: '我今晚可以来拿' }),
      })
      expect(sent.status).toBe(201)
      const created = await json<MessageDto>(sent)

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

      // 契约是「先落库、再推送」：收到帧时立刻回查历史，必须已经查得到
      const history = await json<{ items: MessageDto[] }>(
        await api(`${CHAT_ROUTES.messages(conversationId)}?limit=50`, { cookie: sellerCookie }),
      )
      expect(history.items.map((item) => item.id)).toContain(created.id)

      // 推送范围：非参与者一条都不该收到。
      // 缺这条负向断言时，「把消息广播给所有在线连接」的回归会让整个文件照样全绿。
      //
      // 不用 `sleep(150)` 造窗口：那是时基断言，机器一慢就 fail-open（越界帧还没到就断言完了）。
      // 改成**屏障**——再发一条消息并等它真的到达买卖双方，此时任何本应越界的帧都必然已经到达
      // （同一进程内 socket 到达不会晚于已验证的那两帧），再断言路人帧数为 0。
      const second = await json<MessageDto>(
        await api(CHAT_ROUTES.messages(conversationId), {
          method: 'POST',
          cookie: sellerCookie,
          body: JSON.stringify({ content: '好，那就这么定' }),
        }),
      )
      await waitFor(
        () => seller.frames.some((frame) => frame.message?.id === second.id),
        '卖家连接收到第二条 message.new',
      )
      await waitFor(
        () => buyer.frames.some((frame) => frame.message?.id === second.id),
        '买家连接收到第二条 message.new',
      )
      expect(outsider.frames.filter((frame) => frame.type === 'message.new')).toHaveLength(0)
      // 屏障本身要有效：路人连接是活的（否则 toHaveLength(0) 只是"没连上"的同义反复）
      expect(outsider.socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      seller.socket.close()
      buyer.socket.close()
      outsider.socket.close()
    }
  })

  test('WS：read 后双方都收到 conversation.read，且不泄漏给非参与者', async () => {
    const seller = await connectRealtime(sellerCookie)
    const buyer = await connectRealtime(buyerCookie)
    const outsider = await connectRealtime(outsiderCookie)
    try {
      const read = await api(CHAT_ROUTES.read(conversationId), {
        method: 'POST',
        cookie: buyerCookie,
      })
      expect(read.status).toBe(200)

      // 读位推进方自己的连接也要收到：同一用户可能有多个连接 / 多设备，读位得一起同步
      await waitFor(
        () => seller.frames.some((frame) => frame.type === 'conversation.read'),
        '卖家连接收到 conversation.read',
      )
      await waitFor(
        () => buyer.frames.some((frame) => frame.type === 'conversation.read'),
        '买家连接收到 conversation.read',
      )
      const pushed = seller.frames.find((frame) => frame.type === 'conversation.read')
      if (!pushed?.readAt) throw new Error('conversation.read 帧缺少 readAt')
      expect(pushed.conversationId).toBe(conversationId)
      expect(pushed.readerId).toBe(await userIdOf(BUYER_NO))

      // 推出去的 readAt 必须是**落库那一侧**的值：卖家视角回查会话，对方（买家）读位应与之相等。
      // 若 service 里另取一次 now()，本机 host 时钟比 DB 快约 48ms，会漂到落库值之后，
      // 客户端按它比对时最近一条会被误判成未读——这条断言钉的就是「用库里回读的那个值」。
      expect((await conversationRow(sellerCookie)).counterpartLastReadAt).toBe(pushed.readAt)

      // 非参与者一条都不该收到。屏障而非 sleep：再让卖家 read 一次并等它到达买卖双方，
      // 此时任何本应越界的帧都已经到达（与上一条 message.new 同一手法，避免时基断言 fail-open）。
      await api(CHAT_ROUTES.read(conversationId), { method: 'POST', cookie: sellerCookie })
      await waitFor(
        () => seller.frames.filter((frame) => frame.type === 'conversation.read').length >= 2,
        '卖家连接收到第二条 conversation.read',
      )
      await waitFor(
        () => buyer.frames.filter((frame) => frame.type === 'conversation.read').length >= 2,
        '买家连接收到第二条 conversation.read',
      )
      expect(outsider.frames.filter((frame) => frame.type === 'conversation.read')).toHaveLength(0)
      expect(outsider.socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      seller.socket.close()
      buyer.socket.close()
      outsider.socket.close()
    }
  })

  test('WS：未认证的 upgrade 被拒，连接不会建立（契约语义②）', async () => {
    await expect(connectRealtime()).rejects.toThrow('WebSocket 连接失败')
  })

  test('断线重连：重连后既能看到断线期间的消息，也能收到新推送', async () => {
    const seller = await connectRealtime(sellerCookie)
    seller.socket.close() // 先断开

    // 断线期间买家继续发消息
    const offline = await api(CHAT_ROUTES.messages(conversationId), {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ content: '我到楼下了' }),
    })
    expect(offline.status).toBe(201)

    // 重连后靠历史接口恢复（契约：离线重连不丢持久消息）
    const reconnected = await connectRealtime(sellerCookie)
    try {
      const history = await api(`${CHAT_ROUTES.messages(conversationId)}?limit=30`, {
        cookie: sellerCookie,
      })
      const page = await json<{ items: MessageDto[] }>(history)
      expect(page.items.map((item) => item.content)).toContain('我到楼下了')

      // 只验「历史查得到」不够：重连后的连接还必须能收到**新的**推送，
      // 否则「每个用户只保留第一条连接」这类回归会让整个文件通过。
      const fresh = await json<MessageDto>(
        await api(CHAT_ROUTES.messages(conversationId), {
          method: 'POST',
          cookie: buyerCookie,
          body: JSON.stringify({ content: '我到了' }),
        }),
      )
      await waitFor(
        () =>
          reconnected.frames.some(
            (frame) => frame.type === 'message.new' && frame.message?.id === fresh.id,
          ),
        '重连后的连接收到新的 message.new',
      )
    } finally {
      reconnected.socket.close()
    }
  })

  test('B 提案 → A 接受：Listing RESERVED、Transaction PENDING_MEETUP、SYSTEM 消息落库并实时推送', async () => {
    // 全程保持一条在线连接：SYSTEM 消息（tx.proposal / tx.accepted）同样必须走实时推送。
    // 若只在交易前连一次、验完就断，`app.ts` 把推送对象写错的回归在端到端层面无人发现
    // （`realtime/hub.ts` 的单测覆盖不到 app.ts 的这次接线）。
    const seller = await connectRealtime(sellerCookie)
    try {
      const proposed = await api(TRANSACTION_ROUTES.proposals, {
        method: 'POST',
        cookie: buyerCookie,
        body: JSON.stringify({ conversationId, amountCents: 15000 }),
      })
      expect(proposed.status).toBe(201)
      expect((await json<MessageDto>(proposed)).type).toBe('SYSTEM')

      await waitFor(
        () =>
          seller.frames.some(
            (frame) =>
              frame.message?.type === 'SYSTEM' &&
              (JSON.parse(frame.message.content) as { type: string }).type === 'tx.proposal',
          ),
        '卖家连接收到 tx.proposal 的实时推送',
      )

      const accepted = await api(TRANSACTION_ROUTES.accept, {
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

      await waitFor(
        () =>
          seller.frames.some(
            (frame) =>
              frame.message?.type === 'SYSTEM' &&
              (JSON.parse(frame.message.content) as { type: string }).type === 'tx.accepted',
          ),
        '卖家连接收到 tx.accepted 的实时推送',
      )

      // 会话里应能看到两条协议消息：提案与接受
      const history = await api(`${CHAT_ROUTES.messages(conversationId)}?limit=50`, {
        cookie: sellerCookie,
      })
      const page = await json<{ items: MessageDto[] }>(history)
      const systemTypes = page.items
        .filter((item) => item.type === 'SYSTEM')
        .map((item) => (JSON.parse(item.content) as { type: string }).type)
      expect(systemTypes).toEqual(['tx.proposal', 'tx.accepted'])
    } finally {
      seller.socket.close()
    }
  })

  test('双方 confirm：Transaction COMPLETED、Listing SOLD', async () => {
    const list = await api(`${TRANSACTION_ROUTES.base}?role=seller`, { cookie: sellerCookie })
    const page = await json<{ items: TransactionDto[] }>(list)
    const transactionId = page.items[0]?.id
    if (!transactionId) throw new Error('卖家应能看到刚创建的交易')

    const first = await api(TRANSACTION_ROUTES.confirm(transactionId), {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(first.status).toBe(200)
    expect((await json<TransactionDto>(first)).status).toBe('PENDING_MEETUP') // 只点了一边

    const second = await api(TRANSACTION_ROUTES.confirm(transactionId), {
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
      await api(PROFILE_ROUTES.me, { cookie: sellerCookie }),
    )
    const buyerProfile = await json<ProfileResponse>(
      await api(PROFILE_ROUTES.me, { cookie: buyerCookie }),
    )

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
      await api(PROFILE_ROUTES.me, { cookie: outsiderCookie }),
    )
    expect(outsiderProfile.transactions).toHaveLength(0)
  })

  test('完成后他人再接受同一商品：409（不产生第二笔 live 交易）', async () => {
    const outsiderConversation = await api(CHAT_ROUTES.base, {
      method: 'POST',
      cookie: outsiderCookie,
      body: JSON.stringify({ listingId }),
    })
    expect(outsiderConversation.status).toBe(201)

    const rejected = await api(TRANSACTION_ROUTES.accept, {
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
    const conversation = await api(CHAT_ROUTES.base, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId: secondListingId }),
    })
    const secondConversationId = (await json<{ id: string }>(conversation)).id

    await api(TRANSACTION_ROUTES.proposals, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ conversationId: secondConversationId, amountCents: 9000 }),
    })
    const accepted = await api(TRANSACTION_ROUTES.accept, {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({ conversationId: secondConversationId, amountCents: 9000 }),
    })
    expect(accepted.status).toBe(201)
    const transactionId = (await json<TransactionDto>(accepted)).id
    expect(await listingStatus(secondListingId)).toBe('RESERVED')

    const cancelled = await api(TRANSACTION_ROUTES.cancel(transactionId), {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(cancelled.status).toBe(200)
    expect((await json<TransactionDto>(cancelled)).status).toBe('CANCELLED')
    // 取消后恢复可用性：商品回到 ACTIVE
    expect(await listingStatus(secondListingId)).toBe('ACTIVE')

    // 终态不接受前进：CANCELLED 上 confirm → 409
    const afterCancel = await api(TRANSACTION_ROUTES.confirm(transactionId), {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(afterCancel.status).toBe(409)
  })

  test('非法终态转换：COMPLETED 上 cancel 被拒，商品不被回退', async () => {
    const list = await api(`${TRANSACTION_ROUTES.base}?role=seller&status=COMPLETED`, {
      cookie: sellerCookie,
    })
    const page = await json<{ items: TransactionDto[] }>(list)
    const completedId = page.items[0]?.id
    if (!completedId) throw new Error('应能按 status 过滤出已完成的交易')

    const cancelled = await api(TRANSACTION_ROUTES.cancel(completedId), {
      method: 'POST',
      cookie: sellerCookie,
    })
    expect(cancelled.status).toBe(409)
    expect(await listingStatus()).toBe('SOLD')
  })

  test('reject 全流程：卖家拒绝 → tx.rejected，且不产生交易、商品仍 ACTIVE', async () => {
    const rejectedListingId = await insertListing(
      await userIdOf(SELLER_NO),
      '01990000-0000-7000-8000-0000000000b3',
    )
    const conversation = await api(CHAT_ROUTES.base, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ listingId: rejectedListingId }),
    })
    expect(conversation.status).toBe(201)
    const rejectConversationId = (await json<{ id: string }>(conversation)).id

    const proposed = await api(TRANSACTION_ROUTES.proposals, {
      method: 'POST',
      cookie: buyerCookie,
      body: JSON.stringify({ conversationId: rejectConversationId, amountCents: 12000 }),
    })
    expect(proposed.status).toBe(201)

    const rejected = await api(TRANSACTION_ROUTES.reject, {
      method: 'POST',
      cookie: sellerCookie,
      body: JSON.stringify({ conversationId: rejectConversationId }),
    })
    expect(rejected.status).toBe(200)
    const systemMessage = await json<MessageDto>(rejected)
    expect(systemMessage.type).toBe('SYSTEM')
    expect((JSON.parse(systemMessage.content) as { type: string }).type).toBe('tx.rejected')

    const history = await json<{ items: MessageDto[] }>(
      await api(`${CHAT_ROUTES.messages(rejectConversationId)}?limit=50`, { cookie: buyerCookie }),
    )
    expect(
      history.items
        .filter((item) => item.type === 'SYSTEM')
        .map((item) => (JSON.parse(item.content) as { type: string }).type),
    ).toEqual(['tx.proposal', 'tx.rejected'])

    // 拒绝只往会话写一条 SYSTEM 消息：不建交易行，商品仍可被别人接受
    expect(await listingStatus(rejectedListingId)).toBe('ACTIVE')
    expect(await transactionCountFor(rejectedListingId)).toBe(0)
  })

  test('并发争抢：两个买家同时被接受，只有一个成功、另一个 409 LISTING_NOT_ACTIVE', async () => {
    const raceListingId = await insertListing(
      await userIdOf(SELLER_NO),
      '01990000-0000-7000-8000-0000000000b4',
    )

    // 两个不同买家对同一 ACTIVE 商品各建会话并提案
    const [conversationA, conversationB] = await Promise.all(
      [buyerCookie, outsiderCookie].map(async (cookie) => {
        const created = await api(CHAT_ROUTES.base, {
          method: 'POST',
          cookie,
          body: JSON.stringify({ listingId: raceListingId }),
        })
        expect(created.status).toBe(201)
        const id = (await json<{ id: string }>(created)).id
        const proposed = await api(TRANSACTION_ROUTES.proposals, {
          method: 'POST',
          cookie,
          body: JSON.stringify({ conversationId: id, amountCents: 8000 }),
        })
        expect(proposed.status).toBe(201)
        return id
      }),
    )

    // 真并发：两个 accept 同时在飞。条件更新（`AND status='ACTIVE'`）与 transactions 的
    // 部分唯一索引共同保证只有一个 201；输的一方必须是明确的 409 业务码，而不是 500。
    //
    // 如实标注本用例的**检测边界**：它断言的是对外可观测契约（只落 1 笔交易、另一笔 409
    // 而不是 500）。实测把 store 的条件更新去掉后本用例仍然全绿——唯一索引会把第二笔的
    // 23505 映射成同一个 `LISTING_NOT_ACTIVE`。要单独锁住「条件更新」这一层，只能靠 store
    // 层用例（`transactions/store.test.ts`）或去掉索引，不在本验收的范围内。
    const [first, second] = await Promise.all([
      api(TRANSACTION_ROUTES.accept, {
        method: 'POST',
        cookie: sellerCookie,
        body: JSON.stringify({ conversationId: conversationA, amountCents: 8000 }),
      }),
      api(TRANSACTION_ROUTES.accept, {
        method: 'POST',
        cookie: sellerCookie,
        body: JSON.stringify({ conversationId: conversationB, amountCents: 8000 }),
      }),
    ])

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409])
    const loser = first.status === 409 ? first : second
    expect(await json<{ error: { code: string } }>(loser)).toMatchObject({
      error: { code: 'LISTING_NOT_ACTIVE' },
    })
    expect(await transactionCountFor(raceListingId)).toBe(1)
    expect(await listingStatus(raceListingId)).toBe('RESERVED')
  })

  test('Profile 与 Wish 一致：愿望接口写入后，profile 的愿望与统计同口径', async () => {
    // 用契约常量而不是硬编码路径：PR #44 把 wishes 路由从 /api/wishes 收敛到根级 /wishes，
    // 契约常量在两种状态下都指向当前真实路径。
    const createWish = async (keyword: string): Promise<string> => {
      const response = await api(WISH_ROUTES.base, {
        method: 'POST',
        cookie: buyerCookie,
        body: JSON.stringify({
          keyword,
          category: 'DIGITAL',
          budgetMinCents: 10000,
          budgetMaxCents: 20000,
        }),
      })
      expect(response.status).toBe(201)
      return (await json<{ id: string }>(response)).id
    }

    const activeWishId = await createWish('机械键盘')
    // 第二条愿望随后 close 掉。必要性：统计只应数 ACTIVE，而 profile.wishes 是全量列表。
    // 只造一条 ACTIVE 时两边都由构造方式决定、恒等，`stats.activeWishes === items.length`
    // 形同同义反复——把统计里的 `AND status = 'ACTIVE'` 去掉，整个文件照样全绿。
    const closedWishId = await createWish('显示器')
    const closed = await api(WISH_ROUTES.close(closedWishId), {
      method: 'POST',
      cookie: buyerCookie,
    })
    expect(closed.status).toBe(200)

    const activeWishes = await json<{ items: { id: string }[] }>(
      await api(`${WISH_ROUTES.base}?status=ACTIVE&page=1&pageSize=20`, { cookie: buyerCookie }),
    )
    const profile = await json<ProfileResponse>(
      await api(PROFILE_ROUTES.me, { cookie: buyerCookie }),
    )

    // #38 修过的坑：同一份数据在 /wishes 与 /profile 必须给出一致的条数，
    // 否则个人中心「愿望 N 条」与愿望页对不上。
    expect(profile.wishes.map((wish) => wish.id)).toContain(activeWishId)
    expect(profile.wishes.map((wish) => wish.id)).toContain(closedWishId)
    expect(activeWishes.items.map((wish) => wish.id)).toEqual([activeWishId])
    expect(profile.stats.activeWishes).toBe(1) // 写成具体数字：挡住「把 CLOSED 也数进去」
    expect(profile.stats.activeWishes).toBe(activeWishes.items.length)
  })
})
