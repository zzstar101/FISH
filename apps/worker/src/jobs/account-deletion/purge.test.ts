import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DELETED_ACCOUNT_NICKNAME } from '@fish/contracts/account-deletion/schema'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { aiPolishRequests } from '@fish/db/schema/ai-polish-requests'
import { comments } from '@fish/db/schema/comments'
import { conversations } from '@fish/db/schema/conversations'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { favorites } from '@fish/db/schema/favorites'
import { feedback } from '@fish/db/schema/feedback'
import { follows } from '@fish/db/schema/follows'
import { listings } from '@fish/db/schema/listings'
import { loginTickets } from '@fish/db/schema/login-tickets'
import { messages } from '@fish/db/schema/messages'
import { notifications } from '@fish/db/schema/notifications'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { sessions } from '@fish/db/schema/sessions'
import { transactions } from '@fish/db/schema/transactions'
import { userInterestProfiles } from '@fish/db/schema/user-interest-profiles'
import { users, wechatIdentities } from '@fish/db/schema/users'
import { campusEmailVerifications } from '@fish/db/schema/verifications'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { purgeDueAccountDeletions } from './purge'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/**
 * scratch 库模式（与 view-history/cleanup.test.ts 一致）。
 *
 * 一个文件里跑多个账号：`purgeDueAccountDeletions` 是「扫描全部到点账号」的批处理，
 * 所以断言都收敛到 **本用例那个 userId 的 outcome**，不用全局计数 —— 全局计数会被
 * 同文件里其它用例留下的账号影响。
 */
const scratchDatabase = `fish_account_deletion_purge_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db

const NOW = new Date('2026-10-02T00:00:00.000000Z')
const DUE = new Date(NOW.getTime() - 60_000)
const NOT_DUE = new Date(NOW.getTime() + 60_000)

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

let seedSerial = 0

type Seeded = {
  userId: string
  counterpartyId: string
  listingOwnedActive: string
  listingOwnedSold: string
  listingOther: string
}

/** 造一个（默认已申请注销的）账号 + 对手账号 + 三件商品。 */
async function seed(input: {
  purgeScheduledAt?: Date
  accountStatus?: 'ACTIVE' | 'DELETION_REQUESTED'
  withPendingTransactionAsBuyer?: boolean
  withPendingTransactionAsSeller?: boolean
  nickname?: string
  studentNo?: string
  campusEmail?: string
  phone?: string
  openid?: string
}): Promise<Seeded> {
  const serial = seedSerial++
  const userId = newId()
  const counterpartyId = newId()
  const accountStatus = input.accountStatus ?? 'DELETION_REQUESTED'
  const requestedAt =
    accountStatus === 'DELETION_REQUESTED' ? new Date(NOW.getTime() - 86_400_000) : null
  const purgeScheduledAt =
    accountStatus === 'DELETION_REQUESTED' ? (input.purgeScheduledAt ?? DUE) : null

  await db.insert(users).values({
    id: userId,
    studentNo: input.studentNo ?? `2023${String(serial).padStart(4, '0')}0001`,
    passwordHash: 'test-hash',
    nickname: input.nickname ?? '注销验收用户',
    avatarUrl: 'https://cdn.test/avatar.png',
    signature: '原签名',
    campusEmail: input.campusEmail ?? null,
    phone: input.phone ?? null,
    accountStatus,
    deletionRequestedAt: requestedAt,
    purgeScheduledAt,
  })
  await db.insert(users).values({
    id: counterpartyId,
    studentNo: `2023${String(serial).padStart(4, '0')}0002`,
    passwordHash: 'test-hash',
    nickname: '对手用户',
  })

  const listingOwnedActive = await seedListing(userId, 'ACTIVE')
  const listingOwnedSold = await seedListing(userId, 'SOLD')
  const listingOther = await seedListing(counterpartyId, 'ACTIVE')

  if (input.withPendingTransactionAsBuyer) {
    await db.insert(transactions).values({
      id: newId(),
      listingId: listingOther,
      buyerId: userId,
      sellerId: counterpartyId,
      amountCents: 100,
      status: 'PENDING_MEETUP',
    })
  }
  if (input.withPendingTransactionAsSeller) {
    await db.insert(transactions).values({
      id: newId(),
      listingId: listingOwnedActive,
      buyerId: counterpartyId,
      sellerId: userId,
      amountCents: 100,
      status: 'PENDING_MEETUP',
    })
  }
  if (input.openid) {
    await db.insert(wechatIdentities).values({ id: newId(), userId, openid: input.openid })
  }

  return { userId, counterpartyId, listingOwnedActive, listingOwnedSold, listingOther }
}

async function seedListing(sellerId: string, status: 'ACTIVE' | 'SOLD'): Promise<string> {
  const listingId = newId()
  const listingNo = await reserveTestListingNo(db, listingId)
  await db.insert(listings).values({
    id: listingId,
    listingNo,
    sellerId,
    title: '注销验收商品',
    description: '描述',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status,
  })
  return listingId
}

/** 铺满本人私域数据（去标识化必须全清）。 */
async function seedPrivateData(seeded: Seeded): Promise<void> {
  const { userId, counterpartyId, listingOther } = seeded
  await db.insert(sessions).values([
    { id: newId(), userId, tokenHash: `token-${newId()}`, expiresAt: NOT_DUE },
    { id: newId(), userId, tokenHash: `token-${newId()}`, expiresAt: NOT_DUE },
  ])
  await db
    .insert(campusEmailVerifications)
    .values({ id: newId(), userId, email: 'bye@example.com', codeHash: 'hash', expiresAt: NOT_DUE })
  await db.insert(loginTickets).values({
    id: newId(),
    ticketHash: `ticket-${newId()}`,
    verifierHash: 'verifier',
    boundUserId: userId,
    expiresAt: NOT_DUE,
  })
  await db.insert(favorites).values({ id: newId(), userId, listingId: listingOther })
  await db.insert(follows).values([
    { id: newId(), followerId: userId, followingId: counterpartyId },
    { id: newId(), followerId: counterpartyId, followingId: userId },
  ])
  await db
    .insert(listingViewHistory)
    .values({ id: newId(), userId, listingId: listingOther, lastViewedAt: NOW })
  await db
    .insert(notifications)
    .values({ id: newId(), userId, type: 'TX', payload: { event: 'ACCEPTED' } })
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  embedding[0] = 1
  await db.insert(userInterestProfiles).values({
    id: newId(),
    userId,
    model: 'test-model',
    dimensions: EMBEDDING_DIMENSIONS,
    strategyVersion: 'interest-v1',
    embedding,
    actionCount: 3,
    windowStartedAt: NOW,
    computedAt: NOW,
  })
  await db.insert(aiPolishRequests).values({ id: newId(), userId })
  await db.insert(feedback).values({
    id: newId(),
    userId,
    clientRequestId: newId(),
    type: 'BUG',
    content: '发布页提交按钮没反应',
    contact: 'wx_private_handle',
  })
  await db.insert(recommendationRequests).values({
    id: newId(),
    userId,
    strategyVersion: 'fresh-v1',
  })
  await db.insert(recommendationEvents).values({
    id: newId(),
    eventId: newId(),
    userId,
    listingId: listingOther,
    eventType: 'DETAIL_VIEW',
    occurredAt: NOW,
  })
  // 历史数据：留言 / 会话 / 消息 / 许愿 —— 去标识化不能带走它们。
  await db
    .insert(comments)
    .values({ id: newId(), listingId: listingOther, authorId: userId, content: '还在吗' })
  const conversationId = newId()
  await db.insert(conversations).values({
    id: conversationId,
    listingId: listingOther,
    buyerId: userId,
    sellerId: counterpartyId,
  })
  await db.insert(messages).values({
    id: newId(),
    conversationId,
    senderId: userId,
    type: 'TEXT',
    content: '面交可以吗',
  })
  await db.insert(wishes).values([
    { id: newId(), userId, keyword: '机械键盘', status: 'ACTIVE' },
    { id: newId(), userId, keyword: '旧书', status: 'FULFILLED' },
  ])
}

async function countSessions(userId: string): Promise<number> {
  return db.$count(sessions, eq(sessions.userId, userId))
}

async function outcomeOf(
  result: Awaited<ReturnType<typeof purgeDueAccountDeletions>>,
  userId: string,
) {
  return result.outcomes.find((item) => item.userId === userId)
}

/**
 * 把错误链（drizzle 的 `Failed query: …` 只是外壳，真正的 Postgres 错误在 `cause` 上）拼成一段文本。
 */
function errorChainText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    parts.push(current.message)
    const { code, errno } = current as { code?: unknown; errno?: unknown }
    parts.push(String(code ?? ''), String(errno ?? ''))
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

/**
 * 断言这条 insert 撞了预期的那条唯一约束。
 *
 * 不能写 `expect(builder).rejects.toThrow()`：drizzle 的 builder 是 thenable 而不是原生
 * Promise，bun 的 `.rejects` 不认，会直接把 builder 本身当成 received 报错。
 */
async function expectUniqueViolation(statement: () => unknown, constraint: string): Promise<void> {
  try {
    await statement()
  } catch (error) {
    expect(errorChainText(error)).toContain(constraint)
    return
  }
  throw new Error(`预期撞唯一约束 ${constraint}，但插入成功了`)
}

describe('到期去标识化：整份隐私清掉，历史证据留下', () => {
  test('purged：私域数据全清、users 原地占位、交易/留言/会话/已成交商品保留', async () => {
    const seeded = await seed({
      purgeScheduledAt: DUE,
      campusEmail: `bye-${process.pid}@example.com`,
      phone: `139${String(process.pid % 100000000).padStart(8, '0')}`,
    })
    await seedPrivateData(seeded)
    const { userId, counterpartyId, listingOwnedActive, listingOwnedSold } = seeded

    // 已完成的交易也是历史证据，必须留着。
    const completedTransactionId = newId()
    await db.insert(transactions).values({
      id: completedTransactionId,
      listingId: listingOwnedSold,
      buyerId: counterpartyId,
      sellerId: userId,
      amountCents: 16000,
      status: 'COMPLETED',
      completedAt: NOW,
    })

    const result = await purgeDueAccountDeletions({ db, now: NOW })
    const outcome = await outcomeOf(result, userId)
    expect(outcome?.kind).toBe('purged')
    if (outcome?.kind !== 'purged') throw new Error('unreachable')
    expect(outcome.counts.sessions).toBe(2)
    expect(outcome.counts.favorites).toBe(1)
    expect(outcome.counts.follows).toBe(2)
    expect(outcome.counts.wishesClosed).toBe(1)
    expect(outcome.counts.feedbackContactsCleared).toBe(1)

    // ① 私域数据：一行不留。
    expect(await countSessions(userId)).toBe(0)
    expect(await db.$count(wechatIdentities, eq(wechatIdentities.userId, userId))).toBe(0)
    expect(
      await db.$count(campusEmailVerifications, eq(campusEmailVerifications.userId, userId)),
    ).toBe(0)
    expect(await db.$count(loginTickets, eq(loginTickets.boundUserId, userId))).toBe(0)
    expect(await db.$count(favorites, eq(favorites.userId, userId))).toBe(0)
    expect(await db.$count(follows, eq(follows.followerId, userId))).toBe(0)
    expect(await db.$count(follows, eq(follows.followingId, userId))).toBe(0)
    expect(await db.$count(listingViewHistory, eq(listingViewHistory.userId, userId))).toBe(0)
    expect(await db.$count(notifications, eq(notifications.userId, userId))).toBe(0)
    expect(await db.$count(userInterestProfiles, eq(userInterestProfiles.userId, userId))).toBe(0)
    expect(await db.$count(aiPolishRequests, eq(aiPolishRequests.userId, userId))).toBe(0)
    // 反馈：联系方式清掉，正文留作处理记录。
    const [feedbackRow] = await db
      .select({ contact: feedback.contact, content: feedback.content })
      .from(feedback)
      .where(eq(feedback.userId, userId))
    expect(feedbackRow).toEqual({ contact: null, content: '发布页提交按钮没反应' })

    // ② users 行原地去标识化：昵称是占位串（notNull 不能置空），凭据与唯一键全部释放。
    const [row] = await db.select().from(users).where(eq(users.id, userId))
    expect(row?.nickname).toBe(DELETED_ACCOUNT_NICKNAME)
    expect(row?.accountStatus).toBe('DELETED')
    expect(row?.studentNo).toBeNull()
    expect(row?.passwordHash).toBeNull()
    expect(row?.campusEmail).toBeNull()
    expect(row?.phone).toBeNull()
    expect(row?.avatarUrl).toBeNull()
    expect(row?.signature).toBeNull()
    expect(row?.verifiedAt).toBeNull()
    expect(row?.authStatus).toBe('UNVERIFIED')
    expect(row?.role).toBe('USER')
    // CHECK 约束要求 DELETED 时两个时间戳都为空。
    expect(row?.deletionRequestedAt).toBeNull()
    expect(row?.purgeScheduledAt).toBeNull()

    // ③ 历史证据：商品、成交记录、留言、会话、消息全部还在，外键不断。
    const [active] = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, listingOwnedActive))
    expect(active?.status).toBe('OFFLINE')
    const [sold] = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, listingOwnedSold))
    expect(sold?.status).toBe('SOLD')
    const [transaction] = await db
      .select({ sellerId: transactions.sellerId, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.id, completedTransactionId))
    expect(transaction?.sellerId).toBe(userId)
    expect(transaction?.status).toBe('COMPLETED')
    expect(await db.$count(comments, eq(comments.authorId, userId))).toBe(1)
    expect(await db.$count(conversations, eq(conversations.buyerId, userId))).toBe(1)
    expect(await db.$count(messages, eq(messages.senderId, userId))).toBe(1)
    // 许愿：未完成的收尾成 CLOSED（不硬删 —— matches 对 wishes 是级联），已完成的原样留着。
    expect(
      await db.$count(wishes, and(eq(wishes.userId, userId), eq(wishes.status, 'ACTIVE'))),
    ).toBe(0)
    expect(
      await db.$count(wishes, and(eq(wishes.userId, userId), eq(wishes.status, 'FULFILLED'))),
    ).toBe(1)

    // ④ 运营数据断关联，但行本身留下；`recommendation_requests` 有「必须有身份」的 CHECK。
    const requests = await db
      .select()
      .from(recommendationRequests)
      .where(eq(recommendationRequests.id, recommendationRequests.id))
    const mine = requests.filter((item) => item.strategyVersion === 'fresh-v1')
    expect(mine).toHaveLength(1)
    expect(mine[0]?.userId).toBeNull()
    expect(mine[0]?.anonymousSessionId).not.toBeNull()
    const events = await db
      .select()
      .from(recommendationEvents)
      .where(eq(recommendationEvents.id, recommendationEvents.id))
    const myEvents = events.filter((item) => item.eventType === 'DETAIL_VIEW')
    expect(myEvents).toHaveLength(1)
    expect(myEvents[0]?.userId).toBeNull()

    // ⑤ 审计：系统动作（无 actor）、只记状态与计数，不记被清掉的资料。
    const audits = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.targetId, userId))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.action).toBe('ACCOUNT_DELETION_COMPLETED')
    expect(audits[0]?.actorUserId).toBeNull()
    expect(audits[0]?.targetType).toBe('USER')
    expect(audits[0]?.after).toMatchObject({ accountStatus: 'DELETED' })
  })
})

describe('到期判定与幂等', () => {
  test('未到点：不在扫描范围内，什么都不动', async () => {
    const seeded = await seed({ purgeScheduledAt: NOT_DUE })
    await seedPrivateData(seeded)

    const outcome = await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId)
    // 批次扫描本身就带 `purge_scheduled_at <= now`，所以未到点的账号连行都扫不出来 —— 没有 outcome。
    expect(outcome).toBeUndefined()

    const [row] = await db.select().from(users).where(eq(users.id, seeded.userId))
    expect(row?.accountStatus).toBe('DELETION_REQUESTED')
    expect(row?.nickname).toBe('注销验收用户')
    expect(await countSessions(seeded.userId)).toBe(2)
    expect(await db.$count(favorites, eq(favorites.userId, seeded.userId))).toBe(1)
  })

  test('已撤回（ACTIVE）：skipped，账号与数据都完好', async () => {
    const seeded = await seed({ accountStatus: 'ACTIVE' })
    await seedPrivateData(seeded)

    const outcome = await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId)
    expect(outcome).toBeUndefined()

    const [row] = await db.select().from(users).where(eq(users.id, seeded.userId))
    expect(row?.accountStatus).toBe('ACTIVE')
    expect(await db.$count(favorites, eq(favorites.userId, seeded.userId))).toBe(1)
  })

  test('幂等：跑第二遍不会重复去标识化，也不会重复写审计', async () => {
    const seeded = await seed({ purgeScheduledAt: DUE })
    await seedPrivateData(seeded)

    const first = await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId)
    expect(first?.kind).toBe('purged')
    const second = await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId)
    // 第二遍连「到点行」都扫不出来（状态已是 DELETED），所以没有 outcome 才是对的。
    expect(second).toBeUndefined()

    expect(await db.$count(adminAuditLogs, eq(adminAuditLogs.targetId, seeded.userId))).toBe(1)
  })
})

describe('到期时的资格复查', () => {
  test('出现了把注销人算作买家的待面交交易：deferred，账号停在冷静期状态，数据一个不动', async () => {
    const seeded = await seed({ purgeScheduledAt: DUE, withPendingTransactionAsBuyer: true })
    await seedPrivateData(seeded)

    const outcome = await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId)
    expect(outcome).toEqual({
      kind: 'deferred-pending-transaction',
      userId: seeded.userId,
      blockingTransactions: 1,
    })

    const [row] = await db.select().from(users).where(eq(users.id, seeded.userId))
    expect(row?.accountStatus).toBe('DELETION_REQUESTED')
    // 名字都没动：推迟意味着「等交易结清的那一轮再整份执行」，不做半截式清理。
    expect(row?.nickname).toBe('注销验收用户')
    expect(await countSessions(seeded.userId)).toBe(2)
    expect(await db.$count(favorites, eq(favorites.userId, seeded.userId))).toBe(1)
    expect(await db.$count(adminAuditLogs, eq(adminAuditLogs.targetId, seeded.userId))).toBe(0)
  })

  test('出现了把注销人算作卖家的待面交交易：同样 deferred', async () => {
    const seeded = await seed({ purgeScheduledAt: DUE, withPendingTransactionAsSeller: true })
    await seedPrivateData(seeded)

    const outcome = await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId)
    expect(outcome?.kind).toBe('deferred-pending-transaction')

    const [row] = await db.select().from(users).where(eq(users.id, seeded.userId))
    expect(row?.accountStatus).toBe('DELETION_REQUESTED')
    expect(await countSessions(seeded.userId)).toBe(2)
  })
})

describe('唯一键释放', () => {
  test('注销后可以用同一学号 / 校园邮箱 / 手机号 / 微信 openid 重新注册', async () => {
    const studentNo = `2024${String(process.pid % 10000).padStart(4, '0')}0001`
    const campusEmail = `reuse-${process.pid}@example.com`
    const phone = `138${String(process.pid % 100000000).padStart(8, '0')}`
    const openid = `openid-reuse-${process.pid}`
    const seeded = await seed({ purgeScheduledAt: DUE, studentNo, campusEmail, phone, openid })

    // 注销前：唯一键被占用，插同一个值必然撞唯一约束。
    await expectUniqueViolation(
      () =>
        db.insert(users).values({ id: newId(), studentNo, passwordHash: 'x', nickname: '重名' }),
      'users_student_no_unique',
    )
    await expectUniqueViolation(
      () =>
        db.insert(wechatIdentities).values({ id: newId(), userId: seeded.counterpartyId, openid }),
      'wechat_identities_openid_uq',
    )

    expect(
      (await outcomeOf(await purgeDueAccountDeletions({ db, now: NOW }), seeded.userId))?.kind,
    ).toBe('purged')

    // 注销后：同一个学号 / 邮箱 / 手机号能拿到新账号（旧行仍留在库里，只是不再占用唯一键）。
    const nextUserId = newId()
    await db.insert(users).values({
      id: nextUserId,
      studentNo,
      passwordHash: 'new-hash',
      nickname: '重新注册用户',
      campusEmail,
      phone,
    })
    await db.insert(wechatIdentities).values({ id: newId(), userId: nextUserId, openid })
    const [reborn] = await db.select().from(users).where(eq(users.id, nextUserId))
    expect(reborn?.accountStatus).toBe('ACTIVE')
    expect(reborn?.studentNo).toBe(studentNo)
  })
})
