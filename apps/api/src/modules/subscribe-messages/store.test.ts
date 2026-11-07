import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { conversations } from '@fish/db/schema/conversations'
import { listings } from '@fish/db/schema/listings'
import { messages } from '@fish/db/schema/messages'
import { notifications } from '@fish/db/schema/notifications'
import {
  subscribeMessageDeliveries,
  subscribeMessageGrants,
} from '@fish/db/schema/subscribe-messages'
import { transactions } from '@fish/db/schema/transactions'
import { users, wechatIdentities } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { and, eq, inArray } from 'drizzle-orm'
import { createSqlSubscribeMessageStore, type NewSubscribeDelivery } from './store'

/**
 * 授权记账与投递状态机的**真库**用例（#462）：封顶、去重、额度扣减的原子性、并发不重复扣减。
 *
 * 这些语义只能靠 SQL 表达（`least()` 封顶、`ON CONFLICT DO NOTHING` 去重、
 * `FOR UPDATE SKIP LOCKED` 占行），假 store 测不到，所以必须是集成用例。
 * 与仓库其它集成测试同约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlSubscribeMessageStore(db)

const created: string[] = []
let seq = 0

async function newUser(nickname = '订阅测试'): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ studentNo: `sub-${Date.now()}-${seq++}`, passwordHash: 'test-hash', nickname })
    .returning({ id: users.id })
  const id = rows[0]?.id
  if (!id) throw new Error('insert users 未返回行')
  created.push(id)
  return id
}

/**
 * 记 `count` 次「允许」。`addAcceptedGrants` 的第三个参数是**封顶值**、每次只 +1，
 * 所以模拟"用户点了 5 次允许"必须调 5 次。
 */
async function grant(userId: string, kind: 'CHAT' | 'TX' | 'REVIEW', count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await store.addAcceptedGrants(userId, [kind], 50)
}

/**
 * 造一条立即到期的待发夹具，返回它的 id。
 * nextAttemptAt 与 attemptDelivery 的 now 使用同一测试进程时钟，避免数据库
 * defaultNow() 与宿主时钟偏差让状态机用例错误地落入 not-due。
 */
async function newDelivery(
  recipientId: string,
  overrides: Partial<NewSubscribeDelivery> = {},
): Promise<string> {
  const rows = await db
    .insert(subscribeMessageDeliveries)
    .values({
      sourceType: 'NOTIFICATION',
      // 每条一个唯一来源 id：默认值互不冲突，需要测去重时由调用方传同一个
      sourceId: crypto.randomUUID(),
      recipientId,
      kind: 'TX',
      data: {
        thing6: '九成新自行车',
        phrase3: '已接受',
        time8: '2026-11-01 10:30',
        thing5: '备注',
      },
      page: 'pkg-trade/pages/transaction-meetup/index?id=txn_x',
      // 「立即待投递」与用例传进 attemptDelivery 的 `now` 用同一个时钟（见函数注释）
      nextAttemptAt: new Date(),
      ...overrides,
    })
    .returning({ id: subscribeMessageDeliveries.id })
  const id = rows[0]?.id
  if (!id) throw new Error('insert subscribe_message_deliveries 未返回行')
  return id
}

async function deliveryRow(id: string) {
  const [row] = await db
    .select()
    .from(subscribeMessageDeliveries)
    .where(eq(subscribeMessageDeliveries.id, id))
  if (!row) throw new Error('投递行不存在')
  return row
}

afterAll(async () => {
  // 会话/商品/交易对 users 是 NO ACTION 外键（不随用户删除连带），必须先自己清掉；
  // 消息随会话 CASCADE，通知与订阅消息两张表随用户 CASCADE。
  if (createdTransactions.length > 0) {
    await db.delete(transactions).where(inArray(transactions.id, createdTransactions))
  }
  if (createdConversations.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversations))
  }
  if (createdListings.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListings))
  }
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created))
  await db.$client.close()
})

describe('readRemaining / addAcceptedGrants', () => {
  test('没有记账行时三个 kind 都是 0', async () => {
    const me = await newUser()
    expect(await store.readRemaining(me)).toEqual({ CHAT: 0, TX: 0, REVIEW: 0 })
  })

  test('每次「允许」+1，重复调用累加，且只影响传入的 kind', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['CHAT'], 50)
    await store.addAcceptedGrants(me, ['CHAT'], 50)
    await store.addAcceptedGrants(me, ['TX'], 50)

    expect(await store.readRemaining(me)).toEqual({ CHAT: 2, TX: 1, REVIEW: 0 })
  })

  test('封顶：连加到超过上限时停在 50（least() 在 SQL 里，不会因并发突破）', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['REVIEW'], 50)
    // 直接把剩余撞到上限，再各加一次：模拟"已经满额还继续上报"
    await db
      .update(subscribeMessageGrants)
      .set({ remaining: 50 })
      .where(and(eq(subscribeMessageGrants.userId, me), eq(subscribeMessageGrants.kind, 'REVIEW')))

    await store.addAcceptedGrants(me, ['REVIEW'], 50)
    expect((await store.readRemaining(me)).REVIEW).toBe(50)
  })

  test('一次传入多个 kind 时各自 +1', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['CHAT', 'TX', 'REVIEW'], 50)
    expect(await store.readRemaining(me)).toEqual({ CHAT: 1, TX: 1, REVIEW: 1 })
  })
})

describe('insertDeliveries', () => {
  test('同一来源对同一人只登记一条：第二次插入返回 0 行', async () => {
    const me = await newUser()
    const sourceId = crypto.randomUUID()
    const row: NewSubscribeDelivery = {
      sourceType: 'NOTIFICATION',
      sourceId,
      recipientId: me,
      kind: 'TX',
      data: { thing6: '商品' },
      page: 'pkg-trade/pages/transaction-meetup/index?id=txn_x',
    }

    expect(await store.insertDeliveries([row, row])).toBe(1)
    expect(await store.insertDeliveries([row])).toBe(0)
  })

  test('同一条来源对不同收件人各登记一条（去重键含 recipient_id）', async () => {
    const me = await newUser()
    const other = await newUser()
    const sourceId = crypto.randomUUID()
    const base = {
      sourceType: 'CHAT' as const,
      sourceId,
      kind: 'CHAT' as const,
      data: { thing4: '林一' },
      page: 'pkg-social/pages/conversation/index?id=cnv_x',
    }

    expect(
      await store.insertDeliveries([
        { ...base, recipientId: me },
        { ...base, recipientId: other },
      ]),
    ).toBe(2)
  })
})

describe('attemptDelivery', () => {
  test('成功：状态 SENT、attempts 1、sent_at 有值，额度 -1', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 50)
    const id = await newDelivery(me)
    const now = new Date()

    const outcome = await store.attemptDelivery(id, now, async () => ({ ok: true }))
    expect(outcome).toEqual({ outcome: 'sent' })

    const row = await deliveryRow(id)
    expect(row.status).toBe('SENT')
    expect(row.attempts).toBe(1)
    expect(row.sentAt).not.toBeNull()
    expect((await store.readRemaining(me)).TX).toBe(0)
  })

  test('额度为 0 时一条都不发，行转 SKIPPED 且原因可查（no_quota）', async () => {
    const me = await newUser() // 没有记账行 = 0 次
    const id = await newDelivery(me)
    let sent = 0

    const outcome = await store.attemptDelivery(id, new Date(), async () => {
      sent += 1
      return { ok: true }
    })

    expect(outcome).toEqual({ outcome: 'skipped' })
    expect(sent).toBe(0)
    const row = await deliveryRow(id)
    expect(row.status).toBe('SKIPPED')
    expect(row.lastError).toBe('no_quota')
    expect(row.attempts).toBe(0)
  })

  test('并发两条同时抢同一行：只有一条真正发出，额度只扣 1', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 50)
    await store.addAcceptedGrants(me, ['TX'], 50)
    const id = await newDelivery(me)
    const now = new Date()

    let sends = 0
    const slowSend = async () => {
      sends += 1
      // 让第二个事务有充分机会撞上锁（SKIP LOCKED 下它会直接跳过这一行）
      await Bun.sleep(50)
      return { ok: true as const }
    }

    const [first, second] = await Promise.all([
      store.attemptDelivery(id, now, slowSend),
      store.attemptDelivery(id, now, slowSend),
    ])

    expect(sends).toBe(1)
    expect([first.outcome, second.outcome].sort()).toEqual(['gone', 'sent'])
    expect((await store.readRemaining(me)).TX).toBe(1)
  })

  test('重试：可重试失败记 attempts/next_attempt_at，未到点不再发', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 50)
    const id = await newDelivery(me)
    const now = new Date()

    const outcome = await store.attemptDelivery(id, now, async () => ({
      ok: false,
      reason: 'retryable',
      detail: 'timeout',
    }))
    expect(outcome).toEqual({ outcome: 'retry' })

    const row = await deliveryRow(id)
    expect(row.status).toBe('PENDING')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toBe('timeout')
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + 30_000)

    // 还没到 next_attempt_at：再调一次应当被挡在门外（not-due），不发也不计次数
    let sends = 0
    const early = await store.attemptDelivery(id, now, async () => {
      sends += 1
      return { ok: true }
    })
    expect(early).toEqual({ outcome: 'not-due' })
    expect(sends).toBe(0)
    expect((await deliveryRow(id)).attempts).toBe(1)
  })

  test('43101（用户拒绝/无次数）：SKIPPED 且该 kind 的额度就地清零', async () => {
    const me = await newUser()
    await grant(me, 'CHAT', 7)
    const id = await newDelivery(me, { kind: 'CHAT' })

    const outcome = await store.attemptDelivery(id, new Date(), async () => ({
      ok: false,
      reason: 'no-quota',
      errcode: 43101,
      detail: 'errcode=43101',
    }))

    expect(outcome).toEqual({ outcome: 'skipped' })
    const row = await deliveryRow(id)
    expect(row.status).toBe('SKIPPED')
    expect(row.lastErrcode).toBe(43101)
    expect(row.lastError).toBe('errcode=43101')
    // 用户已经明确拒绝：本地记账不能留着"还能发 7 条"的假象
    expect((await store.readRemaining(me)).CHAT).toBe(0)
  })

  test('参数类错误：FAILED、记 errcode，不再重试', async () => {
    const me = await newUser()
    await grant(me, 'TX', 5)
    const id = await newDelivery(me)

    const outcome = await store.attemptDelivery(id, new Date(), async () => ({
      ok: false,
      reason: 'permanent',
      errcode: 47003,
      detail: 'errcode=47003',
    }))

    expect(outcome).toEqual({ outcome: 'failed' })
    const row = await deliveryRow(id)
    expect(row.status).toBe('FAILED')
    expect(row.lastErrcode).toBe(47003)
    // 没发出去就不扣额度
    expect((await store.readRemaining(me)).TX).toBe(5)
  })

  test('本地跳过（没有 openid）：SKIPPED 且不扣额度', async () => {
    const me = await newUser()
    await grant(me, 'TX', 3)
    const id = await newDelivery(me)

    const outcome = await store.attemptDelivery(id, new Date(), async () => ({
      ok: false,
      reason: 'skip',
      detail: 'no_openid',
    }))

    expect(outcome).toEqual({ outcome: 'skipped' })
    const row = await deliveryRow(id)
    expect(row.status).toBe('SKIPPED')
    expect(row.lastError).toBe('no_openid')
    expect((await store.readRemaining(me)).TX).toBe(3)
  })

  test('行不存在 / 已是终态 → gone（不会凭空扣额度）', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 1)
    const id = await newDelivery(me)

    await store.attemptDelivery(id, new Date(), async () => ({ ok: true }))
    // 已 SENT 的行不该被再发一次
    expect(await store.attemptDelivery(id, new Date(), async () => ({ ok: true }))).toEqual({
      outcome: 'gone',
    })
    expect(
      await store.attemptDelivery(crypto.randomUUID(), new Date(), async () => ({ ok: true })),
    ).toEqual({ outcome: 'gone' })
    expect((await store.readRemaining(me)).TX).toBe(0)
  })
})

describe('findOpenid', () => {
  test('没有微信身份 → null', async () => {
    const me = await newUser()
    expect(await store.findOpenid(me)).toBeNull()
  })
})

/**
 * 两条登记查询（#462）：候选来源怎么被筛出来 —— 时间窗、未读判据、限频、去重。
 *
 * 这几条谓词全在 SQL 里（`notExists` 子查询、`CASE` 算收件人、`IS NULL` 语义），
 * 换成假 store 就等于不测。用例都按「我自己造的行在不在结果里」断言，不比对整个结果集：
 * 这几条查询是全表按窗口扫的，同库里其它用例的行也可能落在窗口内。
 */
const createdConversations: string[] = []
const createdListings: string[] = []
const createdTransactions: string[] = []

async function newListing(sellerId: string, title: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title,
    description: '订阅消息登记测试用商品',
    priceCents: 9900,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
  })
  createdListings.push(id)
  return id
}

async function newConversation(input: {
  listingId: string
  buyerId: string
  sellerId: string
  sellerLastReadAt?: Date | null
  buyerLastReadAt?: Date | null
}): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(conversations).values({
    id,
    listingId: input.listingId,
    buyerId: input.buyerId,
    sellerId: input.sellerId,
    lastMessageAt: new Date(),
    buyerLastReadAt: input.buyerLastReadAt ?? null,
    sellerLastReadAt: input.sellerLastReadAt ?? null,
  })
  createdConversations.push(id)
  return id
}

async function newMessage(input: {
  conversationId: string
  senderId: string | null
  createdAt: Date
  type?: 'TEXT' | 'SYSTEM'
  recalledAt?: Date | null
}): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(messages).values({
    id,
    conversationId: input.conversationId,
    senderId: input.senderId,
    type: input.type ?? 'TEXT',
    content: '这件还在吗',
    createdAt: input.createdAt,
    recalledAt: input.recalledAt ?? null,
  })
  return id
}

async function newNotification(input: {
  userId: string
  type: 'TX' | 'MATCH' | 'MODERATION' | 'ACCOUNT' | 'DISPUTE'
  payload?: Record<string, string>
  createdAt: Date
}): Promise<string> {
  const rows = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: input.createdAt,
    })
    .returning({ id: notifications.id })
  const id = rows[0]?.id
  if (!id) throw new Error('insert notifications 未返回行')
  return id
}

async function bindWechat(userId: string): Promise<void> {
  await db
    .insert(wechatIdentities)
    .values({ userId, openid: `o${crypto.randomUUID().slice(0, 27)}` })
}

/** 一次登记扫描用的三个时间点（都以「现在」为基准，避免与系统时钟漂移纠缠）。 */
function chatWindow(at = Date.now()) {
  return {
    since: new Date(at - 10 * 60 * 1000),
    unreadBefore: new Date(at - 60 * 1000),
    throttleSince: new Date(at - 30 * 60 * 1000),
    limit: 500,
  }
}

describe('listChatSources（聊天登记）', () => {
  test('对方 60 秒未读的消息进入候选：收件人是会话另一方，带发送人昵称与商品标题', async () => {
    const buyer = await newUser('买家小林')
    const seller = await newUser('卖家小陈')
    const listingId = await newListing(seller, '九成新自行车')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const at = Date.now()
    const messageId = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 2 * 60 * 1000),
    })

    const mine = (await store.listChatSources(chatWindow(at))).find(
      (row) => row.messageId === messageId,
    )

    expect(mine).toBeDefined()
    expect(mine?.recipientId).toBe(seller)
    expect(mine?.conversationId).toBe(conversationId)
    expect(mine?.senderNickname).toBe('买家小林')
    expect(mine?.listingTitle).toBe('九成新自行车')
  })

  test('刚发出（不满 60 秒）的消息不登记：可能马上就被读到', async () => {
    const buyer = await newUser()
    const seller = await newUser()
    const listingId = await newListing(seller, '登山杖')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const at = Date.now()
    const messageId = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 30 * 1000),
    })

    expect(
      (await store.listChatSources(chatWindow(at))).some((row) => row.messageId === messageId),
    ).toBe(false)
  })

  test('收件人已读过（读位晚于消息）不登记', async () => {
    const at = Date.now()
    const buyer = await newUser()
    const seller = await newUser()
    const listingId = await newListing(seller, '台灯')
    const conversationId = await newConversation({
      listingId,
      buyerId: buyer,
      sellerId: seller,
      // 卖家在 1 分钟前读过：2 分钟前那条消息已经被看到
      sellerLastReadAt: new Date(at - 60 * 1000),
    })
    const messageId = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 2 * 60 * 1000),
    })

    expect(
      (await store.listChatSources(chatWindow(at))).some((row) => row.messageId === messageId),
    ).toBe(false)
  })

  test('已登记过的消息不再出现（重扫幂等）', async () => {
    const at = Date.now()
    const buyer = await newUser()
    const seller = await newUser()
    const listingId = await newListing(seller, '电饭煲')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const messageId = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 2 * 60 * 1000),
    })
    await newDelivery(seller, {
      sourceType: 'CHAT',
      sourceId: messageId,
      kind: 'CHAT',
      conversationId,
    })

    expect(
      (await store.listChatSources(chatWindow(at))).some((row) => row.messageId === messageId),
    ).toBe(false)
  })

  test('同一「会话 × 收件人」30 分钟内已推过一条，窗口内不再登记', async () => {
    const at = Date.now()
    const buyer = await newUser()
    const seller = await newUser()
    const listingId = await newListing(seller, '行李箱')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    // 10 分钟前推过这条会话发给卖家的提醒（另一条消息，来源不同）
    await newDelivery(seller, {
      sourceType: 'CHAT',
      sourceId: crypto.randomUUID(),
      kind: 'CHAT',
      conversationId,
    })
    const messageId = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 2 * 60 * 1000),
    })

    expect(
      (await store.listChatSources(chatWindow(at))).some((row) => row.messageId === messageId),
    ).toBe(false)
  })

  test('撤回的消息与 SYSTEM 消息都不登记', async () => {
    const at = Date.now()
    const buyer = await newUser()
    const seller = await newUser()
    const listingId = await newListing(seller, '耳机')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const recalled = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 3 * 60 * 1000),
      recalledAt: new Date(at - 2 * 60 * 1000),
    })
    // SYSTEM 消息没有发送者：`sender_id <> recipient_id` 对 NULL 求值为 NULL，因此天然被排除
    const system = await newMessage({
      conversationId,
      senderId: null,
      type: 'SYSTEM',
      createdAt: new Date(at - 2 * 60 * 1000),
    })

    const rows = await store.listChatSources(chatWindow(at))

    expect(rows.some((row) => row.messageId === recalled)).toBe(false)
    expect(rows.some((row) => row.messageId === system)).toBe(false)
  })
})

describe('listNotificationSources（通知登记）', () => {
  const sinceOf = (at: number) => new Date(at - 30 * 60 * 1000)

  test('窗口内、收件人有微信身份的 TX 通知进入候选', async () => {
    const at = Date.now()
    const me = await newUser()
    await bindWechat(me)
    const id = await newNotification({
      userId: me,
      type: 'TX',
      payload: { transactionId: crypto.randomUUID(), event: 'ACCEPTED' },
      createdAt: new Date(at - 60 * 1000),
    })

    const rows = await store.listNotificationSources(sinceOf(at), 500)

    expect(rows.some((row) => row.id === id)).toBe(true)
  })

  test('没有微信身份的用户不登记：没有站外触达的对象', async () => {
    const at = Date.now()
    const me = await newUser()
    const id = await newNotification({
      userId: me,
      type: 'TX',
      payload: { transactionId: crypto.randomUUID(), event: 'ACCEPTED' },
      createdAt: new Date(at - 60 * 1000),
    })

    expect(
      (await store.listNotificationSources(sinceOf(at), 500)).some((row) => row.id === id),
    ).toBe(false)
  })

  test('首批之外的通知类型（MATCH）不登记', async () => {
    const at = Date.now()
    const me = await newUser()
    await bindWechat(me)
    const id = await newNotification({
      userId: me,
      type: 'MATCH',
      createdAt: new Date(at - 60 * 1000),
    })

    expect(
      (await store.listNotificationSources(sinceOf(at), 500)).some((row) => row.id === id),
    ).toBe(false)
  })

  test('窗口外的旧通知不登记：重启后不补推两小时前的进展', async () => {
    const at = Date.now()
    const me = await newUser()
    await bindWechat(me)
    const id = await newNotification({
      userId: me,
      type: 'TX',
      payload: { transactionId: crypto.randomUUID(), event: 'ACCEPTED' },
      createdAt: new Date(at - 31 * 60 * 1000),
    })

    expect(
      (await store.listNotificationSources(sinceOf(at), 500)).some((row) => row.id === id),
    ).toBe(false)
  })

  test('已登记过的通知不再出现（重扫幂等）', async () => {
    const at = Date.now()
    const me = await newUser()
    await bindWechat(me)
    const id = await newNotification({
      userId: me,
      type: 'TX',
      payload: { transactionId: crypto.randomUUID(), event: 'ACCEPTED' },
      createdAt: new Date(at - 60 * 1000),
    })
    await newDelivery(me, { sourceType: 'NOTIFICATION', sourceId: id })

    expect(
      (await store.listNotificationSources(sinceOf(at), 500)).some((row) => row.id === id),
    ).toBe(false)
  })
})

/**
 * 聊天登记的限频（#511 审查 high）：限频维度是「会话 × 收件人」，而唯一键
 * `(source_type, source_id, recipient_id)` 拦不住**同会话的两条不同消息**——
 * 两条消息的 `source_id` 不同，一轮里会各插一行、各推一条。
 */
async function newChatRow(
  conversationId: string,
  recipientId: string,
  messageId: string = crypto.randomUUID(),
): Promise<NewSubscribeDelivery> {
  return {
    sourceType: 'CHAT',
    sourceId: messageId,
    recipientId,
    kind: 'CHAT',
    data: {
      thing4: '买家',
      thing2: '你有一条新消息',
      thing28: '折叠桌',
      time3: '2026-11-01 10:30',
    },
    page: `pkg-social/pages/conversation/index?id=${conversationId}`,
    conversationId,
  }
}

/** 该「会话 × 收件人」在库里的 CHAT 投递行数。 */
async function chatDeliveryCount(conversationId: string, recipientId: string): Promise<number> {
  const rows = await db
    .select({ id: subscribeMessageDeliveries.id })
    .from(subscribeMessageDeliveries)
    .where(
      and(
        eq(subscribeMessageDeliveries.sourceType, 'CHAT'),
        eq(subscribeMessageDeliveries.conversationId, conversationId),
        eq(subscribeMessageDeliveries.recipientId, recipientId),
      ),
    )
  return rows.length
}

describe('listChatSources：同会话多条未读消息', () => {
  test('每「会话 × 收件人」只出一条候选，取最新那条消息', async () => {
    const at = Date.now()
    const buyer = await newUser('买家')
    const seller = await newUser('卖家')
    const listingId = await newListing(seller, '折叠桌')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const older = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 5 * 60 * 1000),
    })
    const newer = await newMessage({
      conversationId,
      senderId: buyer,
      createdAt: new Date(at - 2 * 60 * 1000),
    })

    const rows = (await store.listChatSources(chatWindow(at))).filter(
      (row) => row.conversationId === conversationId,
    )

    // 修复前：两条都进候选（各自 source_id 不同，唯一键拦不住），一轮推两条
    expect(rows).toHaveLength(1)
    expect(rows[0]?.messageId).toBe(newer)
    expect(rows.some((row) => row.messageId === older)).toBe(false)
  })
})

describe('insertChatDeliveries：会话×收件人的限频', () => {
  test('同一批里两条同组行也只登记一条（不依赖调用方去重）', async () => {
    const buyer = await newUser('买家')
    const seller = await newUser('卖家')
    const listingId = await newListing(seller, '折叠桌')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const at = Date.now()

    const inserted = await store.insertChatDeliveries(
      [await newChatRow(conversationId, seller), await newChatRow(conversationId, seller)],
      new Date(at - 30 * 60 * 1000),
    )

    expect(inserted).toBe(1)
    expect(await chatDeliveryCount(conversationId, seller)).toBe(1)
  })

  test('窗口内已有 CHAT 投递行的组整组丢弃（返回 0）', async () => {
    const buyer = await newUser('买家')
    const seller = await newUser('卖家')
    const listingId = await newListing(seller, '台灯')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const at = Date.now()
    // 10 分钟前已经为这个「会话 × 收件人」登记过一条（另一条消息）
    await newDelivery(seller, {
      sourceType: 'CHAT',
      sourceId: crypto.randomUUID(),
      kind: 'CHAT',
      conversationId,
    })

    const inserted = await store.insertChatDeliveries(
      [await newChatRow(conversationId, seller)],
      new Date(at - 30 * 60 * 1000),
    )

    expect(inserted).toBe(0)
    expect(await chatDeliveryCount(conversationId, seller)).toBe(1)
  })

  test('两个并发登记（各自扫到不同消息）也只留一条：advisory lock 内复核限频', async () => {
    const buyer = await newUser('买家')
    const seller = await newUser('卖家')
    const listingId = await newListing(seller, '行李箱')
    const conversationId = await newConversation({ listingId, buyerId: buyer, sellerId: seller })
    const at = Date.now()
    const throttleSince = new Date(at - 30 * 60 * 1000)
    // 模拟两个 API 实例各扫到同会话的一条未读消息：两条行只有 source_id 不同，
    // 唯一键不会冲突，靠事务级 advisory lock 把「复核 + 插入」串起来。
    const first = await newChatRow(conversationId, seller)
    const second = await newChatRow(conversationId, seller)

    const inserted = await Promise.all([
      store.insertChatDeliveries([first], throttleSince),
      store.insertChatDeliveries([second], throttleSince),
    ])

    expect((inserted[0] ?? 0) + (inserted[1] ?? 0)).toBe(1)
    expect(await chatDeliveryCount(conversationId, seller)).toBe(1)
  })
})

describe('findTransactionListingTitles', () => {
  test('按交易 id 取该交易指向的商品标题（DISPUTE 的 payload 只有 transactionId）', async () => {
    const seller = await newUser('卖家')
    const buyer = await newUser('买家')
    const listingId = await newListing(seller, '九成新自行车')
    const transactionId = crypto.randomUUID()
    await db
      .insert(transactions)
      .values({ id: transactionId, listingId, buyerId: buyer, sellerId: seller, amountCents: 9900 })
    createdTransactions.push(transactionId)

    const titles = await store.findTransactionListingTitles([
      transactionId,
      // 脏值不该让整批查询抛 22P02（与 findListingTitles 同口径）
      'not-a-uuid',
    ])

    expect(titles.get(transactionId)).toBe('九成新自行车')
    expect(titles.size).toBe(1)
  })
})

/**
 * 「发送前先提交 SENDING」（#511 审查 high）：发送与记账不能共用一个事务 ——
 * 上游已经收到、本地事务回滚（进程被强杀）会让重启后同一条被再发一次。
 * 这几条用例钉住新状态机的两端：占位在发送前就可见，没发出去的尝试不扣额度，
 * 中途死掉留下的 `SENDING` 一行既不重发也不留在待发队列里。
 */
describe('attemptDelivery：SENDING 占位与中断清扫', () => {
  test('发送之前行已提交成 SENDING：进程死在途中也不会重发', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 50)
    const id = await newDelivery(me)

    const statusesDuringSend: string[] = []
    const outcome = await store.attemptDelivery(id, new Date(), async () => {
      // 用另一个连接读库：能读到 SENDING，说明它是在调微信之前就提交的
      statusesDuringSend.push((await deliveryRow(id)).status)
      return { ok: true }
    })

    expect(outcome).toEqual({ outcome: 'sent' })
    expect(statusesDuringSend).toEqual(['SENDING'])
    expect((await deliveryRow(id)).status).toBe('SENT')
  })

  test('没发出去的尝试不扣额度：可重试失败后预扣退回', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 50) // 只有 1 次
    const id = await newDelivery(me)

    await store.attemptDelivery(id, new Date(), async () => ({
      ok: false,
      reason: 'retryable',
      detail: 'timeout',
    }))

    // 预扣了 1 次又退回：一次也没发出去，额度不该少
    expect((await store.readRemaining(me)).TX).toBe(1)
  })

  test('发送中断的孤儿行：超时后判 FAILED(interrupted)，且永不重发', async () => {
    const me = await newUser()
    await store.addAcceptedGrants(me, ['TX'], 50)
    const id = await newDelivery(me)
    // 模拟"发到一半进程被强杀"：行停在 SENDING，updated_at 是很久以前
    await db
      .update(subscribeMessageDeliveries)
      .set({ status: 'SENDING', updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(subscribeMessageDeliveries.id, id))

    const abandoned = await store.abandonStaleSending(
      new Date(),
      new Date(Date.now() - 2 * 60 * 1000),
    )
    expect(abandoned).toBeGreaterThanOrEqual(1)

    const row = await deliveryRow(id)
    expect(row.status).toBe('FAILED')
    expect(row.lastError).toBe('interrupted')

    // 「不重发」的两半：既不在待发列表里，直接尝试也只能是 gone
    expect((await store.listPendingDeliveryIds(new Date(), 500)).includes(id)).toBe(false)
    let sends = 0
    expect(
      await store.attemptDelivery(id, new Date(), async () => {
        sends += 1
        return { ok: true }
      }),
    ).toEqual({ outcome: 'gone' })
    expect(sends).toBe(0)
  })

  test('刚进入发送的行不被清扫：阈值只覆盖确实死掉的', async () => {
    const me = await newUser()
    const id = await newDelivery(me)
    await db
      .update(subscribeMessageDeliveries)
      .set({ status: 'SENDING' })
      .where(eq(subscribeMessageDeliveries.id, id))

    await store.abandonStaleSending(new Date(), new Date(Date.now() - 2 * 60 * 1000))

    expect((await deliveryRow(id)).status).toBe('SENDING')
  })
})
