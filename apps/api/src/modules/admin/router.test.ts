import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import {
  AdminAuditLogPageSchema,
  AdminListingDetailSchema,
  AdminListingSummaryPageSchema,
  AdminMeResponseSchema,
  AdminModerationDetailSchema,
  AdminModerationQueueSchema,
  AdminModerationRecordsSchema,
  AdminOverviewSchema,
  AdminTransactionPageSchema,
  AdminUserDetailSchema,
  AdminUserSummaryPageSchema,
} from '@fish/contracts/admin/schema'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import { createDb, type Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { desc, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

/** Admin 测试要造「管理员 / 普通用户 / 审计记录」，跑在开发库会互相污染，自建 scratch 库。 */
const scratchDatabase = `fish_admin_test_${process.pid}`
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

const DEMO_PASSWORD = 'fish123456'

// 固定 UUID：admin 测试的两个演示账号（由 auth /register 创建时用 newId…… 这里改为
// 手动 INSERT，便于拿到稳定 id 建商品与审计）。
const ADMIN_TARGET_ID = '01930000-0000-7000-8000-000000000091'
const USER_ID = '01930000-0000-7000-8000-000000000092'
const LISTING_ID = '01930000-0000-7000-8000-0000000000a1'
const REVIEW_LISTING_ID = '01930000-0000-7000-8000-0000000000a2'
const REVIEW_RECORD_ID = '01930000-0000-7000-8000-0000000000b2'
const BLOCKED_EDIT_RECORD_ID = '01930000-0000-7000-8000-0000000000b3'
const OFFLINE_REVIEW_LISTING_ID = '01930000-0000-7000-8000-0000000000a3'
const REPEATED_REVIEW_LISTING_ID = '01930000-0000-7000-8000-0000000000a4'
const CREATE_REVIEW_CHAIN_LISTING_ID = '01930000-0000-7000-8000-0000000000a5'
const CREATE_REVIEW_CHAIN_RECORD_ID = '01930000-0000-7000-8000-0000000000b4'
const AUDIT_ROLLBACK_LISTING_ID = '01930000-0000-7000-8000-0000000000a6'
const AUDIT_ROLLBACK_RECORD_ID = '01930000-0000-7000-8000-0000000000b5'

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  // 用户经真实注册口创建（保证 session / cookie 链路是"真"的），随后手动提升为 ADMIN。
  const passwordHash = await Bun.password.hash(DEMO_PASSWORD)
  await scratch.insert(users).values([
    {
      id: ADMIN_TARGET_ID,
      studentNo: '202101000901',
      passwordHash,
      nickname: '管理员甲',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      role: 'ADMIN',
    },
    {
      id: USER_ID,
      studentNo: '202101000902',
      passwordHash,
      nickname: '普通用户乙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
  ])
  await scratch.insert(adminAuditLogs).values({
    id: '01930000-0000-7000-8000-0000000000b1',
    actorUserId: ADMIN_TARGET_ID,
    action: 'ADMIN_PROMOTED',
    targetType: 'USER',
    targetId: ADMIN_TARGET_ID,
    // jsonb 写入必须经 jsonParam()（见 @fish/db/json）：裸对象会被 bun-sql 双重 stringify。
    before: jsonParam({ role: 'USER' }),
    after: jsonParam({ role: 'ADMIN' }),
    reason: '管理后台初始化',
    requestId: 'req-init-1',
    createdAt: new Date('2026-09-01T01:00:00Z'),
  })
  await scratch.insert(listings).values([
    {
      id: LISTING_ID,
      sellerId: USER_ID,
      title: '管理后台可见商品',
      description: '用于管理员查询的测试商品',
      priceCents: 15900,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'ACTIVE',
      createdAt: new Date('2026-09-02T02:00:00Z'),
    },
    {
      id: REVIEW_LISTING_ID,
      sellerId: USER_ID,
      title: '待人工审核商品',
      description: '含有需要人工复核的描述',
      priceCents: 1200,
      category: 'BOOKS',
      condition: 'GOOD',
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
      moderationReason: '命中规则',
      moderationRuleVersion: 'test-v1',
      createdAt: new Date('2026-09-01T02:00:00Z'),
    },
  ])
  await scratch.insert(listingModerationRecords).values({
    id: REVIEW_RECORD_ID,
    listingId: REVIEW_LISTING_ID,
    sellerId: USER_ID,
    action: 'CREATE',
    titleSnapshot: '待人工审核商品',
    descriptionSnapshot: '含有需要人工复核的描述',
    decision: 'REVIEW',
    matchedRules: jsonParam(['TEST_RULE']),
    matchedTermsMasked: jsonParam(['测**']),
    ruleVersion: 'test-v1',
    createdAt: new Date('2026-09-03T02:01:00Z'),
  })
  await scratch.insert(listingModerationRecords).values({
    id: BLOCKED_EDIT_RECORD_ID,
    listingId: REVIEW_LISTING_ID,
    sellerId: USER_ID,
    action: 'UPDATE',
    titleSnapshot: '被拦截的新编辑',
    descriptionSnapshot: '这次编辑被自动规则拦截',
    decision: 'BLOCK',
    matchedRules: jsonParam(['BLOCK_RULE']),
    matchedTermsMasked: jsonParam(['拦**']),
    ruleVersion: 'test-v1',
    createdAt: new Date('2026-09-03T02:02:00Z'),
  })
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
let userCookie: string

describe('Admin HTTP 权限边界（设计 §3.2）', () => {
  test('setup: login both accounts', async () => {
    adminCookie = await loginAs('202101000901')
    userCookie = await loginAs('202101000902')
    expect(adminCookie.length).toBeGreaterThan(0)
    expect(userCookie.length).toBeGreaterThan(0)
  })

  test('unauthenticated access is 401 UNAUTHENTICATED', async () => {
    const res = await app.request(ADMIN_ROUTES.me)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  test('a regular user gets stable 403 FORBIDDEN on every /admin/* endpoint', async () => {
    for (const path of [
      ADMIN_ROUTES.me,
      ADMIN_ROUTES.users,
      ADMIN_ROUTES.overview,
      ADMIN_ROUTES.auditLogs,
      ADMIN_ROUTES.moderationQueue,
      ADMIN_ROUTES.transactions,
      ADMIN_ROUTES.moderationDetail(REVIEW_RECORD_ID),
      ADMIN_ROUTES.userDetail(userCookie ? USER_ID : ''),
    ]) {
      if (!path) continue
      const res = await app.request(path, { headers: { cookie: userCookie } })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('FORBIDDEN')
    }
  })

  test('a regular user is refused on the admin WRITE endpoint even with a well-formed request', async () => {
    // 上面的循环只覆盖 GET。写端点（POST 决定）必须在守卫层就挡掉：
    // 普通用户改前端状态调用它，就等于替管理员做审核决定。
    // 请求体与 Idempotency-Key 都合法，证明拦住它的是守卫而非参数校验。
    const res = await app.request(ADMIN_ROUTES.moderationDecision(REVIEW_RECORD_ID), {
      method: 'POST',
      headers: {
        cookie: userCookie,
        'content-type': 'application/json',
        'Idempotency-Key': 'regular-user-write-attempt',
      },
      body: JSON.stringify({ decision: 'BLOCK', reason: '普通用户试图代替管理员' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
    // 守卫先于 handler：没有任何审计落库，业务状态也不被改写。
    const audits = await scratch
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.requestId, 'regular-user-write-attempt'))
    expect(audits).toHaveLength(0)
  })

  test('forged role / identity headers never grant admin access', async () => {
    // 身份只来自 session cookie（createRequireAuth 读 cookie → loadMe 查库，
    // session.ts 的 read 只 getCookie，仓库里没有任何 Authorization 之类的头通道），
    // 任何自称角色的头都不得被采信。下面这份清单是常见的伪造头抽样而非枚举证明，
    // 真正的结构性保证是「除了 fish_session cookie 没有第二条身份入口」。
    const forgedHeaders: Record<string, string>[] = [
      { 'x-user-role': 'ADMIN' },
      { 'x-role': 'ADMIN' },
      { 'x-fish-role': 'ADMIN' },
      { role: 'ADMIN' },
      { 'x-admin': 'true' },
      { 'x-is-admin': '1' },
      { 'x-user-id': ADMIN_TARGET_ID },
      { 'x-actor-user-id': ADMIN_TARGET_ID },
      { 'x-user-role': 'ADMIN', 'x-user-id': ADMIN_TARGET_ID, 'x-admin': 'true' },
    ]
    for (const headers of forgedHeaders) {
      // 无 session：伪造头不能替代登录。
      const anonymous = await app.request(ADMIN_ROUTES.me, { headers })
      expect(anonymous.status).toBe(401)
      expect((await anonymous.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'UNAUTHENTICATED' },
      })
      // 普通用户 session + 伪造头：仍然是 403，不会升权。
      const asUser = await app.request(ADMIN_ROUTES.me, {
        headers: { ...headers, cookie: userCookie },
      })
      expect(asUser.status).toBe(403)
      expect((await asUser.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'FORBIDDEN' },
      })
    }
    // 反向对照：不带伪造头的管理员 session 仍然畅通，证明上面的 403 不是链路坏了。
    const asAdmin = await app.request(ADMIN_ROUTES.me, { headers: { cookie: adminCookie } })
    expect(asAdmin.status).toBe(200)
  })

  test('an admin can reach /admin/me and sees role + capabilities', async () => {
    const res = await app.request(ADMIN_ROUTES.me, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = AdminMeResponseSchema.parse(await res.json())
    expect(body.admin.role).toBe('ADMIN')
    expect(body.admin.nickname).toBe('管理员甲')
    expect(body.capabilities).toContain('USERS_READ')
  })
})

describe('Admin 查询端到端', () => {
  test('GET /admin/users returns masked student no and listing count', async () => {
    const res = await app.request(ADMIN_ROUTES.users, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = AdminUserSummaryPageSchema.parse(await res.json())
    expect(body.items).toHaveLength(2)
    const byId = new Map(body.items.map((item) => [item.id, item]))
    expect(byId.get(USER_ID)?.studentNoMasked).toBe('2021****0902')
    expect(byId.get(USER_ID)?.listingCount).toBe(2)
  })

  test('GET /admin/users：微信用户（student_no 为 NULL）的 studentNoMasked 是 null，不是 "n**l"', async () => {
    // #86 A 的微信注册路径：users 行 student_no/password_hash 都是 NULL。
    // 用独立的 q 前缀搜索隔离这条数据，测完即删，不影响其他用例的计数断言。
    await scratch.insert(users).values({
      id: '01930000-0000-7000-8000-0000000000c1',
      studentNo: null,
      passwordHash: null,
      nickname: '微信用户丙',
      createdAt: new Date('2026-09-03T00:00:00Z'),
      role: 'USER',
    })
    const res = await app.request(`${ADMIN_ROUTES.users}?q=微信用户丙`, {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = AdminUserSummaryPageSchema.parse(await res.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.nickname).toBe('微信用户丙')
    expect(body.items[0]?.studentNoMasked).toBeNull()
    await scratch.delete(users).where(eq(users.id, '01930000-0000-7000-8000-0000000000c1'))
  })

  test('GET /admin/users supports q (exact student no, nickname prefix) and role filter', async () => {
    const byNo = await app.request(`${ADMIN_ROUTES.users}?q=202101000902`, {
      headers: { cookie: adminCookie },
    })
    expect(AdminUserSummaryPageSchema.parse(await byNo.json()).items[0]?.id).toBe(USER_ID)

    const byName = await app.request(`${ADMIN_ROUTES.users}?q=管理员`, {
      headers: { cookie: adminCookie },
    })
    expect(AdminUserSummaryPageSchema.parse(await byName.json()).items[0]?.id).toBe(ADMIN_TARGET_ID)

    const byRole = await app.request(`${ADMIN_ROUTES.users}?role=ADMIN`, {
      headers: { cookie: adminCookie },
    })
    expect(AdminUserSummaryPageSchema.parse(await byRole.json()).items).toHaveLength(1)
  })

  test('GET /admin/users/limiting to 1 then following cursor pages without dupes', async () => {
    const page1 = await app.request(`${ADMIN_ROUTES.users}?limit=1`, {
      headers: { cookie: adminCookie },
    })
    const body1 = AdminUserSummaryPageSchema.parse(await page1.json())
    expect(body1.items).toHaveLength(1)
    const nextCursor = body1.nextCursor
    expect(nextCursor).not.toBeNull()

    const page2 = await app.request(
      `${ADMIN_ROUTES.users}?limit=1&cursor=${encodeURIComponent(nextCursor ?? '')}`,
      { headers: { cookie: adminCookie } },
    )
    const body2 = AdminUserSummaryPageSchema.parse(await page2.json())
    expect(body2.items).toHaveLength(1)
    // 两页 id 不重复（游标不重不漏）；第 3 页应翻完（q 过滤掉微信用户丙 → 共 2 行）
    expect(body2.items[0]?.id).not.toBe(body1.items[0]?.id)
    expect(body2.nextCursor).toBeNull()
  })

  test('GET /admin/users/:userId returns detail with listing stats and recent audit', async () => {
    const res = await app.request(ADMIN_ROUTES.userDetail(USER_ID), {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = AdminUserDetailSchema.parse(await res.json())
    expect(body.user.id).toBe(USER_ID)
    expect(body.listingStats.ACTIVE).toBe(1)
  })

  test('GET /admin/listings returns seller summary; status filter works', async () => {
    const res = await app.request(ADMIN_ROUTES.listings, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = AdminListingSummaryPageSchema.parse(await res.json())
    expect(body.items[0]?.title).toBe('管理后台可见商品')
    expect(body.items[0]?.seller.nickname).toBe('普通用户乙')

    const filtered = await app.request(`${ADMIN_ROUTES.listings}?status=SOLD`, {
      headers: { cookie: adminCookie },
    })
    expect(AdminListingSummaryPageSchema.parse(await filtered.json()).items).toHaveLength(0)
  })

  test('GET /admin/listings/:listingId returns detail with images and audit logs', async () => {
    const res = await app.request(ADMIN_ROUTES.listingDetail(LISTING_ID), {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = AdminListingDetailSchema.parse(await res.json())
    expect(body.title).toBe('管理后台可见商品')
    expect(body.seller.id).toBe(USER_ID)
    // 该 LISTING 没有任何审计记录
    expect(body.recentAuditLogs).toEqual([])
  })

  test('GET moderation queue and transactions are queryable by admin', async () => {
    const moderation = await app.request(ADMIN_ROUTES.moderationQueue, {
      headers: { cookie: adminCookie },
    })
    expect(moderation.status).toBe(200)
    const moderationBody = AdminModerationQueueSchema.parse(await moderation.json())
    expect(moderationBody.items).toHaveLength(1)
    expect(moderationBody.items[0]?.record.id).toBe(REVIEW_RECORD_ID)
    expect(moderationBody.items[0]?.record.titleSnapshot).toBe('待人工审核商品')

    const transaction = await app.request(ADMIN_ROUTES.transactions, {
      headers: { cookie: adminCookie },
    })
    expect(transaction.status).toBe(200)
    expect(AdminTransactionPageSchema.parse(await transaction.json()).items).toEqual([])
  })

  test('moderation decisions require an idempotency key', async () => {
    const res = await app.request(
      ADMIN_ROUTES.moderationDecision('01930000-0000-7000-8000-0000000000a1'),
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(res.status).toBe(422)
  })

  test('GET /admin/overview returns fixed metrics', async () => {
    const res = await app.request(ADMIN_ROUTES.overview, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = AdminOverviewSchema.parse(await res.json())
    expect(body.totalUsers).toBe(2)
    expect(body.activeListings).toBe(1)
  })

  test('GET /admin/audit-logs lists ADMIN_PROMOTED entries with actor and snapshots', async () => {
    const res = await app.request(ADMIN_ROUTES.auditLogs, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = AdminAuditLogPageSchema.parse(await res.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.action).toBe('ADMIN_PROMOTED')
    expect(body.items[0]?.actor?.nickname).toBe('管理员甲')
    expect(body.items[0]?.before).toEqual({ role: 'USER' })
    expect(body.items[0]?.after).toEqual({ role: 'ADMIN' })
    // 审计日志可筛选：按 actor 与动作
    const filtered = await app.request(
      `${ADMIN_ROUTES.auditLogs}?actorId=${ADMIN_TARGET_ID}&action=ADMIN_PROMOTED`,
      { headers: { cookie: adminCookie } },
    )
    expect(AdminAuditLogPageSchema.parse(await filtered.json()).items).toHaveLength(1)
  })

  test('moderation detail and decision update the listing and audit atomically', async () => {
    const detail = await app.request(ADMIN_ROUTES.moderationDetail(REVIEW_RECORD_ID), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const detailBody = AdminModerationDetailSchema.parse(await detail.json())
    expect(detailBody.machineDecision).toBe('REVIEW')
    expect(detailBody.humanDecision).toBeNull()

    const decided = await app.request(ADMIN_ROUTES.moderationDecision(REVIEW_RECORD_ID), {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'Idempotency-Key': 'moderation-test-1',
      },
      body: JSON.stringify({ decision: 'ALLOW', reason: '人工复核通过' }),
    })
    expect(decided.status).toBe(200)
    const decidedBody = AdminModerationDetailSchema.parse(await decided.json())
    expect(decidedBody.humanDecision?.decision).toBe('ALLOW')
    expect(decidedBody.item.listing.moderationStatus).toBe('APPROVED')

    const repeated = await app.request(ADMIN_ROUTES.moderationDecision(REVIEW_RECORD_ID), {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'Idempotency-Key': 'moderation-test-1',
      },
      body: JSON.stringify({ decision: 'ALLOW', reason: '人工复核通过' }),
    })
    expect(repeated.status).toBe(200)

    const sameDecisionDifferentReason = await app.request(
      ADMIN_ROUTES.moderationDecision(REVIEW_RECORD_ID),
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'Idempotency-Key': 'moderation-test-1',
        },
        body: JSON.stringify({ decision: 'ALLOW', reason: '不同原因' }),
      },
    )
    expect(sameDecisionDifferentReason.status).toBe(409)

    const conflictingKey = await app.request(ADMIN_ROUTES.moderationDecision(REVIEW_RECORD_ID), {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'Idempotency-Key': 'moderation-test-1',
      },
      body: JSON.stringify({ decision: 'BLOCK', reason: '改用拦截' }),
    })
    expect(conflictingKey.status).toBe(409)
  })

  test('ALLOW restores an offline listing after an UPDATE review', async () => {
    await scratch.insert(listings).values({
      id: OFFLINE_REVIEW_LISTING_ID,
      sellerId: USER_ID,
      title: '主动下架商品',
      description: '原始描述',
      priceCents: 2500,
      category: 'BOOKS',
      condition: 'GOOD',
      status: 'OFFLINE',
      moderationStatus: 'APPROVED',
      createdAt: new Date('2026-09-04T02:00:00Z'),
    })

    const edited = await app.request(LISTING_ROUTES.detail(OFFLINE_REVIEW_LISTING_ID), {
      method: 'PATCH',
      headers: { cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '加微信联系' }),
    })
    expect(edited.status).toBe(200)

    const reviewRows = await scratch
      .select({ id: listingModerationRecords.id })
      .from(listingModerationRecords)
      .where(eq(listingModerationRecords.listingId, OFFLINE_REVIEW_LISTING_ID))
      .orderBy(desc(listingModerationRecords.createdAt), desc(listingModerationRecords.id))
      .limit(1)
    const reviewRecordId = reviewRows[0]?.id
    expect(reviewRecordId).toBeDefined()

    const allowed = await app.request(ADMIN_ROUTES.moderationDecision(reviewRecordId ?? ''), {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'Idempotency-Key': 'offline-update-review-allow',
      },
      body: JSON.stringify({ decision: 'ALLOW', reason: '批准编辑内容，保持原下架状态' }),
    })
    expect(allowed.status).toBe(200)

    const [listing] = await scratch
      .select({ status: listings.status, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, OFFLINE_REVIEW_LISTING_ID))
      .limit(1)
    expect(listing).toEqual({ status: 'OFFLINE', moderationStatus: 'APPROVED' })
  })

  test('repeated REVIEW attempts preserve the original status restoration target', async () => {
    await scratch.insert(listings).values([
      {
        id: REPEATED_REVIEW_LISTING_ID,
        sellerId: USER_ID,
        title: '重复审核商品',
        description: '原始描述',
        priceCents: 2500,
        category: 'BOOKS',
        condition: 'GOOD',
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
        createdAt: new Date('2026-09-05T02:00:00Z'),
      },
      {
        id: CREATE_REVIEW_CHAIN_LISTING_ID,
        sellerId: USER_ID,
        title: '新建审核商品',
        description: '原始描述',
        priceCents: 2500,
        category: 'BOOKS',
        condition: 'GOOD',
        status: 'OFFLINE',
        moderationStatus: 'REVIEW',
        createdAt: new Date('2026-09-05T03:00:00Z'),
      },
    ])
    await scratch.insert(listingModerationRecords).values({
      id: CREATE_REVIEW_CHAIN_RECORD_ID,
      listingId: CREATE_REVIEW_CHAIN_LISTING_ID,
      sellerId: USER_ID,
      action: 'CREATE',
      titleSnapshot: '新建审核商品',
      descriptionSnapshot: '原始描述',
      decision: 'REVIEW',
      matchedRules: jsonParam(['TEST_RULE']),
      matchedTermsMasked: jsonParam(['测**']),
      ruleVersion: 'test-v1',
      priorListingStatus: 'ACTIVE',
      createdAt: new Date('2026-09-05T03:01:00Z'),
    })

    for (const [listingId, description] of [
      [REPEATED_REVIEW_LISTING_ID, '第一次加微信联系'],
      [CREATE_REVIEW_CHAIN_LISTING_ID, '新建后编辑加微信联系'],
    ] as const) {
      const edited = await app.request(LISTING_ROUTES.detail(listingId), {
        method: 'PATCH',
        headers: { cookie: userCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      expect(edited.status).toBe(200)
    }

    const repeatedEdit = await app.request(LISTING_ROUTES.detail(REPEATED_REVIEW_LISTING_ID), {
      method: 'PATCH',
      headers: { cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '第二次加微信联系' }),
    })
    expect(repeatedEdit.status).toBe(200)

    const reviewIds = await scratch
      .select({ id: listingModerationRecords.id, listingId: listingModerationRecords.listingId })
      .from(listingModerationRecords)
      .where(eq(listingModerationRecords.decision, 'REVIEW'))
      .orderBy(desc(listingModerationRecords.createdAt), desc(listingModerationRecords.id))
    const latestFor = (listingId: string) =>
      reviewIds.find((row) => row.listingId === listingId)?.id
    for (const [listingId, requestId] of [
      [REPEATED_REVIEW_LISTING_ID, 'repeated-review-allow'],
      [CREATE_REVIEW_CHAIN_LISTING_ID, 'create-review-chain-allow'],
    ] as const) {
      const allowed = await app.request(
        ADMIN_ROUTES.moderationDecision(latestFor(listingId) ?? ''),
        {
          method: 'POST',
          headers: {
            cookie: adminCookie,
            'content-type': 'application/json',
            'Idempotency-Key': requestId,
          },
          body: JSON.stringify({ decision: 'ALLOW', reason: '保留原始上架状态' }),
        },
      )
      expect(allowed.status).toBe(200)
    }

    const restored = await scratch
      .select({
        id: listings.id,
        status: listings.status,
        moderationStatus: listings.moderationStatus,
      })
      .from(listings)
      .where(eq(listings.id, REPEATED_REVIEW_LISTING_ID))
    const createdRestored = await scratch
      .select({
        id: listings.id,
        status: listings.status,
        moderationStatus: listings.moderationStatus,
      })
      .from(listings)
      .where(eq(listings.id, CREATE_REVIEW_CHAIN_LISTING_ID))
    expect(restored[0]).toMatchObject({ status: 'ACTIVE', moderationStatus: 'APPROVED' })
    expect(createdRestored[0]).toMatchObject({ status: 'ACTIVE', moderationStatus: 'APPROVED' })
  })

  test('missing user / listing is 404 ADMIN_NOT_FOUND; non-uuid path param is 404, not 500', async () => {
    const missingUser = await app.request(
      ADMIN_ROUTES.userDetail('01930000-0000-7000-8000-00000000ffff'),
      { headers: { cookie: adminCookie } },
    )
    expect(missingUser.status).toBe(404)
    expect((await missingUser.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ADMIN_NOT_FOUND' },
    })

    const badId = await app.request(`${ADMIN_ROUTES.listings}/not-a-uuid`, {
      headers: { cookie: adminCookie },
    })
    expect(badId.status).toBe(404)
  })

  test('unmatched /admin/* path returns the contract error envelope, after the guards', async () => {
    const missing = await app.request('/admin/nope', { headers: { cookie: adminCookie } })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'ADMIN_NOT_FOUND' } })

    // 守卫先于 404：未登录访问不存在的 admin 路径同样是 401，不泄漏路径是否存在（设计 §3.2）。
    const anonymous = await app.request('/admin/nope')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  test('invalid query params return 422 VALIDATION_FAILED', async () => {
    const badLimit = await app.request(`${ADMIN_ROUTES.users}?limit=0`, {
      headers: { cookie: adminCookie },
    })
    expect(badLimit.status).toBe(422)

    const badCursor = await app.request(
      `${ADMIN_ROUTES.users}?cursor=${encodeURIComponent('not-a-cursor!!')}`,
      { headers: { cookie: adminCookie } },
    )
    expect(badCursor.status).toBe(422)
    expect(await badCursor.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  test('audit write failure rolls the moderation business change back (same transaction)', async () => {
    // 设计 §6：业务变更与审计写入必须在同一事务。这里在 admin_audit_logs 上挂一个
    // BEFORE INSERT 触发器，仅在 reason 带注入前缀时抛错（其他用例不受影响），
    // 从真实 HTTP 入口验证：审计写不进去 → 商品状态 / 人工审核记录 / 入队的匹配
    // 任务 / 审计行全部回滚，且同一 Idempotency-Key 重放能真正重新应用。
    await scratch.insert(listings).values({
      id: AUDIT_ROLLBACK_LISTING_ID,
      sellerId: USER_ID,
      title: '审计回滚商品',
      description: '审计写入失败时应保持原状',
      priceCents: 2500,
      category: 'BOOKS',
      condition: 'GOOD',
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
      moderationReason: '命中规则',
      moderationRuleVersion: 'test-v1',
      createdAt: new Date('2026-09-06T02:00:00Z'),
    })
    await scratch.insert(listingModerationRecords).values({
      id: AUDIT_ROLLBACK_RECORD_ID,
      listingId: AUDIT_ROLLBACK_LISTING_ID,
      sellerId: USER_ID,
      action: 'CREATE',
      titleSnapshot: '审计回滚商品',
      descriptionSnapshot: '审计写入失败时应保持原状',
      decision: 'REVIEW',
      matchedRules: jsonParam(['TEST_RULE']),
      matchedTermsMasked: jsonParam(['测**']),
      ruleVersion: 'test-v1',
      priorListingStatus: 'ACTIVE',
      createdAt: new Date('2026-09-06T02:01:00Z'),
    })

    await scratch.$client.unsafe(`
      CREATE OR REPLACE FUNCTION fish_test_fail_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.reason LIKE 'AUDIT_FAIL_INJECT%' THEN
          RAISE EXCEPTION 'injected audit failure for rollback test';
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
      const res = await app.request(ADMIN_ROUTES.moderationDecision(AUDIT_ROLLBACK_RECORD_ID), {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'Idempotency-Key': 'audit-failure-rollback',
        },
        body: JSON.stringify({ decision: 'ALLOW', reason: 'AUDIT_FAIL_INJECT 审计写入失败' }),
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

    // 业务状态回滚：商品仍是 REVIEW / OFFLINE，moderation_reason 没被人工决定覆盖。
    const [listing] = await scratch
      .select({
        status: listings.status,
        moderationStatus: listings.moderationStatus,
        moderationReason: listings.moderationReason,
      })
      .from(listings)
      .where(eq(listings.id, AUDIT_ROLLBACK_LISTING_ID))
    expect(listing).toMatchObject({
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
      moderationReason: '命中规则',
    })
    // 审核记录没有追加 MANUAL_DECISION 行（还是插入时那一条 CREATE）。
    const records = await scratch
      .select({ id: listingModerationRecords.id, action: listingModerationRecords.action })
      .from(listingModerationRecords)
      .where(eq(listingModerationRecords.listingId, AUDIT_ROLLBACK_LISTING_ID))
    expect(records).toEqual([{ id: AUDIT_ROLLBACK_RECORD_ID, action: 'CREATE' }])
    // 同一事务里入队的 MATCH_LISTING 任务也回滚了：若有人把 job 派发挪出事务，
    // 这个用例必须红——被审计拒绝的决定不该已经把匹配任务派出去。
    // 只查本商品的 job：本文件前面的用例合法地留下过其它商品的 job 行。
    const queued = await scratch.execute(
      sql`SELECT id FROM jobs
           WHERE type = ${'MATCH_LISTING'} AND payload->>${'listingId'} = ${AUDIT_ROLLBACK_LISTING_ID}`,
    )
    expect(queued).toHaveLength(0)
    // 审计行不存在：失败请求不会留下任何痕迹。
    const audits = await scratch
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.requestId, 'audit-failure-rollback'))
    expect(audits).toHaveLength(0)

    // 同 key 重放：失败请求没有留下幂等记录，所以重试会真正重新应用（而不是被
    // 误判成「已处理」直接返回）。顺带证明事务回滚是干净的，业务还能走下去。
    const replayed = await app.request(ADMIN_ROUTES.moderationDecision(AUDIT_ROLLBACK_RECORD_ID), {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'Idempotency-Key': 'audit-failure-rollback',
      },
      body: JSON.stringify({ decision: 'ALLOW', reason: '审计恢复后重放同一请求' }),
    })
    expect(replayed.status).toBe(200)
    const [replayedListing] = await scratch
      .select({ status: listings.status, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, AUDIT_ROLLBACK_LISTING_ID))
    expect(replayedListing).toMatchObject({ status: 'ACTIVE', moderationStatus: 'APPROVED' })

    // 清掉本条 fixture：本文件是共享 scratch 库，新增的计数类断言不该把 a6/b5 算进去。
    await scratch
      .delete(listingModerationRecords)
      .where(eq(listingModerationRecords.listingId, AUDIT_ROLLBACK_LISTING_ID))
    await scratch.delete(listings).where(eq(listings.id, AUDIT_ROLLBACK_LISTING_ID))
  })
})

/**
 * 审核记录检索（#73 治理半场 PR4）。
 *
 * 与上面「审核队列」用例行分红：队列是**工作清单**（服务端写死只列 REVIEW 商品、
 * 每条 listing 只留最新 REVIEW 记录），这里是**历史检索**——被人工决定过的、机器直接
 * 放行的都能捞出来。两者共用同一条目形状与分页口径，差别只在 WHERE。
 */
describe('Admin 审核记录检索', () => {
  test('setup: 匿名 401 / 普通用户 403，证明守卫先于路由解析', async () => {
    // 顺带覆盖路由顺序：`/moderation/records` 若被 `/moderation/:recordId` 吃掉，
    // 管理员拿到的是 404 ADMIN_NOT_FOUND 而不是 200。
    const anonymous = await app.request(ADMIN_ROUTES.moderationRecords)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })

    const asUser = await app.request(ADMIN_ROUTES.moderationRecords, {
      headers: { cookie: userCookie },
    })
    expect(asUser.status).toBe(403)
    expect(await asUser.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })

    const asAdmin = await app.request(ADMIN_ROUTES.moderationRecords, {
      headers: { cookie: adminCookie },
    })
    expect(asAdmin.status).toBe(200)
  })

  test('检索返回已离开队列的记录，队列端点仍只列 REVIEW', async () => {
    const records = await app.request(ADMIN_ROUTES.moderationRecords, {
      headers: { cookie: adminCookie },
    })
    expect(records.status).toBe(200)
    const page = AdminModerationRecordsSchema.parse(await records.json())
    const ids = page.items.map((item) => item.record.id)
    // fixture 里 REVIEW_LISTING_ID 有两条记录：一条 REVIEW、一条 BLOCK。
    // 队列按「每条 listing 只留最新 REVIEW 记录」去重，检索两条都要在。
    expect(ids).toContain(REVIEW_RECORD_ID)
    expect(ids).toContain(BLOCKED_EDIT_RECORD_ID)

    const queue = await app.request(ADMIN_ROUTES.moderationQueue, {
      headers: { cookie: adminCookie },
    })
    expect(queue.status).toBe(200)
    const queuePage = AdminModerationQueueSchema.parse(await queue.json())
    expect(queuePage.items.map((item) => item.record.id)).not.toContain(BLOCKED_EDIT_RECORD_ID)
    for (const item of queuePage.items) {
      expect(item.record.decision).toBe('REVIEW')
      expect(item.listing.moderationStatus).toBe('REVIEW')
    }
  })

  test('decision / listingId / q / 时间段四个筛选都生效', async () => {
    const adminHeaders = { cookie: adminCookie }

    const blocked = await app.request(`${ADMIN_ROUTES.moderationRecords}?decision=BLOCK`, {
      headers: adminHeaders,
    })
    const blockedIds = AdminModerationRecordsSchema.parse(await blocked.json()).items.map(
      (item) => item.record.id,
    )
    expect(blockedIds).toContain(BLOCKED_EDIT_RECORD_ID)
    // BLOCKED_EDIT_RECORD_ID 的判定从头到尾是 BLOCK，任何筛 REVIEW 的结果里都不该有它。
    expect(blockedIds).not.toContain(CREATE_REVIEW_CHAIN_RECORD_ID)

    const review = await app.request(`${ADMIN_ROUTES.moderationRecords}?decision=REVIEW`, {
      headers: adminHeaders,
    })
    const reviewIds = AdminModerationRecordsSchema.parse(await review.json()).items.map(
      (item) => item.record.id,
    )
    expect(reviewIds).not.toContain(BLOCKED_EDIT_RECORD_ID)

    const byListing = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?listingId=${REVIEW_LISTING_ID}`,
      { headers: adminHeaders },
    )
    const byListingIds = AdminModerationRecordsSchema.parse(await byListing.json()).items.map(
      (item) => item.record.id,
    )
    expect(byListingIds).toEqual(expect.arrayContaining([REVIEW_RECORD_ID, BLOCKED_EDIT_RECORD_ID]))

    const byTitle = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?q=${encodeURIComponent('待人工审核商品')}`,
      { headers: adminHeaders },
    )
    expect(byTitle.status).toBe(200)
    // q 命中 title 或 description 任一即返回（listingSearchCondition 口径），所以只能断言
    // 「两条里的标题或描述含关键词」，不能断言 title——描述命中的 fixture 会让后者假红。
    for (const item of AdminModerationRecordsSchema.parse(await byTitle.json()).items) {
      expect(`${item.listing.title}${item.listing.description}`).toContain('待人工审核商品')
    }

    // q 只搜 listings 表，不搜记录快照：BLOCKED_EDIT_RECORD_ID 的 titleSnapshot 是
    // 「被拦截的新编辑」，而该 listing 当前 title 是「待人工审核商品」——按快照标题搜
    // 必须搜不到，否则说明 WHERE 碰了 r.title_snapshot。
    const snapshotOnly = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?q=${encodeURIComponent('被拦截的新编辑')}`,
      { headers: adminHeaders },
    )
    expect(snapshotOnly.status).toBe(200)
    expect(AdminModerationRecordsSchema.parse(await snapshotOnly.json()).items).toHaveLength(0)

    const noMatch = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?q=${encodeURIComponent('不存在的标题关键词')}`,
      { headers: adminHeaders },
    )
    expect(AdminModerationRecordsSchema.parse(await noMatch.json()).items).toHaveLength(0)

    // 左闭右开：REVIEW_RECORD_ID 在 02:01、BLOCKED_EDIT_RECORD_ID 在 02:02。
    // 窗口 [02:02, 02:03) 只有后者——正好验证 from 含边界、to 不含边界。
    const window = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?createdFrom=${encodeURIComponent('2026-09-03T02:02:00.000Z')}&createdTo=${encodeURIComponent('2026-09-03T02:03:00.000Z')}`,
      { headers: adminHeaders },
    )
    expect(window.status).toBe(200)
    const windowIds = AdminModerationRecordsSchema.parse(await window.json()).items.map(
      (item) => item.record.id,
    )
    expect(windowIds).toContain(BLOCKED_EDIT_RECORD_ID)
    expect(windowIds).not.toContain(REVIEW_RECORD_ID)
  })

  test('非法 limit / cursor → 422 VALIDATION_FAILED', async () => {
    const badLimit = await app.request(`${ADMIN_ROUTES.moderationRecords}?limit=999`, {
      headers: { cookie: adminCookie },
    })
    expect(badLimit.status).toBe(422)
    expect(await badLimit.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })

    const badCursor = await app.request(`${ADMIN_ROUTES.moderationRecords}?cursor=not-a-cursor`, {
      headers: { cookie: adminCookie },
    })
    expect(badCursor.status).toBe(422)
    expect(await badCursor.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  test('下一页游标接着第一页往下走', async () => {
    const first = await app.request(`${ADMIN_ROUTES.moderationRecords}?limit=1`, {
      headers: { cookie: adminCookie },
    })
    const firstPage = AdminModerationRecordsSchema.parse(await first.json())
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()

    const second = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      { headers: { cookie: adminCookie } },
    )
    expect(second.status).toBe(200)
    const secondPage = AdminModerationRecordsSchema.parse(await second.json())
    expect(secondPage.items[0]?.record.id).not.toBe(firstPage.items[0]?.record.id)
  })
})
