import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { comments } from '@fish/db/schema/comments'
import { conversations } from '@fish/db/schema/conversations'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { messages } from '@fish/db/schema/messages'
import { reports } from '@fish/db/schema/reports'
import { transactionReviewImages, transactionReviews } from '@fish/db/schema/transaction-reviews'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
import { createSessions } from '../auth/session'

/**
 * 举报闭环端到端（#73）：用户提交 → 管理队列 → 处理 → 审计。
 *
 * 与 admin 测试同款自建 scratch 库：举报会插入行、处理会写审计，跑在开发库会污染他人。
 * 覆盖验收项：匿名 401、普通用户 403、目标不存在 404、重复举报不新增、
 * 两管理员并发只有一方成功、审计失败业务回滚。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_reports_test_${process.pid}`
const databaseUrlFor = (name: string) => {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}
const scratchUrl = databaseUrlFor(scratchDatabase)
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const admin = createDb(databaseUrl)
let scratch: Db
let app: ReturnType<typeof createApp>

const ADMIN_ID = '01930000-0000-7000-8000-000000000091'
const REPORTER_ID = '01930000-0000-7000-8000-000000000092'
const SECOND_REPORTER_ID = '01930000-0000-7000-8000-000000000093'
const TARGET_USER_ID = '01930000-0000-7000-8000-000000000094'
const LISTING_ID = '01930000-0000-7000-8000-0000000000a1'
const CONVERSATION_ID = '01930000-0000-7000-8000-0000000000c1'
const RECEIVED_MESSAGE_ID = '01930000-0000-7000-8000-0000000000d1'
const OWN_MESSAGE_ID = '01930000-0000-7000-8000-0000000000d2'
const PENDING_MESSAGE_ID = '01930000-0000-7000-8000-0000000000d3'
const PUBLIC_RECEIVED_MESSAGE_ID = encodePublicId(PUBLIC_ID_PREFIX.message, RECEIVED_MESSAGE_ID)
const PUBLIC_LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID)
const PUBLIC_TARGET_USER_ID = encodePublicId(PUBLIC_ID_PREFIX.user, TARGET_USER_ID)
const PUBLIC_REPORTER_ID = encodePublicId(PUBLIC_ID_PREFIX.user, REPORTER_ID)

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  await scratch.insert(users).values([
    {
      id: ADMIN_ID,
      nickname: '管理员甲',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      role: 'ADMIN',
    },
    {
      id: REPORTER_ID,
      nickname: '举报人乙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
    {
      id: SECOND_REPORTER_ID,
      nickname: '举报人丙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
    {
      id: TARGET_USER_ID,
      nickname: '被举报用户丁',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
  ])
  await scratch.insert(listings).values({
    id: LISTING_ID,
    listingNo: await reserveTestListingNo(scratch, LISTING_ID),
    sellerId: TARGET_USER_ID,
    title: '被举报商品',
    description: '用于举报闭环测试的商品',
    priceCents: 9900,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-02T02:00:00Z'),
  })
  await scratch.insert(conversations).values({
    id: CONVERSATION_ID,
    listingId: LISTING_ID,
    buyerId: REPORTER_ID,
    sellerId: TARGET_USER_ID,
    lastMessageAt: new Date('2026-09-02T03:00:00Z'),
    createdAt: new Date('2026-09-02T03:00:00Z'),
  })
  await scratch.insert(messages).values([
    {
      id: RECEIVED_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: TARGET_USER_ID,
      type: 'TEXT',
      content: '加我微信，私下转账',
      visibility: 'DELIVERED',
      createdAt: new Date('2026-09-02T03:00:00Z'),
    },
    {
      id: OWN_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: REPORTER_ID,
      type: 'TEXT',
      content: '我自己发的',
      visibility: 'DELIVERED',
      createdAt: new Date('2026-09-02T03:01:00Z'),
    },
    {
      id: PENDING_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: TARGET_USER_ID,
      type: 'TEXT',
      content: '待审内容',
      visibility: 'PENDING_REVIEW',
      createdAt: new Date('2026-09-02T03:02:00Z'),
    },
  ])
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

/** 带 session cookie 的 POST：`app.request(path, options)` 只接受一个 options，必须合并。 */
const postAs = (cookie: string, body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

/** 直写 sessions 表签发会话（#703：/auth/login 已下线）。 */
async function loginAs(userId: string): Promise<string> {
  const { token } = await createSessions(scratch).create(userId)
  return `fish_session=${token}`
}

let adminCookie: string
let reporterCookie: string
let secondReporterCookie: string

describe('举报闭环（#73 用户端）', () => {
  test('setup: login all accounts', async () => {
    adminCookie = await loginAs(ADMIN_ID)
    reporterCookie = await loginAs(REPORTER_ID)
    secondReporterCookie = await loginAs(SECOND_REPORTER_ID)
  })

  test('匿名不能举报，也不能看我的举报（401）', async () => {
    const create = await app.request(REPORT_ROUTES.create, post({}))
    expect(create.status).toBe(401)
    expect((await create.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    })
    const mine = await app.request(REPORT_ROUTES.mine)
    expect(mine.status).toBe(401)
  })

  test('举报不存在的目标是 404 REPORT_TARGET_NOT_FOUND（不是 500）', async () => {
    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'LISTING',
        targetId: encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000ff'),
        reason: 'FRAUD',
      }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_TARGET_NOT_FOUND' },
    })
  })

  test('举报自己是 422 REPORT_SELF_TARGET；原因与对象类型不匹配是 422 VALIDATION_FAILED', async () => {
    const self = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, { targetType: 'USER', targetId: PUBLIC_REPORTER_ID, reason: 'ABUSE' }),
    )
    expect(self.status).toBe(422)
    expect((await self.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_SELF_TARGET' },
    })

    // LISTING 只能用商品类原因：HARASSMENT 是用户类原因，契约层就该拒。
    const mismatch = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'LISTING',
        targetId: PUBLIC_LISTING_ID,
        reason: 'HARASSMENT',
      }),
    )
    expect(mismatch.status).toBe(422)
    const body = (await mismatch.json()) as {
      error: { code: string; details?: { field: string }[] }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.[0]?.field).toBe('reason')
  })

  test('举报目标错误前缀和旧裸 UUID 在入库前被拒绝', async () => {
    for (const targetId of [PUBLIC_TARGET_USER_ID, LISTING_ID]) {
      const res = await app.request(
        REPORT_ROUTES.create,
        postAs(reporterCookie, { targetType: 'LISTING', targetId, reason: 'FRAUD' }),
      )
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    }
  })

  test('提交举报返回受理结果；同一举报人重复提交不新增（200 + created:false）', async () => {
    const first = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'LISTING',
        targetId: PUBLIC_LISTING_ID,
        reason: 'MISLEADING',
        detailText: '标题与实物不符',
      }),
    )
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as {
      created: boolean
      report: { id: string; status: string; handlingReason?: unknown }
    }
    expect(firstBody.created).toBe(true)
    expect(firstBody.report.status).toBe('PENDING')
    expect(decodePublicId(PUBLIC_ID_PREFIX.report, firstBody.report.id)).toMatch(/^[0-9a-f-]{36}$/)
    // 用户端 DTO 不得泄漏处理原因（只对管理员可见）。
    expect(firstBody.report.handlingReason).toBeUndefined()

    const again = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'LISTING',
        targetId: PUBLIC_LISTING_ID,
        reason: 'SPAM',
      }),
    )
    expect(again.status).toBe(200)
    const againBody = (await again.json()) as { created: boolean; report: { id: string } }
    expect(againBody.created).toBe(false)
    expect(againBody.report.id).toBe(firstBody.report.id)

    const rows = await scratch.select().from(reports).where(eq(reports.targetId, LISTING_ID))
    expect(rows.length).toBe(1)
  })

  test('第二个举报人打同一目标各自成单（多举报人聚合，不是去重掉）', async () => {
    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(secondReporterCookie, {
        targetType: 'LISTING',
        targetId: PUBLIC_LISTING_ID,
        reason: 'FRAUD',
      }),
    )
    expect(res.status).toBe(201)
    expect((await res.json()) as { created: boolean }).toMatchObject({ created: true })
  })

  test('「我的举报」只返回自己的，且带处理时间', async () => {
    const res = await app.request(REPORT_ROUTES.mine, { headers: { cookie: reporterCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { id: string; reason: string; status: string }[]
      nextCursor: string | null
    }
    expect(body.items.length).toBe(1)
    expect(body.items[0]?.reason).toBe('MISLEADING')
    expect(body.items[0]?.id.startsWith('rpt_')).toBe(true)
    expect(body.nextCursor).toBeNull()

    const other = await app.request(REPORT_ROUTES.mine, {
      headers: { cookie: secondReporterCookie },
    })
    const otherBody = (await other.json()) as { items: { reason: string }[] }
    expect(otherBody.items.map((item) => item.reason)).toEqual(['FRAUD'])
  })
})

describe('私聊消息举报（#694 M2）', () => {
  test('接收方举报收到的消息：201，且服务端固化正文快照（不采信客户端）', async () => {
    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'MESSAGE',
        targetId: PUBLIC_RECEIVED_MESSAGE_ID,
        reason: 'HARASSMENT',
        detailText: '要求私下转账',
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { report: { targetType: string; targetId: string } }
    expect(body.report.targetType).toBe('MESSAGE')
    expect(body.report.targetId).toBe(PUBLIC_RECEIVED_MESSAGE_ID)
    const rows = await scratch
      .select()
      .from(reports)
      .where(eq(reports.targetId, RECEIVED_MESSAGE_ID))
    expect(rows.length).toBe(1)
    expect(rows[0]?.evidenceSnapshot).toMatchObject({
      kind: 'TEXT',
      content: '加我微信，私下转账',
      senderNickname: '被举报用户丁',
    })
  })

  test('发送方不能举报自己的消息（422）；非参与者猜 id 按不存在处理（404）', async () => {
    const self = await app.request(
      REPORT_ROUTES.create,
      postAs(adminCookie, {
        targetType: 'MESSAGE',
        targetId: encodePublicId(PUBLIC_ID_PREFIX.message, OWN_MESSAGE_ID),
        reason: 'SPAM',
      }),
    )
    // adminCookie 是管理员，与举报人无关；先验「恰好是自己发的」用 REPORTER 的 cookie。
    const own = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'MESSAGE',
        targetId: encodePublicId(PUBLIC_ID_PREFIX.message, OWN_MESSAGE_ID),
        reason: 'SPAM',
      }),
    )
    expect(own.status).toBe(422)
    expect((await own.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_SELF_TARGET' },
    })
    expect(self.status).toBe(404)

    const outsider = await app.request(
      REPORT_ROUTES.create,
      postAs(secondReporterCookie, {
        targetType: 'MESSAGE',
        targetId: PUBLIC_RECEIVED_MESSAGE_ID,
        reason: 'SPAM',
      }),
    )
    expect(outsider.status).toBe(404)
    expect((await outsider.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_TARGET_NOT_FOUND' },
    })
  })

  test('待审消息对接收者不可见，举报按不存在处理', async () => {
    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'MESSAGE',
        targetId: encodePublicId(PUBLIC_ID_PREFIX.message, PENDING_MESSAGE_ID),
        reason: 'SPAM',
      }),
    )
    expect(res.status).toBe(404)
  })

  test('管理端详情返回取证快照；消息撤回后快照仍在', async () => {
    await scratch
      .update(messages)
      .set({ recalledAt: new Date('2026-09-02T04:00:00Z') })
      .where(eq(messages.id, RECEIVED_MESSAGE_ID))

    const queue = await app.request(`${ADMIN_ROUTES.reports}?targetType=MESSAGE`, {
      headers: { cookie: adminCookie },
    })
    expect(queue.status).toBe(200)
    const queueBody = (await queue.json()) as {
      items: { report: { id: string; targetType: string }; target: { label: string } }[]
    }
    const item = queueBody.items.find((entry) => entry.report.targetType === 'MESSAGE')
    expect(item).toBeDefined()
    expect(item?.target.label).toContain('加我微信')

    const detail = await app.request(ADMIN_ROUTES.reportDetail(item?.report.id ?? ''), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as {
      item: {
        evidence: {
          targetType: string
          kind: string
          content: string | null
          hasMedia: boolean
          senderNickname: string
          recalledAt: string | null
        } | null
      }
    }
    expect(detailBody.item.evidence).toMatchObject({
      targetType: 'MESSAGE',
      kind: 'TEXT',
      content: '加我微信，私下转账',
      hasMedia: false,
      senderNickname: '被举报用户丁',
    })
    // 快照是举报创建时的取证：撤回发生在之后，只能说明「撤回不销毁证据」，
    // 不会把撤回时间补写进历史快照。
    expect(detailBody.item.evidence?.recalledAt).toBeNull()
  })

  test('证据媒体：匿名 401、普通用户 403、文本举报 404', async () => {
    const queue = await app.request(`${ADMIN_ROUTES.reports}?targetType=MESSAGE`, {
      headers: { cookie: adminCookie },
    })
    const body = (await queue.json()) as { items: { report: { id: string } }[] }
    const reportId = body.items[0]?.report.id
    expect(reportId).toBeDefined()
    const url = ADMIN_ROUTES.reportEvidenceMedia(reportId ?? '')

    expect((await app.request(url)).status).toBe(401)
    expect((await app.request(url, { headers: { cookie: reporterCookie } })).status).toBe(403)
    // 文本消息没有可读媒体快照：管理端也不能凭 reportId 读到别的东西。
    expect((await app.request(url, { headers: { cookie: adminCookie } })).status).toBe(404)
  })

  test('cleanup: 清掉消息举报，避免影响举报队列的跨目标计数用例', async () => {
    await scratch.delete(reports).where(eq(reports.targetType, 'MESSAGE'))
  })
})

describe('举报闭环（#73 Admin 端）', () => {
  test('普通用户碰举报队列与处理端点都是 403（守卫层拦，不靠参数校验）', async () => {
    const queue = await app.request(ADMIN_ROUTES.reports, {
      headers: { cookie: reporterCookie },
    })
    expect(queue.status).toBe(403)
    expect((await queue.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })

    const handle = await app.request(
      ADMIN_ROUTES.reportHandle('01930000-0000-7000-8000-0000000000ff'),
      {
        method: 'POST',
        headers: { cookie: reporterCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'HANDLED', reason: '恶意调用' }),
      },
    )
    expect(handle.status).toBe(403)
  })

  test('普通用户碰举报详情也是 403；错误前缀或裸 UUID 被挡在 DB 前', async () => {
    const detail = await app.request(
      ADMIN_ROUTES.reportDetail('01930000-0000-7000-8000-0000000000ff'),
      {
        headers: { cookie: reporterCookie },
      },
    )
    expect(detail.status).toBe(403)

    for (const path of [
      ADMIN_ROUTES.reportDetail('01930000-0000-7000-8000-0000000000ff'),
      ADMIN_ROUTES.reportHandle('not-a-typeid'),
      ADMIN_ROUTES.reportDetail(encodePublicId(PUBLIC_ID_PREFIX.user, REPORTER_ID)),
    ]) {
      const res = await app.request(path, {
        method: path.includes('handle') ? 'POST' : 'GET',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: path.includes('handle')
          ? JSON.stringify({ result: 'HANDLED', reason: '处理一条不存在的举报' })
          : undefined,
      })
      expect(res.status).toBe(404)
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'REPORT_NOT_FOUND' },
      })
    }
  })

  test('处理不存在的举报是 404 REPORT_NOT_FOUND（合法 rpt_ ID）', async () => {
    const res = await app.request(
      ADMIN_ROUTES.reportHandle(
        encodePublicId(PUBLIC_ID_PREFIX.report, '01930000-0000-7000-8000-0000000000ff'),
      ),
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'HANDLED', reason: '处理一条不存在的举报' }),
      },
    )
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_NOT_FOUND' },
    })
  })

  test('队列给出全量举报条数（多举报人聚合成 reportCount，不是当前页计数）', async () => {
    const res = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING`, {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: {
        report: { id: string; handlingReason: string | null; handledBy: { id: string } | null }
        reporter: { id: string; nickname: string }
        target: { label: string; listingStatus: string }
        reportCount: number
      }[]
      nextCursor: string | null
    }
    expect(body.items.length).toBe(2)
    for (const item of body.items) {
      expect(item.reportCount).toBe(2)
      expect(item.target.label).toBe('被举报商品')
      expect(item.target.listingStatus).toBe('ACTIVE')
      expect(item.report.handlingReason).toBeNull()
      expect(item.report.handledBy).toBeNull()
    }
    expect(new Set(body.items.map((item) => item.reporter.id))).toEqual(
      new Set([PUBLIC_REPORTER_ID, encodePublicId(PUBLIC_ID_PREFIX.user, SECOND_REPORTER_ID)]),
    )
    expect(new Set(body.items.map((item) => item.reporter.nickname))).toEqual(
      new Set(['举报人乙', '举报人丙']),
    )
    expect(body.nextCursor).toBeNull()
  })

  test('队列筛选：reason / targetType 收窄结果', async () => {
    const byReason = await app.request(`${ADMIN_ROUTES.reports}?reason=FRAUD`, {
      headers: { cookie: adminCookie },
    })
    const reasonBody = (await byReason.json()) as { items: { report: { reason: string } }[] }
    expect(reasonBody.items.map((item) => item.report.reason)).toEqual(['FRAUD'])

    const byTarget = await app.request(`${ADMIN_ROUTES.reports}?targetType=USER`, {
      headers: { cookie: adminCookie },
    })
    const targetBody = (await byTarget.json()) as { items: unknown[] }
    expect(targetBody.items).toEqual([])
  })

  test('详情给出同目标其它未决举报（related），便于一次看完多个人打同一目标', async () => {
    const queue = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING`, {
      headers: { cookie: adminCookie },
    })
    const { items } = (await queue.json()) as { items: { report: { id: string } }[] }
    const firstId = items[0]?.report.id
    expect(firstId).toBeDefined()
    if (!firstId) return

    const detail = await app.request(ADMIN_ROUTES.reportDetail(firstId), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as {
      item: { report: { id: string } }
      related: { id: string }[]
    }
    expect(body.item.report.id).toBe(firstId)
    const targetId = (body.item as { target?: { targetId: string } }).target?.targetId ?? ''
    expect(targetId).toBe(PUBLIC_LISTING_ID)
    expect(
      (
        await app.request(ADMIN_ROUTES.listingDetail(targetId), {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(200)
    expect(body.related.length).toBe(1)
    expect(body.related[0]?.id).not.toBe(firstId)
  })

  test('处理举报写状态 + 处理人 + 审计（同一请求路径）', async () => {
    const queue = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING&reason=MISLEADING`, {
      headers: { cookie: adminCookie },
    })
    const { items } = (await queue.json()) as { items: { report: { id: string } }[] }
    const reportId = items[0]?.report.id ?? ''

    const res = await app.request(ADMIN_ROUTES.reportHandle(reportId), {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'HANDLED', reason: '已核实，另行下架处理' }),
    })
    expect(res.status).toBe(204)

    const internalId = decodePublicId(PUBLIC_ID_PREFIX.report, reportId)
    const [row] = await scratch.select().from(reports).where(eq(reports.id, internalId))
    expect(row).toMatchObject({ status: 'HANDLED', handledBy: ADMIN_ID })
    expect(row?.handledAt).toBeInstanceOf(Date)
    expect(row?.handlingReason).toBe('已核实，另行下架处理')

    const detail = await app.request(ADMIN_ROUTES.reportDetail(reportId), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const handled = (await detail.json()) as { item: { report: { handledBy: { id: string } } } }
    expect(handled.item.report.handledBy.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_ID))

    const audit = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, internalId))
    expect(audit.length).toBe(1)
    expect(audit[0]).toMatchObject({
      action: 'REPORT_DECISION',
      targetType: 'REPORT',
      actorUserId: ADMIN_ID,
    })
  })

  test('重复处理得到确定结果：409 REPORT_CONFLICT', async () => {
    const queue = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING&reason=FRAUD`, {
      headers: { cookie: adminCookie },
    })
    const { items } = (await queue.json()) as { items: { report: { id: string } }[] }
    const reportId = items[0]?.report.id ?? ''

    const first = await app.request(ADMIN_ROUTES.reportHandle(reportId), {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'REJECTED', reason: '证据不足' }),
    })
    expect(first.status).toBe(204)

    const second = await app.request(ADMIN_ROUTES.reportHandle(reportId), {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'REJECTED', reason: '再处理一次' }),
    })
    expect(second.status).toBe(409)
    expect((await second.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_CONFLICT' },
    })
  })

  test('两个管理员同时处理：恰好一个 204，另一个 409（条件更新，不双写审计）', async () => {
    // 造一条新的未决举报给这个用例（上面的用例已经把前两条处理掉了）。
    const created = await app.request(
      REPORT_ROUTES.create,
      postAs(secondReporterCookie, {
        targetType: 'USER',
        targetId: PUBLIC_TARGET_USER_ID,
        reason: 'IMPERSONATION',
      }),
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { report: { targetId: string } }
    expect(createdBody.report.targetId).toBe(PUBLIC_TARGET_USER_ID)
    expect(
      (
        await app.request(ADMIN_ROUTES.userDetail(createdBody.report.targetId), {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(200)
    const queue = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING`, {
      headers: { cookie: adminCookie },
    })
    const { items } = (await queue.json()) as { items: { report: { id: string } }[] }
    const reportId = items.find((item) => item.report.id)?.report.id ?? ''

    const results = await Promise.all([
      app.request(ADMIN_ROUTES.reportHandle(reportId), {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'HANDLED', reason: '管理员甲的处理' }),
      }),
      app.request(ADMIN_ROUTES.reportHandle(reportId), {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'REJECTED', reason: '管理员甲的第二次处理' }),
      }),
    ])
    const statuses = results.map((res) => res.status).sort()
    expect(statuses).toEqual([204, 409])
    const internalId = decodePublicId(PUBLIC_ID_PREFIX.report, reportId)

    const audit = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, internalId))
    expect(audit.length).toBe(1)
  })

  test('审计写入失败时业务状态回滚（同一事务）：举报仍 PENDING，且无审计行', async () => {
    await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'USER',
        targetId: PUBLIC_TARGET_USER_ID,
        reason: 'ABUSE',
      }),
    )
    const queue = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING&reason=ABUSE`, {
      headers: { cookie: adminCookie },
    })
    const { items } = (await queue.json()) as { items: { report: { id: string } }[] }
    const reportId = items[0]?.report.id ?? ''

    await scratch.$client.unsafe(`
      CREATE OR REPLACE FUNCTION fish_test_fail_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.reason LIKE 'AUDIT_FAIL_INJECT%' THEN
          RAISE EXCEPTION 'injected audit failure for report rollback test';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `)
    await scratch.$client.unsafe(`
      CREATE TRIGGER fish_test_fail_audit_trigger
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION fish_test_fail_audit()
    `)

    try {
      const res = await app.request(ADMIN_ROUTES.reportHandle(reportId), {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'HANDLED', reason: 'AUDIT_FAIL_INJECT 审计写入失败' }),
      })
      expect(res.status).toBe(500)
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'INTERNAL_ERROR' },
      })
    } finally {
      await scratch.$client.unsafe(
        'DROP TRIGGER IF EXISTS fish_test_fail_audit_trigger ON admin_audit_logs',
      )
      await scratch.$client.unsafe('DROP FUNCTION IF EXISTS fish_test_fail_audit()')
    }

    const internalId = decodePublicId(PUBLIC_ID_PREFIX.report, reportId)
    const [row] = await scratch.select().from(reports).where(eq(reports.id, internalId))
    expect(row).toMatchObject({ status: 'PENDING', handledBy: null })
    expect(row?.handlingReason).toBeNull()
    const audit = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, internalId))
    expect(audit.length).toBe(0)
  })

  test('处理完的举报离开未决队列，但按状态可检索（历史可查）', async () => {
    const handled = await app.request(`${ADMIN_ROUTES.reports}?status=HANDLED`, {
      headers: { cookie: adminCookie },
    })
    const body = (await handled.json()) as { items: { report: { status: string } }[] }
    expect(body.items.length).toBeGreaterThan(0)
    for (const item of body.items) expect(item.report.status).toBe('HANDLED')

    const pending = await app.request(`${ADMIN_ROUTES.reports}?status=PENDING`, {
      headers: { cookie: adminCookie },
    })
    const pendingBody = (await pending.json()) as { items: { report: { status: string } }[] }
    for (const item of pendingBody.items) expect(item.report.status).toBe('PENDING')
  })

  test('审计日志里能看到举报处理（管理员操作可追溯）', async () => {
    const res = await app.request(`${ADMIN_ROUTES.auditLogs}?action=REPORT_DECISION`, {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { action: string; targetType: string }[] }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0]).toMatchObject({ action: 'REPORT_DECISION', targetType: 'REPORT' })
  })

  test('队列的同目标举报总数不受状态、原因和游标筛选影响', async () => {
    const ids = [newId(), newId(), newId()]
    const createdAt = new Date('2026-09-25T00:00:00Z')
    await scratch.insert(reports).values([
      {
        id: ids[0],
        reporterId: REPORTER_ID,
        targetType: 'USER',
        targetId: ADMIN_ID,
        reason: 'FRAUD',
        status: 'PENDING',
        createdAt,
      },
      {
        id: ids[1],
        reporterId: SECOND_REPORTER_ID,
        targetType: 'USER',
        targetId: ADMIN_ID,
        reason: 'FRAUD',
        status: 'PENDING',
        createdAt: new Date(createdAt.getTime() - 1_000),
      },
      {
        id: ids[2],
        reporterId: REPORTER_ID,
        targetType: 'USER',
        targetId: ADMIN_ID,
        reason: 'ABUSE',
        status: 'HANDLED',
        handledAt: createdAt,
        handledBy: ADMIN_ID,
        handlingReason: '已处理',
        createdAt: new Date(createdAt.getTime() - 2_000),
      },
    ])
    try {
      const query = `${ADMIN_ROUTES.reports}?status=PENDING&reason=FRAUD&targetType=USER&limit=1`
      const first = await app.request(query, { headers: { cookie: adminCookie } })
      expect(first.status).toBe(200)
      const firstPage = (await first.json()) as {
        items: { reportCount: number }[]
        nextCursor: string | null
      }
      expect(firstPage.items.map((item) => item.reportCount)).toEqual([3])
      expect(firstPage.nextCursor).not.toBeNull()
      const decoded = Buffer.from(firstPage.nextCursor ?? '', 'base64url').toString('utf8')
      expect(decoded.split('|')[1]?.startsWith('rpt_')).toBe(true)
      const oldCursor = Buffer.from(`${decoded.split('|')[0]}|${ids[0]}`).toString('base64url')
      const rejected = await app.request(`${query}&cursor=${oldCursor}`, {
        headers: { cookie: adminCookie },
      })
      expect(rejected.status).toBe(422)
      const second = await app.request(
        `${query}&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
        { headers: { cookie: adminCookie } },
      )
      expect(second.status).toBe(200)
      const secondPage = (await second.json()) as {
        items: { reportCount: number }[]
        nextCursor: string | null
      }
      expect(secondPage.items.map((item) => item.reportCount)).toEqual([3])
      expect(secondPage.nextCursor).toBeNull()
    } finally {
      await scratch.delete(reports).where(inArray(reports.id, ids))
    }
  })
})

/**
 * #694 M7：举报目标扩展到 COMMENT / REVIEW / WISH。
 *
 * 放在文件末尾：前面的队列用例断言 PENDING 队列的精确条数与目标类型，新目标产生的
 * 举报行不能混进那些断言；本组用例在 scratch 库里自建目标、不清理（库在 afterAll 整体丢弃）。
 */
describe('举报目标扩展（#694 M7）', () => {
  test('COMMENT：201 + 取证快照落库；目标被删除后管理端详情仍有证据', async () => {
    const commentId = newId()
    await scratch.insert(comments).values({
      id: commentId,
      listingId: LISTING_ID,
      authorId: TARGET_USER_ID,
      parentId: null,
      content: '评论区拉人私下交易',
    })

    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'COMMENT',
        targetId: encodePublicId(PUBLIC_ID_PREFIX.comment, commentId),
        reason: 'SPAM',
      }),
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as {
      created: boolean
      report: { id: string; targetType: string; targetId: string }
    }
    expect(created.created).toBe(true)
    expect(created.report.targetType).toBe('COMMENT')
    expect(created.report.targetId).toBe(encodePublicId(PUBLIC_ID_PREFIX.comment, commentId))

    const detail = await app.request(ADMIN_ROUTES.reportDetail(created.report.id), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as {
      item: {
        evidence: { targetType: string; content: string; author: { id: string } } | null
        target: { targetType: string; targetId: string; label: string }
      }
    }
    expect(detailBody.item.target.targetType).toBe('COMMENT')
    expect(detailBody.item.target.targetId).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.comment, commentId),
    )
    expect(detailBody.item.evidence).toMatchObject({
      targetType: 'COMMENT',
      content: '评论区拉人私下交易',
      author: { id: encodePublicId(PUBLIC_ID_PREFIX.user, TARGET_USER_ID) },
    })

    // 留言被物理删除：多态举报行保留，管理端靠快照继续展示并标记目标已删除。
    await scratch.delete(comments).where(eq(comments.id, commentId))
    const afterDelete = await app.request(ADMIN_ROUTES.reportDetail(created.report.id), {
      headers: { cookie: adminCookie },
    })
    expect(afterDelete.status).toBe(200)
    const afterBody = (await afterDelete.json()) as {
      item: { evidence: { targetType: string; content: string } | null; target: { label: string } }
    }
    expect(afterBody.item.target.label).toBe('目标已删除')
    expect(afterBody.item.evidence).toMatchObject({
      targetType: 'COMMENT',
      content: '评论区拉人私下交易',
    })
  })

  test('REVIEW：交易参与者 201 + 快照，非参与者 404；证据媒体按 index 取图', async () => {
    const transactionId = newId()
    await scratch.insert(transactions).values({
      id: transactionId,
      listingId: LISTING_ID,
      buyerId: REPORTER_ID,
      sellerId: TARGET_USER_ID,
      amountCents: 9900,
      status: 'COMPLETED',
      completedAt: new Date('2026-09-03T02:00:00Z'),
    })
    const reviewId = newId()
    await scratch.insert(transactionReviews).values({
      id: reviewId,
      transactionId,
      authorId: TARGET_USER_ID,
      rating: 'NEGATIVE',
      body: '买家很麻烦',
    })
    await scratch.insert(transactionReviewImages).values({
      reviewId,
      objectKey: 'reviews/m7-evidence.jpg',
      sortOrder: 0,
    })

    const publicReviewId = encodePublicId(PUBLIC_ID_PREFIX.review, reviewId)
    // 丙与这笔交易无关：与「评价不存在」同一出口，不暴露评价归属。
    const outsider = await app.request(
      REPORT_ROUTES.create,
      postAs(secondReporterCookie, {
        targetType: 'REVIEW',
        targetId: publicReviewId,
        reason: 'HARASSMENT',
      }),
    )
    expect(outsider.status).toBe(404)

    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'REVIEW',
        targetId: publicReviewId,
        reason: 'HARASSMENT',
      }),
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as { report: { id: string } }

    const detail = await app.request(ADMIN_ROUTES.reportDetail(created.report.id), {
      headers: { cookie: adminCookie },
    })
    const detailBody = (await detail.json()) as {
      item: { evidence: { targetType: string; rating: string; imageCount: number } | null }
    }
    expect(detailBody.item.evidence).toMatchObject({
      targetType: 'REVIEW',
      rating: 'NEGATIVE',
      imageCount: 1,
    })

    const media = await app.request(
      `${ADMIN_ROUTES.reportEvidenceMedia(created.report.id)}?index=0`,
      { headers: { cookie: adminCookie } },
    )
    expect(media.status).toBe(200)
    expect(media.headers.get('cache-control')).toBe('private, no-store')
  })

  test('WISH：与愿望匹配的商品卖家 201；许愿人自己 422', async () => {
    const wishId = newId()
    await scratch.insert(wishes).values({
      id: wishId,
      userId: SECOND_REPORTER_ID,
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMaxCents: 20000,
      description: '求成色好的',
    })
    await scratch.insert(matches).values({
      listingId: LISTING_ID,
      wishId,
      score: 88,
      categoryScore: 100,
      keywordScore: 80,
      priceScore: 90,
    })

    const publicWishId = encodePublicId(PUBLIC_ID_PREFIX.wish, wishId)
    const self = await app.request(
      REPORT_ROUTES.create,
      postAs(secondReporterCookie, { targetType: 'WISH', targetId: publicWishId, reason: 'OTHER' }),
    )
    expect(self.status).toBe(422)

    // 乙没有商品，不存在与该愿望的匹配：同样按不存在处理。
    const noMatch = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, { targetType: 'WISH', targetId: publicWishId, reason: 'OTHER' }),
    )
    expect(noMatch.status).toBe(404)

    // 丁是匹配商品（LISTING_ID）的卖家，也是许愿人以外的人 —— 唯一有资格举报的人。
    const sellerCookie = await loginAs(TARGET_USER_ID)
    const res = await app.request(
      REPORT_ROUTES.create,
      postAs(sellerCookie, { targetType: 'WISH', targetId: publicWishId, reason: 'OTHER' }),
    )
    expect(res.status).toBe(201)
  })
})
