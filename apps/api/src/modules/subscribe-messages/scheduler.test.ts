import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { SubscribeMessageClient } from './client'
import {
  CHAT_THROTTLE_MS,
  CHAT_UNREAD_DELAY_MS,
  createSubscribeMessageScheduler,
  NOTIFICATION_LOOKBACK_MS,
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
const DELIVERY = '01930000-0000-7000-8000-000000000006'
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
}

function harness(
  input: {
    notifications?: NotificationDeliverySource[]
    chats?: ChatDeliverySource[]
    titles?: Map<string, string>
    pending?: string[]
    failedRegister?: 'notifications' | 'chat'
    failPending?: boolean
  } = {},
): Harness {
  const inserted: NewSubscribeDelivery[][] = []
  const attempted: { id: string; signal: string }[] = []
  const sendCalls: Harness['sendCalls'] = []
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
    async listNotificationSources(since) {
      if (input.failedRegister === 'notifications') throw new Error('db down')
      // 顺带钉住窗口：调度器必须传"当前时间 - 30 分钟"
      expect(since.getTime()).toBe(AT.getTime() - NOTIFICATION_LOOKBACK_MS)
      return input.notifications ?? []
    },
    async findListingTitles() {
      return input.titles ?? new Map()
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

  return { store, inserted, attempted, openids, sendCalls }
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
  } = {},
) {
  return createSubscribeMessageScheduler({
    db: {} as never,
    store: h.store,
    client: options.client === undefined ? fakeClient() : options.client,
    capability: options.capability ?? ALL_TEMPLATES,
    now: () => AT,
    log: () => {},
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
    expect(run).toEqual({ registered: 0, sent: 0, skipped: 0, failed: 0, retry: 0 })
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

describe('start / stop', () => {
  test('能力关闭时不建定时器（start 只记一行日志）', () => {
    const h = harness()
    const scheduler = build(h, { client: null })
    // 不抛、不建定时器；stop 幂等
    expect(() => scheduler.start()).not.toThrow()
    expect(() => scheduler.stop()).not.toThrow()
  })
})
