import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { chatModerationRecords } from '@fish/db/schema/chat-moderation'
import { conversations } from '@fish/db/schema/conversations'
import { listings } from '@fish/db/schema/listings'
import { messageMedia } from '@fish/db/schema/message-media'
import { messages } from '@fish/db/schema/messages'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
import { createSessions } from '../auth/session'

/**
 * 管理端聊天待审闭环（#694 M2）：队列 → 版本化决策 → 可见性/未读时间 → 审计 → 幂等/冲突。
 *
 * 自建 scratch 库（直连主库会污染他人的待审队列），与 reports/router.test.ts 同款。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_chat_moderation_test_${process.pid}`
const databaseUrlFor = (name: string) => {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const admin = createDb(databaseUrl)
let scratch: Db
let app: ReturnType<typeof createApp>

const ADMIN_ID = '01930000-0000-7000-8000-0000000000e1'
const BUYER_ID = '01930000-0000-7000-8000-0000000000e2'
const SELLER_ID = '01930000-0000-7000-8000-0000000000e3'
const LISTING_ID = '01930000-0000-7000-8000-0000000000e4'
const CONVERSATION_ID = '01930000-0000-7000-8000-0000000000e5'
const TEXT_MESSAGE_ID = '01930000-0000-7000-8000-0000000000e6'
const MEDIA_MESSAGE_ID = '01930000-0000-7000-8000-0000000000e7'
const TEXT_RECORD_ID = '01930000-0000-7000-8000-0000000000e8'
const MEDIA_RECORD_ID = '01930000-0000-7000-8000-0000000000e9'

const queueUrl = '/admin/chat-moderation'
const decisionUrl = (recordId: string) => `${queueUrl}/${recordId}/decision`

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(databaseUrlFor(scratchDatabase))
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: databaseUrlFor(scratchDatabase) })

  await scratch.insert(users).values([
    {
      id: ADMIN_ID,
      nickname: '聊天审核员',
      role: 'ADMIN',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
    },
    { id: BUYER_ID, nickname: '买家', createdAt: new Date('2026-09-02T00:00:00Z') },
    { id: SELLER_ID, nickname: '卖家', createdAt: new Date('2026-09-02T00:00:00Z') },
  ])
  await scratch.insert(listings).values({
    id: LISTING_ID,
    listingNo: await reserveTestListingNo(scratch, LISTING_ID),
    sellerId: SELLER_ID,
    title: '聊天待审商品',
    description: '用于管理端待审队列测试',
    priceCents: 100,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-02T02:00:00Z'),
  })
  await scratch.insert(conversations).values({
    id: CONVERSATION_ID,
    listingId: LISTING_ID,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
    lastMessageAt: new Date('2026-09-02T03:00:00Z'),
    createdAt: new Date('2026-09-02T03:00:00Z'),
  })
  await scratch.insert(messages).values([
    {
      id: TEXT_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SELLER_ID,
      type: 'TEXT',
      content: '这条文字在等人工复核',
      visibility: 'PENDING_REVIEW',
      createdAt: new Date('2026-09-02T03:01:00Z'),
    },
    {
      id: MEDIA_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SELLER_ID,
      type: 'MEDIA',
      content: '',
      visibility: 'PENDING_REVIEW',
      createdAt: new Date('2026-09-02T03:02:00Z'),
    },
  ])
  await scratch.insert(messageMedia).values({
    messageId: MEDIA_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    ownerId: SELLER_ID,
    kind: 'IMAGE',
    objectKey: 'chat-media-final/2026/09/02/01930000-0000-7000-8000-0000000000ea.webp',
    mimeType: 'image/webp',
    sizeBytes: 2048,
    width: 800,
    height: 600,
    createdAt: new Date('2026-09-02T03:02:00Z'),
  })
  await scratch.insert(chatModerationRecords).values([
    {
      id: TEXT_RECORD_ID,
      messageId: TEXT_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SELLER_ID,
      kind: 'TEXT',
      decision: 'REVIEW',
      machineDecision: 'REVIEW',
      status: 'PENDING',
      provider: 'LOCAL',
      policyVersion: 'test',
      suggestion: 'Review',
      matchedRules: ['EXTERNAL_CONTACT'],
      matchedTermsMasked: ['加*信'],
      version: 0,
      createdAt: new Date('2026-09-02T03:01:00Z'),
    },
    {
      id: MEDIA_RECORD_ID,
      messageId: MEDIA_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SELLER_ID,
      kind: 'IMAGE',
      decision: 'REVIEW',
      machineDecision: 'REVIEW',
      status: 'PENDING',
      provider: 'TENCENT_IMS',
      providerRequestId: 'req-1',
      policyVersion: 'ims-chat',
      suggestion: 'Review',
      matchedRules: [],
      matchedTermsMasked: [],
      version: 0,
      createdAt: new Date('2026-09-02T03:02:00Z'),
    },
  ])
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const postAs = (cookie: string, body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

async function loginAs(userId: string): Promise<string> {
  const { token } = await createSessions(scratch).create(userId)
  return `fish_session=${token}`
}

let adminCookie: string
let buyerCookie: string

describe('管理端聊天待审（#694 M2）', () => {
  test('setup: login', async () => {
    adminCookie = await loginAs(ADMIN_ID)
    buyerCookie = await loginAs(BUYER_ID)
  })

  test('匿名 401、普通用户 403，队列/决策/媒体都不放行', async () => {
    const anonymous = await app.request(queueUrl)
    expect(anonymous.status).toBe(401)
    const forbidden = await app.request(queueUrl, { headers: { cookie: buyerCookie } })
    expect(forbidden.status).toBe(403)
    const forbiddenDecision = await app.request(
      decisionUrl(encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, TEXT_RECORD_ID)),
      postAs(buyerCookie, { decision: 'ALLOW', reason: 'x', version: 0 }),
    )
    expect(forbiddenDecision.status).toBe(403)
  })

  test('队列按时间倒序，TEXT 带正文、媒体只给元数据', async () => {
    const res = await app.request(queueUrl, { headers: { cookie: adminCookie } })
    if (res.status !== 200) console.error('queue-debug', res.status, await res.clone().text())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: {
        id: string
        kind: string
        content: string | null
        hasMedia: boolean
        mimeType: string | null
      }[]
      nextCursor: string | null
    }
    expect(body.items.map((item) => item.kind)).toEqual(['IMAGE', 'TEXT'])
    expect(body.items[0]).toMatchObject({ hasMedia: true, content: null, mimeType: 'image/webp' })
    expect(body.items[1]).toMatchObject({ hasMedia: false, content: '这条文字在等人工复核' })
    expect(body.nextCursor).toBeNull()
  })

  test('旧版本决策 409，不改变可见性', async () => {
    const res = await app.request(
      decisionUrl(encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, TEXT_RECORD_ID)),
      postAs(adminCookie, { decision: 'ALLOW', reason: '人工放行', version: 9 }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'CHAT_MODERATION_CONFLICT' },
    })
  })

  test('BLOCK 落终态、写审计，重复提交幂等重放，改判冲突', async () => {
    const url = decisionUrl(encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, TEXT_RECORD_ID))
    const first = await app.request(
      url,
      postAs(adminCookie, { decision: 'BLOCK', reason: '含站外联系方式', version: 0 }),
    )
    expect(first.status).toBe(200)
    expect((await first.json()) as { replayed: boolean }).toMatchObject({ replayed: false })

    const [row] = await scratch
      .select({ visibility: messages.visibility })
      .from(messages)
      .where(eq(messages.id, TEXT_MESSAGE_ID))
    expect(row?.visibility).toBe('REJECTED')

    const [record] = await scratch
      .select({
        status: chatModerationRecords.status,
        decision: chatModerationRecords.decision,
        reviewedBy: chatModerationRecords.reviewedBy,
        version: chatModerationRecords.version,
      })
      .from(chatModerationRecords)
      .where(eq(chatModerationRecords.id, TEXT_RECORD_ID))
    expect(record).toMatchObject({
      status: 'SETTLED',
      decision: 'BLOCK',
      reviewedBy: ADMIN_ID,
      version: 1,
    })

    const auditRows = await scratch
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, TEXT_RECORD_ID))
    expect(auditRows).toHaveLength(1)

    const replay = await app.request(
      url,
      postAs(adminCookie, { decision: 'BLOCK', reason: '含站外联系方式', version: 0 }),
    )
    expect(replay.status).toBe(200)
    expect((await replay.json()) as { replayed: boolean }).toMatchObject({ replayed: true })

    const conflict = await app.request(
      url,
      postAs(adminCookie, { decision: 'ALLOW', reason: '改判', version: 1 }),
    )
    expect(conflict.status).toBe(409)
  })

  test('ALLOW 写 delivered_at，接收者可见、队列移除', async () => {
    const url = decisionUrl(encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, MEDIA_RECORD_ID))
    const res = await app.request(
      url,
      postAs(adminCookie, { decision: 'ALLOW', reason: '人工确认无风险', version: 0 }),
    )
    expect(res.status).toBe(200)

    const [row] = await scratch
      .select({ visibility: messages.visibility, deliveredAt: messages.deliveredAt })
      .from(messages)
      .where(eq(messages.id, MEDIA_MESSAGE_ID))
    expect(row?.visibility).toBe('DELIVERED')
    expect(row?.deliveredAt).not.toBeNull()

    const queue = await app.request(queueUrl, { headers: { cookie: adminCookie } })
    const body = (await queue.json()) as { items: { id: string }[]; nextCursor: string | null }
    expect(body.items).toHaveLength(0)
    expect(body.nextCursor).toBeNull()
  })

  test('不存在的记录 404', async () => {
    const res = await app.request(
      decisionUrl(
        encodePublicId(
          PUBLIC_ID_PREFIX.chatModerationRecord,
          '01930000-0000-7000-8000-0000000000ff',
        ),
      ),
      postAs(adminCookie, { decision: 'ALLOW', reason: 'x', version: 0 }),
    )
    expect(res.status).toBe(404)
  })
})

describe('管理端聊天待审：校验与媒体取证（#694 M2）', () => {
  const recordPath = (id: string) =>
    `${queueUrl}/${encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, id)}`

  test('非法 query / body 返回 422 而不是 500', async () => {
    const badQuery = await app.request(`${queueUrl}?limit=abc`, {
      headers: { cookie: adminCookie },
    })
    expect(badQuery.status).toBe(422)
    expect(((await badQuery.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    )

    const badBody = await app.request(`${recordPath(TEXT_RECORD_ID)}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ decision: 'ALLOW' }),
    })
    expect(badBody.status).toBe(422)
    const body = (await badBody.json()) as { error: { code: string; details?: unknown[] } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.length).toBeGreaterThan(0)
  })

  test('媒体快照：匿名 401、普通用户 403、未知记录 404', async () => {
    const url = `${queueUrl}/${encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, MEDIA_RECORD_ID)}/media`
    expect((await app.request(url)).status).toBe(401)
    expect((await app.request(url, { headers: { cookie: buyerCookie } })).status).toBe(403)
    const missing = await app.request(
      `${queueUrl}/${encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, '01930000-0000-7000-8000-0000000000ff')}/media`,
      { headers: { cookie: adminCookie } },
    )
    expect(missing.status).toBe(404)
  })
})
