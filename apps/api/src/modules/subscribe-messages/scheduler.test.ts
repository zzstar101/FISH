import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { SubscribeMessageClient } from './client'
import {
  CHAT_THROTTLE_MS,
  CHAT_UNREAD_DELAY_MS,
  createSubscribeMessageScheduler,
  NOTIFICATION_LOOKBACK_MS,
  SENDING_ABANDON_AFTER_MS,
} from './scheduler'
import type { SubscribeMessageCapability } from './service'
import type {
  AttemptOutcome,
  ChatDeliverySource,
  LockedDelivery,
  NewSubscribeDelivery,
  NotificationDeliverySource,
  SubscribeMessageStore,
} from './store'

/**
 * 投递调度（#462）的编排用例。
 *
 * 用**假 store + 假 client**：这层要钉的是"每轮登记什么、发之前过哪几道门、失败怎么隔离"，
 * 而 dedupe / 额度扣减 / 并发这类真 SQL 语义在 `store.test.ts`（真库用例）里。
 */

const AT = new Date('2026-11-01T02:30:00.000Z')
const USER = '01930000-0000-7000-8000-000000000001'
const LISTING = '01930000-0000-7000-8000-000000000002'
const CONVERSATION = '01930000-0000-7000-8000-000000000003'
const TXN = '01930000-0000-7000-8000-000000000004'
const MESSAGE = '01930000-0000-7000-8000-000000000005'
const DISPUTE = '01930000-0000-7000-8000-000000000007'
const DELIVERY = '01930000-0000-7000-8000-000000000006'
const DELIVERY_2 = '01930000-0000-7000-8000-000000000008'
// 投递行里的跳转页用的是**对外 ID**（`cnv_...` / `txn_...`），与小程序路由参数同源
const TXN_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.transaction, TXN)
const CONVERSATION_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.conversation, CONVERSATION)

const ALL_TEMPLATES: SubscribeMessageCapability = {
  enabled: true,
  templateIds: { CHAT: 'tmpl_chat', TX: 'tmpl_tx', REVIEW: 'tmpl_review' },
}

type Harness = {
  store: SubscribeMessageStore
  inserted: NewSubscribeDelivery[][]
  attempted: { id: string; signal: string }[]
  openids: Map<string, string>
  sendCalls: { openid: string; templateId: string; page: string; data: Record<string, string> }[]
  /** 每次 `findTransactionListingTitles` 收到的交易 id 列表（钉住调度器传了什么）。 */
  transactionTitleQueries: string[][]
  /** 每次 `insertChatDeliveries` 的入参（聊天登记走的是带限频复核的那个入口）。 */
  chatRegistrations: { rows: NewSubscribeDelivery[]; throttleSince: Date }[]
  /** 每轮 `abandonStaleSending` 的入参（钉住阈值）。 */
  staleSweeps: { now: Date; staleBefore: Date }[]
}

function harness(
  input: {
    notifications?: NotificationDeliverySource[]
    chats?: ChatDeliverySource[]
    titles?: Map<string, string>
    transactionTitles?: Map<string, string>
    pending?: string[]
    /** 本轮清扫到的「发送中断」孤儿行数。 */
    staleSending?: number
    failedRegister?: 'notifications' | 'chat'
    failPending?: boolean
  } = {},
): Harness {
  const inserted: NewSubscribeDelivery[][] = []
  const attempted: { id: string; signal: string }[] = []
  const sendCalls: Harness['sendCalls'] = []
  const transactionTitleQueries: string[][] = []
  const chatRegistrations: Harness['chatRegistrations'] = []
  const staleSweeps: Harness['staleSweeps'] = []
  const openids = new Map([[USER, 'o-openid-for-user']])

  const store: SubscribeMessageStore = {
    async readRemaining() {
      return { CHAT: 5, TX: 5, REVIEW: 5 }
    },
    async addAcceptedGrants() {},
    async insertDeliveries(rows) {
      inserted.push(rows)
      return rows.length
    },
    async insertChatDeliveries(rows, throttleSince) {
      chatRegistrations.push({ rows, throttleSince })
      inserted.push(rows)
      return rows.length
    },
    async listNotificationSources(since) {
      if (input.failedRegister === 'notifications') throw new Error('db down')
      // 顺带钉住窗口：调度器必须传"当前时间 - 30 分钟"
      expect(since.getTime()).toBe(AT.getTime() - NOTIFICATION_LOOKBACK_MS)
      return input.notifications ?? []
    },
    async findListingTitles() {
      return input.titles ?? new Map()
    },
    async findTransactionListingTitles(ids) {
      // 顺带钉住调度器确实把 `payload.transactionId` 送进来了
      transactionTitleQueries.push(ids)
      return input.transactionTitles ?? new Map()
    },
    async listChatSources({ unreadBefore, throttleSince }) {
      if (input.failedRegister === 'chat') throw new Error('db down')
      expect(unreadBefore.getTime()).toBe(AT.getTime() - CHAT_UNREAD_DELAY_MS)
      expect(throttleSince.getTime()).toBe(AT.getTime() - CHAT_THROTTLE_MS)
      return input.chats ?? []
    },
    async listPendingDeliveryIds() {
      if (input.failPending) throw new Error('db down')
      return input.pending ?? []
    },
    async abandonStaleSending(now, staleBefore) {
      staleSweeps.push({ now, staleBefore })
      return input.staleSending ?? 0
    },
    async attemptDelivery(id, _now, send): Promise<AttemptOutcome> {
      const delivery: LockedDelivery = {
        id,
        recipientId: USER,
        kind: 'TX',
        data: { thing6: '商品' },
        page: 'pkg-trade/pages/transaction-meetup/index?id=txn',
        attempts: 0,
      }
      const signal = await send(delivery)
      attempted.push({ id, signal: JSON.stringify(signal) })
      if (signal.ok) {
        sendCalls.push({
          openid: 'unused',
          templateId: 'unused',
          page: delivery.page,
          data: delivery.data,
        })
      }
      return { outcome: 'sent' }
    },
    async findOpenid(userId) {
      return openids.get(userId) ?? null
    },
  }

  return {
    store,
    inserted,
    attempted,
    openids,
    sendCalls,
    transactionTitleQueries,
    chatRegistrations,
    staleSweeps,
  }
}

function fakeClient(): SubscribeMessageClient & { calls: Harness['sendCalls'] } {
  const calls: Harness['sendCalls'] = []
  return {
    calls,
    async send(request) {
      calls.push(request)
      return { ok: true }
    },
  }
}

function build(
  h: Harness,
  options: {
    client?: SubscribeMessageClient | null
    capability?: SubscribeMessageCapability
    stopTimeoutMs?: number
  } = {},
) {
  return createSubscribeMessageScheduler({
    db: {} as never,
    store: h.store,
    client: options.client === undefined ? fakeClient() : options.client,
    capability: options.capability ?? ALL_TEMPLATES,
    now: () => AT,
    log: () => {},
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  })
}

const txNotification: NotificationDeliverySource = {
  id: '01930000-0000-7000-8000-0000000000aa',
  userId: USER,
  type: 'TX',
  payload: {
    event: 'ACCEPTED',
    transactionId: TXN,
    conversationId: CONVERSATION,
    listingId: LISTING,
  },
  createdAt: AT,
}

describe('runOnce：能力关闭', () => {
  test('没有 client（非 live）时不登记也不发', async () => {
    const h = harness({ notifications: [txNotification], pending: [DELIVERY] })
    const run = await build(h, { client: null }).runOnce()
    expect(run).toEqual({ registered: 0, abandoned: 0, sent: 0, skipped: 0, failed: 0, retry: 0 })
    expect(h.inserted).toHaveLength(0)
    expect(h.attempted).toHaveLength(0)
  })

  test('一个模板都没配时同样不动（enabled=false）', async () => {
    const h = harness({ notifications: [txNotification] })
    const run = await build(h, {
      capability: { enabled: false, templateIds: { CHAT: null, TX: null, REVIEW: null } },
    }).runOnce()
    expect(run.registered).toBe(0)
    expect(h.inserted).toHaveLength(0)
  })
})

describe('runOnce：登记', () => {
  test('TX 通知 → 一条 NOTIFICATION 投递行，内容与跳转页已渲染好', async () => {
    const h = harness({
      notifications: [txNotification],
      titles: new Map([[LISTING, '九成新自行车']]),
    })
    const run = await build(h).runOnce()

    expect(run.registered).toBe(1)
    expect(h.inserted[0]).toEqual([
      {
        sourceType: 'NOTIFICATION',
        sourceId: txNotification.id,
        recipientId: USER,
        kind: 'TX',
        data: {
          thing6: '九成新自行车',
          phrase3: '已接受',
          time8: '2026-11-01 10:30',
          thing5: '点击查看交易详情',
        },
        page: `pkg-trade/pages/transaction-meetup/index?id=${TXN_PUBLIC}`,
        conversationId: null,
      },
    ])
  })

  test('DISPUTE 通知按 transactionId 取商品标题（生产者的 payload 没有 listingId）', async () => {
    // 生产者 `apps/api/src/app.ts` 的 `notifyDispute` 只写 disputeId / transactionId /
    // disputeEvent（+ resolution），**没有 listingId**：只按 `payload.listingId` 取标题的话，
    // 纠纷提醒的商品名永远是兜底占位「交易商品」。
    const dispute: NotificationDeliverySource = {
      id: '01930000-0000-7000-8000-0000000000dd',
      userId: USER,
      type: 'DISPUTE',
      payload: { disputeId: DISPUTE, transactionId: TXN, disputeEvent: 'FILED' },
      createdAt: AT,
    }
    const h = harness({
      notifications: [dispute],
      transactionTitles: new Map([[TXN, '九成新自行车']]),
    })
    const run = await build(h).runOnce()

    expect(h.transactionTitleQueries).toEqual([[TXN]])
    expect(run.registered).toBe(1)
    expect(h.inserted[0]?.[0]).toMatchObject({
      kind: 'TX',
      data: { thing6: '九成新自行车', phrase3: '纠纷处理中' },
      page: `pkg-trade/pages/transaction-meetup/index?id=${TXN_PUBLIC}`,
    })
  })

  test('DISPUTE 查不到商品（交易已不在）时退到占位名，不丢这条提醒', async () => {
    const dispute: NotificationDeliverySource = {
      id: '01930000-0000-7000-8000-0000000000ee',
      userId: USER,
      type: 'DISPUTE',
      payload: {
        disputeId: DISPUTE,
        transactionId: TXN,
        disputeEvent: 'RESOLVED',
        resolution: 'UPHELD',
      },
      createdAt: AT,
    }
    const h = harness({ notifications: [dispute] })
    await build(h).runOnce()

    expect(h.inserted[0]?.[0]?.data.thing6).toBe('交易商品')
    expect(h.inserted[0]?.[0]?.data.phrase3).toBe('纠纷已处理')
  })

  test('映射不出页面的通知不登记（MATCH / 无交易无会话的 TX）', async () => {
    const h = harness({
      notifications: [
        {
          ...txNotification,
          id: '01930000-0000-7000-8000-0000000000bb',
          type: 'MATCH',
          payload: {},
        },
        {
          ...txNotification,
          id: '01930000-0000-7000-8000-0000000000cc',
          payload: { event: 'ACCEPTED' },
        },
      ],
    })
    const run = await build(h).runOnce()
    expect(run.registered).toBe(0)
  })

  test('聊天来源 → CHAT 投递行（内容固定「你有一条新消息」，带会话 UUID 供限频）', async () => {
    const h = harness({
      chats: [
        {
          messageId: MESSAGE,
          conversationId: CONVERSATION,
          recipientId: USER,
          senderNickname: '林一',
          listingTitle: '九成新自行车',
          messageCreatedAt: AT,
        },
      ],
    })
    const run = await build(h).runOnce()

    expect(run.registered).toBe(1)
    // 聊天登记必须走**带限频复核**的那个入口：`insertDeliveries` 不复查窗口，
    // 多实例并发时同一「会话 × 收件人」会各插一条（#511 审查 high）。
    expect(h.chatRegistrations).toHaveLength(1)
    expect(h.chatRegistrations[0]?.throttleSince.getTime()).toBe(AT.getTime() - CHAT_THROTTLE_MS)
    expect(h.inserted[0]).toEqual([
      {
        sourceType: 'CHAT',
        sourceId: MESSAGE,
        recipientId: USER,
        kind: 'CHAT',
        data: {
          thing4: '林一',
          thing2: '你有一条新消息',
          thing28: '九成新自行车',
          time3: '2026-11-01 10:30',
        },
        page: `pkg-social/pages/conversation/index?id=${CONVERSATION_PUBLIC}`,
        conversationId: CONVERSATION,
      },
    ])
  })

  test('聊天来源里商品已删除（标题为 NULL）仍然投递，用占位名', async () => {
    const h = harness({
      chats: [
        {
          messageId: MESSAGE,
          conversationId: CONVERSATION,
          recipientId: USER,
          senderNickname: '林一',
          listingTitle: null,
          messageCreatedAt: AT,
        },
      ],
    })
    await build(h).runOnce()
    expect(h.inserted[0]?.[0]?.data.thing28).toBe('会话商品')
  })

  test('一段登记挂了不影响另一段（通知查询抛错时聊天照常登记）', async () => {
    const h = harness({
      failedRegister: 'notifications',
      chats: [
        {
          messageId: MESSAGE,
          conversationId: CONVERSATION,
          recipientId: USER,
          senderNickname: '林一',
          listingTitle: '九成新自行车',
          messageCreatedAt: AT,
        },
      ],
    })
    const run = await build(h).runOnce()
    expect(run.registered).toBe(1)
  })

  test('登记阶段整体异常不会让 runOnce 抛出', async () => {
    const h = harness({ failedRegister: 'chat', notifications: [txNotification] })
    await expect(build(h).runOnce()).resolves.toMatchObject({ registered: 1 })
  })
})

describe('runOnce：发送', () => {
  test('到点的行交给 client.send，模板 ID 取自能力配置', async () => {
    const h = harness({ pending: [DELIVERY] })
    const client = fakeClient()
    const run = await build(h, { client }).runOnce()

    expect(run.sent).toBe(1)
    expect(client.calls).toEqual([
      {
        openid: 'o-openid-for-user',
        templateId: 'tmpl_tx',
        page: 'pkg-trade/pages/transaction-meetup/index?id=txn',
        data: { thing6: '商品' },
      },
    ])
  })

  test('收件人没有微信身份 → 本地 SKIPPED（不发、不扣额度）', async () => {
    const h = harness({ pending: [DELIVERY] })
    h.openids.clear()
    const client = fakeClient()
    await build(h, { client }).runOnce()

    expect(client.calls).toHaveLength(0)
    expect(h.attempted[0]?.signal).toBe('{"ok":false,"reason":"skip","detail":"no_openid"}')
  })

  test('该 kind 的模板在发版后被摘掉 → 本地 SKIPPED（no_template）', async () => {
    const h = harness({ pending: [DELIVERY] })
    const client = fakeClient()
    await build(h, {
      client,
      capability: { enabled: true, templateIds: { CHAT: null, TX: null, REVIEW: 'tmpl_review' } },
    }).runOnce()

    expect(client.calls).toHaveLength(0)
    expect(h.attempted[0]?.signal).toBe('{"ok":false,"reason":"skip","detail":"no_template"}')
  })

  test('发送阶段异常被吞掉：runOnce 不抛，其它行继续', async () => {
    const h = harness({ pending: [DELIVERY] })
    h.store.attemptDelivery = async () => {
      throw new Error('deadlock detected')
    }
    await expect(build(h).runOnce()).resolves.toMatchObject({ sent: 0 })
  })
})

describe('runOnce：发送中断的孤儿行', () => {
  test('每轮先清扫「发送中」超时的行，条数记进本轮结果', async () => {
    const h = harness({ staleSending: 2 })
    const run = await build(h).runOnce()

    expect(run.abandoned).toBe(2)
    expect(h.staleSweeps).toHaveLength(1)
    // 阈值 = 当前时间 - SENDING_ABANDON_AFTER_MS
    expect(h.staleSweeps[0]?.staleBefore.getTime()).toBe(AT.getTime() - SENDING_ABANDON_AFTER_MS)
  })

  test('清扫查询挂了不影响本轮其余工作', async () => {
    const h = harness({ pending: [DELIVERY] })
    h.store.abandonStaleSending = async () => {
      throw new Error('db down')
    }
    await expect(build(h).runOnce()).resolves.toMatchObject({ abandoned: 0, sent: 1 })
  })
})

describe('start / stop', () => {
  test('能力关闭时不建定时器（start 只记一行日志）', async () => {
    const h = harness()
    const scheduler = build(h, { client: null })
    // 不抛、不建定时器；stop 幂等
    expect(() => scheduler.start()).not.toThrow()
    await expect(scheduler.stop()).resolves.toBeUndefined()
    await expect(scheduler.stop()).resolves.toBeUndefined()
  })

  test('停机等在对途投递上：那条落定之前 stop() 不返回', async () => {
    const h = harness({ pending: [DELIVERY] })
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    h.store.attemptDelivery = async () => {
      started()
      await blocked
      return { outcome: 'sent' }
    }

    const scheduler = build(h)
    const round = scheduler.runOnce()
    // 先等那条真的进入在途（否则停机赶在第一批之前，压根没有"在途"可等）
    await firstStarted

    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(10)
    // 在途那条还没落定，stop() 必须还在等 —— 这时候退出就是"微信已发、本地没记"
    expect(stopped).toBe(false)

    release()
    await Promise.all([round, stopping])
    expect(stopped).toBe(true)
  })

  test('停机中不再开新的发送：在途那条收口后本轮结束，其余留给下一轮', async () => {
    const h = harness({ pending: [DELIVERY, DELIVERY_2] })
    const attemptedIds: string[] = []
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    h.store.attemptDelivery = async (id) => {
      attemptedIds.push(id)
      if (id === DELIVERY) {
        started()
        await blocked
      }
      return { outcome: 'sent' }
    }

    const scheduler = build(h)
    const round = scheduler.runOnce()
    await firstStarted
    void scheduler.stop()
    await Bun.sleep(10)
    release()
    await round

    // 第二条没有被发起：停机后不再开新的上游调用
    expect(attemptedIds).toEqual([DELIVERY])
  })

  test('停机等待有上限：在途一轮卡死时 stop() 仍会返回', async () => {
    const h = harness({ pending: [DELIVERY] })
    h.store.attemptDelivery = () => new Promise(() => {})
    const scheduler = build(h, { stopTimeoutMs: 20 })
    void scheduler.runOnce()
    await Bun.sleep(5)

    const startedAt = Date.now()
    await scheduler.stop()

    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
