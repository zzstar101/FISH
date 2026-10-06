import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import { DISPUTE_ROUTES } from '@fish/contracts/disputes/routes'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { conversations } from '@fish/db/schema/conversations'
import { disputeAttachments, disputes } from '@fish/db/schema/disputes'
import { userRestrictions } from '@fish/db/schema/governance'
import { listings } from '@fish/db/schema/listings'
import { messages, messageTypeEnum } from '@fish/db/schema/messages'
import { notifications } from '@fish/db/schema/notifications'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
import { contentDigestOf } from '../uploads/dispute-media'
import { createSqlDisputeStore } from './store'

/**
 * 争议闭环端到端（#465）：本人订单发起 → 补充说明/附件/聊天证据 → 管理端队列与处理 →
 * 双方可见结果 + 通知，且**不触碰成交事实与治理动作**。
 *
 * 跑在自建 scratch 库上：争议会插行、处理会写审计与通知，跑开发库会污染他人。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_disputes_test_${process.pid}`
const databaseUrlFor = (name: string) => {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}
const scratchUrl = databaseUrlFor(scratchDatabase)
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 对象存储探测：配置缺失或 MinIO 没起就跳过附件链路的用例，避免假失败。 */
async function probeStorage(): Promise<boolean> {
  const endpoint = process.env.S3_ENDPOINT
  if (!endpoint || !process.env.S3_BUCKET) return false
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(2000) })
    return res.status < 500
  } catch {
    return false
  }
}
const storageUp = await probeStorage()
if (!storageUp) {
  console.warn(
    '[disputes] 未探测到对象存储（S3_ENDPOINT / S3_BUCKET），附件真实端到端用例将被跳过：' +
      '本地请先 docker compose up -d minio minio-init',
  )
}

const admin = createDb(databaseUrl)
let scratch: Db
let app: ReturnType<typeof createApp>

const DEMO_PASSWORD = 'fish123456'
const DAY = 24 * 60 * 60 * 1000

const ADMIN_ID = '01930000-0000-7000-8000-000000000201'
const BUYER_ID = '01930000-0000-7000-8000-000000000202'
const SELLER_ID = '01930000-0000-7000-8000-000000000203'
const STRANGER_ID = '01930000-0000-7000-8000-000000000204'

const LISTING_OPEN_ID = '01930000-0000-7000-8000-0000000002a1'
const LISTING_CLOSED_ID = '01930000-0000-7000-8000-0000000002a2'
const LISTING_OTHER_ID = '01930000-0000-7000-8000-0000000002a3'

const TX_OPEN_ID = '01930000-0000-7000-8000-0000000002b1'
const TX_CLOSED_ID = '01930000-0000-7000-8000-0000000002b2'
const TX_OTHER_ID = '01930000-0000-7000-8000-0000000002b3'

const CONVERSATION_ID = '01930000-0000-7000-8000-0000000002c1'
const OTHER_CONVERSATION_ID = '01930000-0000-7000-8000-0000000002c2'

const MESSAGE_ID = '01930000-0000-7000-8000-0000000002d1'
const SYSTEM_MESSAGE_ID = '01930000-0000-7000-8000-0000000002d2'
const FOREIGN_MESSAGE_ID = '01930000-0000-7000-8000-0000000002d3'

const publicDisputeId = (uuid: string) => encodePublicId(PUBLIC_ID_PREFIX.dispute, uuid)
const publicTransactionId = (uuid: string) => encodePublicId(PUBLIC_ID_PREFIX.transaction, uuid)

/** 最小可解析 PNG（1 次 IHDR：20x16），confirm 侧会用它校验真实宽高。 */
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 20, 0, 0, 0, 16, 8, 6, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])

/**
 * 另一张**同样 40 字节**的合法 PNG（IHDR 32×24，只改宽高四个字节）。
 * 用于验证 P1-1：预签名 URL 在有效期内可对同一 key 二次 PUT，所以「键唯一」
 * 并不能保证字节不变 —— 读侧必须拿确认时刻的摘要比对。
 */
const PNG_REPLACED = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 32, 0, 0, 0, 24, 8, 6, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  const passwordHash = await Bun.password.hash(DEMO_PASSWORD)
  await scratch.insert(users).values([
    {
      id: ADMIN_ID,
      studentNo: '202101000921',
      passwordHash,
      nickname: '管理员甲',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      role: 'ADMIN',
    },
    {
      id: BUYER_ID,
      studentNo: '202101000922',
      passwordHash,
      nickname: '买家乙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
    {
      id: SELLER_ID,
      studentNo: '202101000923',
      passwordHash,
      nickname: '卖家丙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
    {
      id: STRANGER_ID,
      studentNo: '202101000924',
      passwordHash,
      nickname: '路人丁',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
  ])

  const listingRows: (typeof listings.$inferInsert)[] = []
  for (const listing of [
    { id: LISTING_OPEN_ID, title: '在窗口内的商品' },
    { id: LISTING_CLOSED_ID, title: '超窗商品' },
    { id: LISTING_OTHER_ID, title: '别人的商品' },
  ]) {
    listingRows.push({
      ...listing,
      listingNo: await reserveTestListingNo(scratch, listing.id),
      sellerId: SELLER_ID,
      description: '争议闭环测试用商品',
      priceCents: 9900,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'SOLD',
      createdAt: new Date('2026-09-02T02:00:00Z'),
    })
  }
  await scratch.insert(listings).values(listingRows)

  await scratch.insert(transactions).values([
    {
      id: TX_OPEN_ID,
      listingId: LISTING_OPEN_ID,
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      amountCents: 9900,
      status: 'COMPLETED',
      buyerConfirmedAt: new Date(Date.now() - 3 * DAY),
      sellerConfirmedAt: new Date(Date.now() - 3 * DAY),
      completedAt: new Date(Date.now() - 3 * DAY),
      createdAt: new Date(Date.now() - 4 * DAY),
    },
    {
      id: TX_CLOSED_ID,
      listingId: LISTING_CLOSED_ID,
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      amountCents: 9900,
      status: 'COMPLETED',
      buyerConfirmedAt: new Date(Date.now() - 40 * DAY),
      sellerConfirmedAt: new Date(Date.now() - 40 * DAY),
      completedAt: new Date(Date.now() - 40 * DAY),
      createdAt: new Date(Date.now() - 41 * DAY),
    },
    {
      id: TX_OTHER_ID,
      listingId: LISTING_OTHER_ID,
      buyerId: STRANGER_ID,
      sellerId: SELLER_ID,
      amountCents: 500,
      status: 'PENDING_MEETUP',
      createdAt: new Date(Date.now() - DAY),
    },
  ])

  await scratch.insert(conversations).values([
    {
      id: CONVERSATION_ID,
      listingId: LISTING_OPEN_ID,
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      lastMessageAt: new Date(Date.now() - 2 * DAY),
    },
    {
      id: OTHER_CONVERSATION_ID,
      listingId: LISTING_CLOSED_ID,
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      lastMessageAt: new Date(Date.now() - 2 * DAY),
    },
  ])

  await scratch.insert(messages).values([
    {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SELLER_ID,
      type: 'TEXT',
      content: '货我已经寄出了',
      createdAt: new Date(Date.now() - 2 * DAY),
    },
    {
      id: SYSTEM_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: null,
      type: 'SYSTEM',
      content: '卖家接受了交易确认',
      createdAt: new Date(Date.now() - 2 * DAY),
    },
    {
      id: FOREIGN_MESSAGE_ID,
      conversationId: OTHER_CONVERSATION_ID,
      senderId: SELLER_ID,
      type: 'TEXT',
      content: '这是另一笔交易的聊天',
      createdAt: new Date(Date.now() - 2 * DAY),
    },
  ])

  expect(messageTypeEnum.enumValues).toContain('SYSTEM')
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const post = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const postAs = (cookie: string, body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

function sessionCookie(res: Response): string {
  const cookies = res.headers.getSetCookie()
  const session = cookies.find((value) => value.startsWith('fish_session='))
  if (!session) throw new Error(`响应未下发 fish_session：${cookies.join(' | ')}`)
  return session.split(';')[0] ?? ''
}

async function loginAs(studentNo: string): Promise<string> {
  const res = await app.request('/auth/login', post({ studentNo, password: DEMO_PASSWORD }))
  expect(res.status).toBe(200)
  return sessionCookie(res)
}

let adminCookie: string
let buyerCookie: string
let sellerCookie: string
let strangerCookie: string

type ErrorBody = { error: { code: string; message: string; details?: { field: string }[] } }

async function errorOf(res: Response): Promise<ErrorBody['error']> {
  return ((await res.json()) as ErrorBody).error
}

describe('争议闭环（#465）', () => {
  test('setup: login all accounts', async () => {
    adminCookie = await loginAs('202101000921')
    buyerCookie = await loginAs('202101000922')
    sellerCookie = await loginAs('202101000923')
    strangerCookie = await loginAs('202101000924')
  })

  test('匿名一律 401（发起 / 我的 / 详情 / 撤回 / 附件 / 证据）', async () => {
    const cases: [string, RequestInit][] = [
      [
        DISPUTE_ROUTES.create,
        post({ transactionId: publicTransactionId(TX_OPEN_ID), type: 'OTHER' }),
      ],
      [DISPUTE_ROUTES.mine, {}],
      [DISPUTE_ROUTES.detail(publicDisputeId(newId())), {}],
      [DISPUTE_ROUTES.withdraw(publicDisputeId(newId())), post({})],
      [
        DISPUTE_ROUTES.attachmentPresign(publicDisputeId(newId())),
        post({ contentType: 'image/png', sizeBytes: 10 }),
      ],
      [DISPUTE_ROUTES.attachmentConfirm(publicDisputeId(newId())), post({ objectKey: 'x' })],
      [DISPUTE_ROUTES.evidenceMessages(publicDisputeId(newId())), post({ messageId: 'x' })],
    ]
    for (const [path, init] of cases) {
      const res = await app.request(path, init)
      expect(res.status).toBe(401)
      expect((await errorOf(res)).code).toBe('UNAUTHENTICATED')
    }
  })

  test('外人不可枚举也不可操作：非参与人发起一律 404（读取 / 撤回的 404 见下方用例）', async () => {
    const create = await app.request(
      DISPUTE_ROUTES.create,
      postAs(strangerCookie, {
        transactionId: publicTransactionId(TX_OPEN_ID),
        type: 'ITEM_MISMATCH',
      }),
    )
    expect(create.status).toBe(404)
    expect((await errorOf(create)).code).toBe('DISPUTE_TRANSACTION_NOT_FOUND')

    // 不存在的交易 id 与「不是我的交易」同码同文案。
    const missing = await app.request(
      DISPUTE_ROUTES.create,
      postAs(strangerCookie, {
        transactionId: publicTransactionId('01930000-0000-7000-8000-0000000002ff'),
        type: 'ITEM_MISMATCH',
      }),
    )
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('DISPUTE_TRANSACTION_NOT_FOUND')
  })

  test('发起争议：本人订单 + 服务端校验参与人；请求体不能指定被诉方', async () => {
    const bad = await app.request(
      DISPUTE_ROUTES.create,
      postAs(buyerCookie, {
        transactionId: publicTransactionId(TX_OPEN_ID),
        type: 'OTHER',
      }),
    )
    expect(bad.status).toBe(422)
    expect((await errorOf(bad)).code).toBe('VALIDATION_FAILED')

    const res = await app.request(
      DISPUTE_ROUTES.create,
      postAs(buyerCookie, {
        transactionId: publicTransactionId(TX_OPEN_ID),
        type: 'ITEM_MISMATCH',
        detailText: '收到的商品与描述不符',
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      created: boolean
      dispute: { id: string; status: string; initiator: { id: string }; respondent: { id: string } }
    }
    expect(body.created).toBe(true)
    expect(body.dispute.status).toBe('PENDING')
    expect(body.dispute.initiator.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, BUYER_ID))
    // 被诉方由交易推导：发起人是买家 → 被诉方是卖家。
    expect(body.dispute.respondent.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID))

    // 重复提交同一方向同一交易：200 + created:false（不是 409），超时重试无感。
    const again = await app.request(
      DISPUTE_ROUTES.create,
      postAs(buyerCookie, {
        transactionId: publicTransactionId(TX_OPEN_ID),
        type: 'ITEM_MISMATCH',
      }),
    )
    expect(again.status).toBe(200)
    expect(((await again.json()) as { created: boolean }).created).toBe(false)
  })

  test('终态交易超过 30 天关窗（409），PENDING_MEETUP 期间没有时限', async () => {
    const closed = await app.request(
      DISPUTE_ROUTES.create,
      postAs(buyerCookie, {
        transactionId: publicTransactionId(TX_CLOSED_ID),
        type: 'NOT_COMPLETED',
      }),
    )
    expect(closed.status).toBe(409)
    expect((await errorOf(closed)).code).toBe('DISPUTE_WINDOW_CLOSED')

    const pending = await app.request(
      DISPUTE_ROUTES.create,
      postAs(strangerCookie, {
        transactionId: publicTransactionId(TX_OTHER_ID),
        type: 'PAYMENT_ISSUE',
      }),
    )
    expect(pending.status).toBe(201)
  })

  test('双方都能看到同一条争议；外人读详情 404；列表只给本人相关', async () => {
    const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
    expect(mine.status).toBe(200)
    const list = (await mine.json()) as { items: { id: string }[]; nextCursor: string | null }
    expect(list.items.length).toBeGreaterThan(0)
    const disputeId = list.items[0]?.id ?? ''

    const asSeller = await app.request(DISPUTE_ROUTES.detail(disputeId), {
      headers: { cookie: sellerCookie },
    })
    expect(asSeller.status).toBe(200)

    const asStranger = await app.request(DISPUTE_ROUTES.detail(disputeId), {
      headers: { cookie: strangerCookie },
    })
    expect(asStranger.status).toBe(404)
    expect((await errorOf(asStranger)).code).toBe('DISPUTE_NOT_FOUND')

    // 被诉方的「我的争议」里也有这条（不是只有发起人看得到）。
    const sellerMine = await app.request(DISPUTE_ROUTES.mine, {
      headers: { cookie: sellerCookie },
    })
    const sellerList = (await sellerMine.json()) as { items: { id: string }[] }
    expect(sellerList.items.some((item) => item.id === disputeId)).toBe(true)

    // 畸形 / 错误前缀的 id 不泄漏存在性。
    const malformed = await app.request(
      DISPUTE_ROUTES.detail(encodePublicId(PUBLIC_ID_PREFIX.report, newId())),
      {
        headers: { cookie: buyerCookie },
      },
    )
    expect(malformed.status).toBe(404)
  })

  test('聊天证据：只能关联本交易会话里的消息，且只回单条（不含 conversationId）', async () => {
    const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
    const disputeId = ((await mine.json()) as { items: { id: string }[] }).items[0]?.id ?? ''

    const foreign = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(buyerCookie, {
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, FOREIGN_MESSAGE_ID),
      }),
    )
    expect(foreign.status).toBe(404)
    expect((await errorOf(foreign)).code).toBe('DISPUTE_MESSAGE_NOT_FOUND')

    const unknown = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(buyerCookie, {
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, '01930000-0000-7000-8000-0000000002ff'),
      }),
    )
    expect(unknown.status).toBe(404)

    const ok = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(buyerCookie, { messageId: encodePublicId(PUBLIC_ID_PREFIX.message, MESSAGE_ID) }),
    )
    expect(ok.status).toBe(201)

    // 重复关联幂等。
    const duplicate = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(buyerCookie, { messageId: encodePublicId(PUBLIC_ID_PREFIX.message, MESSAGE_ID) }),
    )
    expect(duplicate.status).toBe(200)

    // SYSTEM 消息（无发送者）也可以作为证据。
    const system = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(buyerCookie, {
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, SYSTEM_MESSAGE_ID),
      }),
    )
    expect(system.status).toBe(201)

    // 被诉方（卖家）不能补材料：与「争议不存在」同码同文案，不泄漏存在性（plan §4 冻结口径）。
    const respondent = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(sellerCookie, {
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, SYSTEM_MESSAGE_ID),
      }),
    )
    expect(respondent.status).toBe(404)
    expect((await errorOf(respondent)).code).toBe('DISPUTE_NOT_FOUND')

    const detail = await app.request(DISPUTE_ROUTES.detail(disputeId), {
      headers: { cookie: buyerCookie },
    })
    const parsed = (await detail.json()) as {
      evidence: { message: Record<string, unknown> }[]
    }
    expect(parsed.evidence).toHaveLength(2)
    expect(parsed.evidence[0]?.message.conversationId).toBeUndefined()
    expect(parsed.evidence[0]?.message.content).toBe('货我已经寄出了')
  })

  test('上传失败（对象未写入）与越权（别人的键）都是 422', async () => {
    const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
    const disputeId =
      ((await mine.json()) as { items: { id: string }[] }).items.find((item) =>
        item.id.startsWith('dsp_'),
      )?.id ?? ''

    const presign = await app.request(
      DISPUTE_ROUTES.attachmentPresign(disputeId),
      postAs(buyerCookie, { contentType: 'image/png', sizeBytes: PNG.length }),
    )
    expect(presign.status).toBe(200)
    const { objectKey } = (await presign.json()) as { objectKey: string }
    expect(objectKey).toStartWith('dispute-media/')

    // 还没 PUT 就去 confirm：stat 读不到对象。
    const notUploaded = await app.request(
      DISPUTE_ROUTES.attachmentConfirm(disputeId),
      postAs(buyerCookie, { objectKey }),
    )
    expect(notUploaded.status).toBe(422)
    expect((await errorOf(notUploaded)).code).toBe('DISPUTE_ATTACHMENT_INVALID')

    // 发起人（买家）拿别人的键来登记：uploader 段不是自己 → 422。
    // 被诉方走不到这一步 —— 它在 requireInitiator 就被拦成 404（下一段单独断言）。
    const foreignKey = `dispute-media/${disputeId}/${encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.png`
    const foreign = await app.request(
      DISPUTE_ROUTES.attachmentConfirm(disputeId),
      postAs(buyerCookie, { objectKey: foreignKey }),
    )
    expect(foreign.status).toBe(422)
    expect((await errorOf(foreign)).code).toBe('DISPUTE_ATTACHMENT_INVALID')

    // 被诉方（卖家）连补材料的入口都没有：presign / confirm 一律 404，与「争议不存在」同码。
    const sellerPresign = await app.request(
      DISPUTE_ROUTES.attachmentPresign(disputeId),
      postAs(sellerCookie, { contentType: 'image/png', sizeBytes: PNG.length }),
    )
    expect(sellerPresign.status).toBe(404)
    const sellerConfirm = await app.request(
      DISPUTE_ROUTES.attachmentConfirm(disputeId),
      postAs(sellerCookie, { objectKey }),
    )
    expect(sellerConfirm.status).toBe(404)
    expect((await errorOf(sellerConfirm)).code).toBe('DISPUTE_NOT_FOUND')

    // 键的争议段与路径不一致：**路径用真实争议**（否则先被 requireVisible 404 挡下，
    // 这条断言就测不到归属闸门），键换成另一个争议的 dsp_。断言文案而不是只断言状态码：
    // 去掉归属闸门后这里会落到「图片尚未上传完成」，状态码同样是 422。
    const otherDispute = publicDisputeId(newId())
    const otherKey = `dispute-media/${otherDispute}/${encodePublicId(PUBLIC_ID_PREFIX.user, BUYER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.png`
    const mismatch = await app.request(
      DISPUTE_ROUTES.attachmentConfirm(disputeId),
      postAs(buyerCookie, { objectKey: otherKey }),
    )
    expect(mismatch.status).toBe(422)
    const mismatchError = await errorOf(mismatch)
    expect(mismatchError.code).toBe('DISPUTE_ATTACHMENT_INVALID')
    expect(mismatchError.message).toBe('附件对象键不属于本次争议')
  })

  // 无 S3 时**显式跳过**（`test.skipIf` 在定义期求值，`storageUp` 是顶层 await 所以拿得到），
  // 不再用 `if (!storageUp) return` —— 那种写法在报告里显示为通过，会让人以为附件链路验过了。
  test.skipIf(!storageUp)(
    '附件真实端到端：presign → PUT → confirm → 私有代理匿名可读（不带 cookie）',
    async () => {
      const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
      const disputeId = ((await mine.json()) as { items: { id: string }[] }).items[0]?.id ?? ''

      const presign = await app.request(
        DISPUTE_ROUTES.attachmentPresign(disputeId),
        postAs(buyerCookie, {
          contentType: 'image/png',
          sizeBytes: PNG.length + 1, // 声明值只用于上限校验，真实大小以实读字节为准
        }),
      )
      const { uploadUrl, objectKey } = (await presign.json()) as {
        uploadUrl: string
        objectKey: string
      }
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        body: PNG,
        headers: { 'content-type': 'image/png' },
      })
      expect(put.ok).toBe(true)

      const confirm = await app.request(
        DISPUTE_ROUTES.attachmentConfirm(disputeId),
        postAs(buyerCookie, { objectKey }),
      )
      expect(confirm.status).toBe(201)
      const confirmed = (await confirm.json()) as {
        created: boolean
        attachment: { url: string; width: number; height: number; sizeBytes: number }
      }
      expect(confirmed.created).toBe(true)
      expect(confirmed.attachment.width).toBe(20)
      expect(confirmed.attachment.height).toBe(16)
      expect(confirmed.attachment.sizeBytes).toBe(PNG.length)

      // 同一对象键重复确认：幂等，不新增行（但内部仍重读字节核对摘要）。
      const repeat = await app.request(
        DISPUTE_ROUTES.attachmentConfirm(disputeId),
        postAs(buyerCookie, { objectKey }),
      )
      expect(repeat.status).toBe(200)
      expect(((await repeat.json()) as { created: boolean }).created).toBe(false)

      // 私有读路径：能力令牌 URL，不带会话 cookie 也能读（小程序原生 <Image> 不带 cookie）。
      const token = new URL(confirmed.attachment.url).pathname.split('/').at(-1) ?? ''
      const read = await app.request(`/uploads/dispute-media/${token}`)
      expect(read.status).toBe(200)
      expect(read.headers.get('content-type')).toBe('image/png')
      expect(read.headers.get('x-content-type-options')).toBe('nosniff')
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG)

      // 篡改令牌 / 空路径都不给读。
      expect(
        (await app.request('/uploads/dispute-media/tampered-token-0000000000000000')).status,
      ).toBe(404)

      // 详情里带上附件（详情是唯一出口）。
      const detail = await app.request(DISPUTE_ROUTES.detail(disputeId), {
        headers: { cookie: sellerCookie },
      })
      const parsed = (await detail.json()) as { attachments: { id: string }[] }
      expect(parsed.attachments).toHaveLength(1)

      // ── P1-1：预签名 URL 在有效期内仍可对同一 key 二次 PUT ──────────────────
      // 用**同一个 uploadUrl** 换成另一张同样大小的合法 PNG（IHDR 32×24）。
      const replace = await fetch(uploadUrl, {
        method: 'PUT',
        body: PNG_REPLACED,
        headers: { 'content-type': 'image/png' },
      })
      expect(replace.ok).toBe(true)

      // 读侧按确认时刻的摘要比对实读字节：不一致就拒绝下发，绝不让裁决者看到被换过的图。
      const afterReplace = await app.request(`/uploads/dispute-media/${token}`)
      expect(afterReplace.status).toBe(404)

      // 重复确认同样被识破（幂等路径也重读字节）。
      const repeatAfterReplace = await app.request(
        DISPUTE_ROUTES.attachmentConfirm(disputeId),
        postAs(buyerCookie, { objectKey }),
      )
      expect(repeatAfterReplace.status).toBe(422)
      expect((await errorOf(repeatAfterReplace)).message).toBe('附件内容已被替换')
    },
  )

  test('附件上限 6 张，第 7 张 422 DISPUTE_ATTACHMENT_LIMIT', async () => {
    const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
    const disputeId = ((await mine.json()) as { items: { id: string }[] }).items[0]?.id ?? ''
    const disputeUuid = decodePublicId(PUBLIC_ID_PREFIX.dispute, disputeId)

    // 直接落 6 行台账（对象内容与本用例无关，只验证计数闸门）。
    await scratch.insert(disputeAttachments).values(
      Array.from({ length: 6 }, () => {
        const mediaId = newId()
        return {
          id: mediaId,
          disputeId: disputeUuid,
          uploaderId: BUYER_ID,
          objectKey: `dispute-media/${disputeId}/${encodePublicId(PUBLIC_ID_PREFIX.user, BUYER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, mediaId)}.png`,
          mimeType: 'image/png',
          sizeBytes: 10,
          width: 20,
          height: 16,
          // 直接落行也要给摘要：列是 NOT NULL 且有 '^[0-9a-f]{64}$' CHECK。
          contentDigest: contentDigestOf(new TextEncoder().encode('tenant-fixture')),
        }
      }),
    )

    const presign = await app.request(
      DISPUTE_ROUTES.attachmentPresign(disputeId),
      postAs(buyerCookie, { contentType: 'image/png', sizeBytes: 10 }),
    )
    expect(presign.status).toBe(422)
    expect((await errorOf(presign)).code).toBe('DISPUTE_ATTACHMENT_LIMIT')
  })

  test('撤回：被诉方 404、发起人 200，撤回后不能再补材料，但可再发起新争议', async () => {
    const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
    const disputeId = ((await mine.json()) as { items: { id: string }[] }).items[0]?.id ?? ''

    const byRespondent = await app.request(
      DISPUTE_ROUTES.withdraw(disputeId),
      postAs(sellerCookie, {}),
    )
    expect(byRespondent.status).toBe(404)

    const ok = await app.request(DISPUTE_ROUTES.withdraw(disputeId), postAs(buyerCookie, {}))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { status: string }).status).toBe('WITHDRAWN')

    const afterWithdraw = await app.request(
      DISPUTE_ROUTES.evidenceMessages(disputeId),
      postAs(buyerCookie, {
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, SYSTEM_MESSAGE_ID),
      }),
    )
    expect(afterWithdraw.status).toBe(409)
    expect((await errorOf(afterWithdraw)).code).toBe('DISPUTE_NOT_PENDING')

    const again = await app.request(
      DISPUTE_ROUTES.create,
      postAs(buyerCookie, {
        transactionId: publicTransactionId(TX_OPEN_ID),
        type: 'NOT_COMPLETED',
      }),
    )
    expect(again.status).toBe(201)
  })

  test('管理端：非管理员 403，队列可筛选，详情可用', async () => {
    const forbidden = await app.request(ADMIN_ROUTES.disputes, {
      headers: { cookie: buyerCookie },
    })
    expect(forbidden.status).toBe(403)
    expect((await errorOf(forbidden)).code).toBe('FORBIDDEN')

    const queue = await app.request(`${ADMIN_ROUTES.disputes}?status=PENDING&limit=10`, {
      headers: { cookie: adminCookie },
    })
    expect(queue.status).toBe(200)
    const items = (
      (await queue.json()) as {
        items: {
          dispute: { id: string; status: string }
          attachmentCount: number
          evidenceCount: number
          disputeCount: number
        }[]
      }
    ).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.dispute.status === 'PENDING')).toBe(true)
    const first = items[0]
    if (!first) throw new Error('队列应至少有一条争议')
    expect(first.disputeCount).toBeGreaterThanOrEqual(1)

    const target = first.dispute.id
    const detail = await app.request(ADMIN_ROUTES.disputeDetail(target), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const parsed = (await detail.json()) as {
      item: { dispute: { id: string }; disputeCount: number }
      attachments: unknown[]
      evidence: unknown[]
      related: { id: string; status: string }[]
    }
    expect(parsed.item.dispute.id).toBe(target)
    // `related` 只给同交易的**未决**争议（同 reports 的 listRelatedPending）。
    expect(parsed.related.every((row) => row.status === 'PENDING')).toBe(true)
    // 详情与队列的 disputeCount 必须同口径（同交易全部争议数），否则管理员会看到两个数。
    expect(parsed.item.disputeCount).toBe(first.disputeCount)

    // 关键词筛选命中说明文本。
    const search = await app.request(`${ADMIN_ROUTES.disputes}?q=描述不符`, {
      headers: { cookie: adminCookie },
    })
    expect(search.status).toBe(200)
  })

  test('处理争议：204 + 审计 + 通知双方；重复/并发处理 409；不改成交事实也不触发处罚', async () => {
    const mine = await app.request(DISPUTE_ROUTES.mine, { headers: { cookie: buyerCookie } })
    const target = ((await mine.json()) as { items: { id: string }[] }).items.find((item) =>
      item.id.startsWith('dsp_'),
    )?.id
    expect(target).toBeTruthy()
    const disputeUuid = decodePublicId(PUBLIC_ID_PREFIX.dispute, target ?? '')

    const listingBefore = await scratch
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, LISTING_OPEN_ID))
    const txBefore = await scratch
      .select({ status: transactions.status })
      .from(transactions)
      .where(eq(transactions.id, TX_OPEN_ID))

    // 处理输入里没有任何治理字段：多传就 422，封禁/下架必须走另外的端点。
    const extraField = await app.request(
      ADMIN_ROUTES.disputeResolve(target ?? ''),
      postAs(adminCookie, { resolution: 'UPHELD', reason: '属实', ban: true }),
    )
    expect(extraField.status).toBe(422)
    expect((await errorOf(extraField)).code).toBe('VALIDATION_FAILED')

    const resolved = await app.request(
      ADMIN_ROUTES.disputeResolve(target ?? ''),
      postAs(adminCookie, { resolution: 'UPHELD', reason: '商品与描述确实不符' }),
    )
    expect(resolved.status).toBe(204)

    // 再处理一次：条件更新 0 行 → 409。
    const conflict = await app.request(
      ADMIN_ROUTES.disputeResolve(target ?? ''),
      postAs(adminCookie, { resolution: 'DISMISSED', reason: '再处理一次' }),
    )
    expect(conflict.status).toBe(409)
    expect((await errorOf(conflict)).code).toBe('DISPUTE_CONFLICT')

    // 审计：目标类型 DISPUTE、动作 DISPUTE_DECISION、actor 是管理员、原因入账。
    const audits = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, disputeUuid))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.action).toBe('DISPUTE_DECISION')
    expect(audits[0]?.targetType).toBe('DISPUTE')
    expect(audits[0]?.actorUserId).toBe(ADMIN_ID)
    expect(audits[0]?.reason).toBe('商品与描述确实不符')

    // 结果通知：双方各一条 DISPUTE/RESOLVED。
    const sellerNotifications = await scratch
      .select()
      .from(notifications)
      .where(eq(notifications.userId, SELLER_ID))
    const buyerNotifications = await scratch
      .select()
      .from(notifications)
      .where(eq(notifications.userId, BUYER_ID))
    expect(sellerNotifications.some((n) => n.type === 'DISPUTE')).toBe(true)
    expect(buyerNotifications.some((n) => n.type === 'DISPUTE')).toBe(true)

    // 读侧通知里争议 id 是公开 ID（不是裸 UUID）。
    const feed = await app.request('/notifications', { headers: { cookie: sellerCookie } })
    expect(feed.status).toBe(200)
    const feedItems = (
      (await feed.json()) as {
        items: { type: string; payload: { disputeId?: string; disputeEvent?: string } }[]
      }
    ).items
    const disputeItem = feedItems.find((item) => item.type === 'DISPUTE')
    expect(disputeItem?.payload.disputeId).toBe(target)
    expect(disputeItem?.payload.disputeEvent).toBe('RESOLVED')

    // 成交事实与商品状态一律不变。
    const listingAfter = await scratch
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, LISTING_OPEN_ID))
    const txAfter = await scratch
      .select({ status: transactions.status })
      .from(transactions)
      .where(eq(transactions.id, TX_OPEN_ID))
    expect(listingAfter).toEqual(listingBefore)
    expect(txAfter).toEqual(txBefore)

    // 处理争议不产生任何治理动作。
    const restrictions = await scratch
      .select()
      .from(userRestrictions)
      .where(eq(userRestrictions.userId, SELLER_ID))
    expect(restrictions).toHaveLength(0)

    // 结论对双方可见，且不能被再次撤回。
    const detail = await app.request(DISPUTE_ROUTES.detail(target ?? ''), {
      headers: { cookie: sellerCookie },
    })
    const parsed = (await detail.json()) as {
      status: string
      resolution: string
      resolutionNote: string
    }
    expect(parsed.status).toBe('RESOLVED')
    expect(parsed.resolution).toBe('UPHELD')
    expect(parsed.resolutionNote).toBe('商品与描述确实不符')

    const withdraw = await app.request(
      DISPUTE_ROUTES.withdraw(target ?? ''),
      postAs(buyerCookie, {}),
    )
    expect(withdraw.status).toBe(409)
  })

  /**
   * P2-2 的同事务证明：通知不是 best-effort 旁路。
   * 用一个必定抛错的 writer 直接调 store（绕开 app 接线），断言争议行**整体回滚** ——
   * 若通知是提交后再写，这里会留下一行没有通知的争议，而库里没有 outbox 可以补。
   */
  test('通知与状态变更同事务：写通知失败时争议行不落库', async () => {
    const sellerPendingOnOpen = () =>
      scratch
        .select({ id: disputes.id })
        .from(disputes)
        .where(and(eq(disputes.transactionId, TX_OPEN_ID), eq(disputes.initiatorId, SELLER_ID)))
    const disputeNotifications = async (): Promise<number> =>
      (
        await scratch
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(eq(notifications.userId, BUYER_ID), eq(notifications.type, 'DISPUTE')))
      ).length

    expect(await sellerPendingOnOpen()).toHaveLength(0)
    const notificationsBefore = await disputeNotifications()

    const store = createSqlDisputeStore(scratch, {
      notify: async () => {
        throw new Error('通知写入失败（模拟同事务内的失败）')
      },
    })
    await expect(
      store.insertDispute({
        transactionId: TX_OPEN_ID,
        initiatorId: SELLER_ID,
        respondentId: BUYER_ID,
        type: 'ITEM_MISMATCH',
        detailText: null,
      }),
    ).rejects.toThrow('通知写入失败（模拟同事务内的失败）')

    // 事务回滚：争议行不存在，被诉方也没有多出一条通知。
    expect(await sellerPendingOnOpen()).toHaveLength(0)
    expect(await disputeNotifications()).toBe(notificationsBefore)
  })

  /**
   * P1-1 的行锁证明：状态校验必须在**拿到行锁之后**读，而不是复用请求开始时的快照。
   *
   * 真实窗口是「service 读到 PENDING → 读 S3 字节（几百毫秒）→ 落库」，期间管理员可能已经
   * resolve。这里不制造并发，而是直接把争议推到终态再调 store：若 store 只看行是否存在
   * （修复前的写法），终态争议照样能写进附件与证据。
   */
  test('P1-1：终态争议在行锁内被拦下 —— resolve 之后附件与证据都写不进去', async () => {
    const store = createSqlDisputeStore(scratch)
    const created = await store.insertDispute({
      transactionId: TX_CLOSED_ID,
      initiatorId: SELLER_ID,
      respondentId: BUYER_ID,
      type: 'NOT_COMPLETED',
      detailText: null,
    })
    expect(created.kind).toBe('created')
    const disputeId = created.disputeId
    const uploader = encodePublicId(PUBLIC_ID_PREFIX.user, SELLER_ID)

    const attachmentInput = () => {
      const mediaId = newId()
      return {
        id: mediaId,
        disputeId,
        uploaderId: SELLER_ID,
        objectKey: `dispute-media/${disputeId}/${uploader}/${encodePublicId(PUBLIC_ID_PREFIX.media, mediaId)}.png`,
        mimeType: 'image/png',
        sizeBytes: 10,
        width: 20,
        height: 16,
        contentDigest: contentDigestOf(new TextEncoder().encode('lock-fixture')),
      }
    }

    // PENDING 时写得进（否则下面的 not-pending 可能只是「行不存在」）。
    expect((await store.insertAttachment(attachmentInput(), 6)).kind).toBe('created')
    expect(
      (await store.insertEvidence({ disputeId, messageId: MESSAGE_ID, addedBy: SELLER_ID })).kind,
    ).toBe('created')

    expect(
      await store.resolveDispute({
        disputeId,
        actorUserId: ADMIN_ID,
        resolution: 'DISMISSED',
        reason: '行锁测试',
      }),
    ).toBe('applied')

    // 终态之后：附件与证据都在锁内被拒。
    expect((await store.insertAttachment(attachmentInput(), 6)).kind).toBe('not-pending')
    expect(
      (await store.insertEvidence({ disputeId, messageId: SYSTEM_MESSAGE_ID, addedBy: SELLER_ID }))
        .kind,
    ).toBe('not-pending')

    // 落库行数确实没有增加：1 条附件、1 条证据。
    expect(await store.countAttachments(disputeId)).toBe(1)
    expect(await store.countEvidence(disputeId)).toBe(1)
  })
})
