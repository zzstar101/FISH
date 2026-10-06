import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RecommendationMetricsSchema } from '@fish/contracts/admin/recommendation-metrics'
import { ADMIN_ROUTES as PUBLIC_ADMIN_ROUTES } from '@fish/contracts/admin/routes'
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
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { userRestrictions } from '@fish/db/schema/governance'
import { idRekeys } from '@fish/db/schema/id-rekeys'
import { listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { desc, eq } from 'drizzle-orm'
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

// Fixtures use internal UUIDs for DB setup; requests must use public path IDs.
const ADMIN_ROUTES = {
  ...PUBLIC_ADMIN_ROUTES,
  userDetail: (id: string) =>
    PUBLIC_ADMIN_ROUTES.userDetail(encodePublicId(PUBLIC_ID_PREFIX.user, id)),
  listingDetail: (id: string) =>
    PUBLIC_ADMIN_ROUTES.listingDetail(encodePublicId(PUBLIC_ID_PREFIX.listing, id)),
  moderationDetail: (id: string) =>
    PUBLIC_ADMIN_ROUTES.moderationDetail(encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, id)),
  moderationDecision: (id: string) =>
    PUBLIC_ADMIN_ROUTES.moderationDecision(encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, id)),
}

// 固定 UUID：admin 测试的两个演示账号（由 auth /register 创建时用 newId…… 这里改为
// 手动 INSERT，便于拿到稳定 id 建商品与审计）。
const ADMIN_TARGET_ID = '01930000-0000-7000-8000-000000000091'
const USER_ID = '01930000-0000-7000-8000-000000000092'
const LISTING_ID = '01930000-0000-7000-8000-0000000000a1'
const REVIEW_LISTING_ID = '01930000-0000-7000-8000-0000000000a2'
const REVIEW_RECORD_ID = '01930000-0000-7000-8000-0000000000b2'
const BLOCKED_EDIT_RECORD_ID = '01930000-0000-7000-8000-0000000000b3'
const LOCAL_BLOCKED_EDIT_RECORD_ID = '01930000-0000-7000-8000-0000000000b5'
const OFFLINE_REVIEW_LISTING_ID = '01930000-0000-7000-8000-0000000000a3'
const REPEATED_REVIEW_LISTING_ID = '01930000-0000-7000-8000-0000000000a4'
const CREATE_REVIEW_CHAIN_LISTING_ID = '01930000-0000-7000-8000-0000000000a5'
const CREATE_REVIEW_CHAIN_RECORD_ID = '01930000-0000-7000-8000-0000000000b4'

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
      listingNo: await reserveTestListingNo(scratch, LISTING_ID),
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
      listingNo: await reserveTestListingNo(scratch, REVIEW_LISTING_ID),
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
    // #228 §6：这条记录模拟「腾讯 TMS 判 Review」，六列元数据必须能被 Admin 读回来。
    provider: 'TENCENT_TMS',
    providerRequestId: 'req-tms-0001',
    suggestion: 'Review',
    label: 'Porn',
    subLabel: 'Sexy',
    score: 88.5,
    createdAt: new Date('2026-09-03T02:01:00Z'),
  })
  // 这条刻意保持 #228 之前的历史行形状（provider 六列全 NULL），用来证明旧记录读得出来。
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
  // #228 §6：`provider='LOCAL'` 的行**不是**六列全 NULL——本地词表没有腾讯的 Label/Score/RequestId，
  // 但它自己会给出 `suggestion`（由 decision 派生）与 `subLabel`（命中的本地规则码）。
  // 这条种子行把本地 transport 的真实形状钉住：把 `suggestion`/`subLabel` 一律当成腾讯结论的读法，
  // 或反过来「顺手把本地行也清成 null」的改动，都必须在这里变红。
  await scratch.insert(listingModerationRecords).values({
    id: LOCAL_BLOCKED_EDIT_RECORD_ID,
    listingId: REVIEW_LISTING_ID,
    sellerId: USER_ID,
    action: 'UPDATE',
    titleSnapshot: '本地词表拦截的新编辑',
    descriptionSnapshot: '这次编辑命中本地违禁词',
    decision: 'BLOCK',
    matchedRules: jsonParam(['PROHIBITED_CONTENT']),
    matchedTermsMasked: jsonParam(['毒**']),
    ruleVersion: '2026-09-15-v3',
    provider: 'LOCAL',
    suggestion: 'Block',
    subLabel: 'PROHIBITED_CONTENT',
    createdAt: new Date('2026-09-03T02:03:00Z'),
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
      ADMIN_ROUTES.recommendationMetrics,
      ADMIN_ROUTES.auditLogs,
      ADMIN_ROUTES.moderationQueue,
      ADMIN_ROUTES.transactions,
      ADMIN_ROUTES.moderationDetail(REVIEW_RECORD_ID),
      ADMIN_ROUTES.userDetail(USER_ID),
    ]) {
      if (!path) continue
      const res = await app.request(path, { headers: { cookie: userCookie } })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('FORBIDDEN')
    }
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
    expect(byId.get(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))?.studentNoMasked).toBe(
      '2021****0902',
    )
    expect(byId.get(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))?.listingCount).toBe(2)
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
    expect(AdminUserSummaryPageSchema.parse(await byNo.json()).items[0]?.id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
    )

    const byName = await app.request(`${ADMIN_ROUTES.users}?q=管理员`, {
      headers: { cookie: adminCookie },
    })
    expect(AdminUserSummaryPageSchema.parse(await byName.json()).items[0]?.id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_TARGET_ID),
    )

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
    const raw = Buffer.from(nextCursor ?? '', 'base64url').toString('utf8')
    const timestamp = raw.slice(0, raw.lastIndexOf('|'))
    expect(raw.slice(raw.lastIndexOf('|') + 1)).toBe(body1.items[0]?.id ?? '')
    const bareCursor = Buffer.from(
      `${timestamp}|${decodePublicId(PUBLIC_ID_PREFIX.user, body1.items[0]?.id ?? '')}`,
    ).toString('base64url')
    const bare = await app.request(
      `${ADMIN_ROUTES.users}?limit=1&cursor=${encodeURIComponent(bareCursor)}`,
      { headers: { cookie: adminCookie } },
    )
    expect(bare.status).toBe(422)

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
    expect(body.user.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))
    expect(body.listingStats.ACTIVE).toBe(1)
  })

  test('admin detail paths reject bare UUIDs, wrong prefixes and non-canonical IDs', async () => {
    for (const { path, id, wrongPrefix } of [
      { path: PUBLIC_ADMIN_ROUTES.userDetail, id: USER_ID, wrongPrefix: PUBLIC_ID_PREFIX.listing },
      {
        path: PUBLIC_ADMIN_ROUTES.listingDetail,
        id: LISTING_ID,
        wrongPrefix: PUBLIC_ID_PREFIX.user,
      },
      {
        path: PUBLIC_ADMIN_ROUTES.moderationDetail,
        id: REVIEW_RECORD_ID,
        wrongPrefix: PUBLIC_ID_PREFIX.listing,
      },
    ]) {
      for (const invalid of [id, encodePublicId(wrongPrefix, id), 'not-a-public-id']) {
        const res = await app.request(path(invalid), { headers: { cookie: adminCookie } })
        expect(res.status).toBe(404)
        expect(await res.json()).toMatchObject({ error: { code: 'ADMIN_NOT_FOUND' } })
      }
    }
  })

  test('admin action paths reject invalid IDs before validating request bodies', async () => {
    for (const { path, id, prefix, wrongPrefix } of [
      {
        path: PUBLIC_ADMIN_ROUTES.moderationDecision,
        id: REVIEW_RECORD_ID,
        prefix: PUBLIC_ID_PREFIX.moderationRecord,
        wrongPrefix: PUBLIC_ID_PREFIX.user,
      },
      {
        path: PUBLIC_ADMIN_ROUTES.listingDelist,
        id: LISTING_ID,
        prefix: PUBLIC_ID_PREFIX.listing,
        wrongPrefix: PUBLIC_ID_PREFIX.user,
      },
      {
        path: PUBLIC_ADMIN_ROUTES.listingRestore,
        id: LISTING_ID,
        prefix: PUBLIC_ID_PREFIX.listing,
        wrongPrefix: PUBLIC_ID_PREFIX.user,
      },
      {
        path: PUBLIC_ADMIN_ROUTES.userRestrictPublish,
        id: USER_ID,
        prefix: PUBLIC_ID_PREFIX.user,
        wrongPrefix: PUBLIC_ID_PREFIX.listing,
      },
      {
        path: PUBLIC_ADMIN_ROUTES.userBan,
        id: USER_ID,
        prefix: PUBLIC_ID_PREFIX.user,
        wrongPrefix: PUBLIC_ID_PREFIX.listing,
      },
      {
        path: PUBLIC_ADMIN_ROUTES.userLiftRestriction,
        id: USER_ID,
        prefix: PUBLIC_ID_PREFIX.user,
        wrongPrefix: PUBLIC_ID_PREFIX.listing,
      },
    ]) {
      for (const invalid of [id, encodePublicId(wrongPrefix, id), 'not-a-public-id']) {
        const res = await app.request(path(invalid), {
          ...post({}),
          headers: { cookie: adminCookie, 'content-type': 'application/json' },
        })
        expect(res.status).toBe(404)
        expect(await res.json()).toMatchObject({ error: { code: 'ADMIN_NOT_FOUND' } })
      }
      const valid = await app.request(path(encodePublicId(prefix, id)), {
        ...post({}),
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
      })
      expect(valid.status).toBe(422)
    }
  })

  test('GET /admin/listings returns seller summary; status filter works', async () => {
    const res = await app.request(ADMIN_ROUTES.listings, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = AdminListingSummaryPageSchema.parse(await res.json())
    expect(body.items[0]?.title).toBe('管理后台可见商品')
    expect(body.items[0]?.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID))
    expect(body.items[0]?.seller.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))
    expect(body.items[0]?.seller.nickname).toBe('普通用户乙')

    const bySeller = await app.request(
      `${ADMIN_ROUTES.listings}?sellerId=${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}`,
      { headers: { cookie: adminCookie } },
    )
    expect(bySeller.status).toBe(200)
    expect(AdminListingSummaryPageSchema.parse(await bySeller.json()).items).toHaveLength(2)
    for (const sellerId of [USER_ID, encodePublicId(PUBLIC_ID_PREFIX.listing, USER_ID)]) {
      const invalid = await app.request(`${ADMIN_ROUTES.listings}?sellerId=${sellerId}`, {
        headers: { cookie: adminCookie },
      })
      expect(invalid.status).toBe(422)
    }

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
    expect(body.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID))
    expect(body.seller.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))
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
    expect(moderationBody.items[0]?.record.id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, REVIEW_RECORD_ID),
    )
    expect(moderationBody.items[0]?.record.listingId).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.listing, REVIEW_LISTING_ID),
    )
    expect(moderationBody.items[0]?.record.sellerId).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
    )
    expect(moderationBody.items[0]?.seller.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))
    expect(moderationBody.items[0]?.record.titleSnapshot).toBe('待人工审核商品')
    // #228 §6：队列必须能追溯到腾讯上游结论（provider / RequestId / Suggestion / Label / Score）。
    expect(moderationBody.items[0]?.record).toMatchObject({
      provider: 'TENCENT_TMS',
      providerRequestId: 'req-tms-0001',
      suggestion: 'Review',
      label: 'Porn',
      subLabel: 'Sexy',
      score: 88.5,
    })

    const transaction = await app.request(ADMIN_ROUTES.transactions, {
      headers: { cookie: adminCookie },
    })
    expect(transaction.status).toBe(200)
    expect(AdminTransactionPageSchema.parse(await transaction.json()).items).toEqual([])
  })

  test('#228 §6：审核记录检索也暴露 provider 上游元数据，历史记录保持 null', async () => {
    const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, REVIEW_LISTING_ID)
    const response = await app.request(`${ADMIN_ROUTES.moderationRecords}?listingId=${listingId}`, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    const page = AdminModerationRecordsSchema.parse(await response.json())
    const recordId = (id: string) => encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, id)

    expect(
      page.items.find((item) => item.record.id === recordId(REVIEW_RECORD_ID))?.record,
    ).toMatchObject({
      provider: 'TENCENT_TMS',
      providerRequestId: 'req-tms-0001',
      suggestion: 'Review',
      label: 'Porn',
      subLabel: 'Sexy',
      score: 88.5,
    })
    expect(
      page.items.find((item) => item.record.id === recordId(BLOCKED_EDIT_RECORD_ID))?.record,
    ).toMatchObject({
      provider: null,
      providerRequestId: null,
      suggestion: null,
      label: null,
      subLabel: null,
      score: null,
    })
    // 本地词表行是第三种形状（见 detail 用例）：provider=LOCAL + suggestion/subLabel 有值，
    // 腾讯专有的 label / score / RequestId 仍为 null。检索端点也必须原样回读。
    expect(
      page.items.find((item) => item.record.id === recordId(LOCAL_BLOCKED_EDIT_RECORD_ID))?.record,
    ).toMatchObject({
      provider: 'LOCAL',
      suggestion: 'Block',
      subLabel: 'PROHIBITED_CONTENT',
      providerRequestId: null,
      label: null,
      score: null,
    })

    // #228 §6「不公开 Label/Score/RequestId 给普通用户」：这些列现在进了 Admin 契约，
    // 但卖家侧的商品详情必须一个都不带——包括命中策略（matchedRules / matchedTermsMasked）。
    // 对**原始 JSON 文本**扫键名而不是逐字段断言：以后有人把 record 整个展开进 Listing DTO 时，
    // 逐字段断言很容易漏掉新增的嵌套，扫描不会。
    const sellerView = await app.request(
      LISTING_ROUTES.detail(encodePublicId(PUBLIC_ID_PREFIX.listing, REVIEW_LISTING_ID)),
      { headers: { cookie: userCookie } },
    )
    expect(sellerView.status).toBe(200)
    const sellerRaw = await sellerView.text()
    for (const leaked of [
      'provider',
      'providerRequestId',
      'suggestion',
      'label',
      'subLabel',
      'score',
      'matchedRules',
      'matchedTermsMasked',
    ]) {
      expect(sellerRaw.includes(`"${leaked}"`)).toBe(false)
    }
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

  // #323 R6：推荐指标端点（只读聚合）。这个 scratch 库里没有推荐请求/事件/快照，
  // 所以它同时是"空库"用例：计数 0、比率全 null、延迟三项齐全但 count=0。
  test('GET /admin/recommendations/metrics 空库返回 0 计数与 null 比率', async () => {
    const res = await app.request(ADMIN_ROUTES.recommendationMetrics, {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = RecommendationMetricsSchema.parse(await res.json())
    expect(body.window).toBe('24h')
    expect(body.funnel).toMatchObject({
      feedRequests: 0,
      degradedFeedRequests: 0,
      impressions: 0,
      impressionToDetailRate: null,
      transactionToPurchaseRate: null,
    })
    expect(body.guardrails).toMatchObject({
      emptyRankedFeedRate: null,
      repeatedExposureRate: null,
      topSellerExposureShare: null,
      eventWriteFailureRate: null,
      rateLimitedRequests: 0,
      eventRejectionReasons: {
        attributionNotFound: 0,
        identityMismatch: 0,
        listingNotFound: 0,
        occurredAtOutOfRange: 0,
        serverConfirmedEventType: 0,
      },
    })
    expect(body.latency.map((row) => row.metric).sort()).toEqual(['events', 'feed', 'pgvector'])
    for (const row of body.latency) {
      expect(row.count).toBe(0)
      expect(row.p50Ms).toBeNull()
      expect(row.p95Ms).toBeNull()
      expect(row.p99Ms).toBeNull()
      expect(row.maxMs).toBeNull()
    }
    expect(new Date(body.generatedAt).getTime()).toBeLessThanOrEqual(Date.now())
    expect(new Date(body.processStartedAt).getTime()).toBeLessThanOrEqual(Date.now())
    // 生命周期三项（M8）走的是真库 SQL：空库里没有归因事件也没有窗口内创建的商品。
    expect(body.lifecycle).toEqual({
      newListingTimeToFirstExposureHours: { count: 0, median: null, p90: null },
      firstPublishToFirstIntentHours: { count: 0, median: null, p90: null },
      exposuresBeforeSale: { count: 0, median: null, p90: null },
    })
  })

  test('GET /admin/recommendations/metrics 接受三个窗口档位', async () => {
    for (const window of ['24h', '7d', '30d'] as const) {
      const res = await app.request(`${ADMIN_ROUTES.recommendationMetrics}?window=${window}`, {
        headers: { cookie: adminCookie },
      })
      expect(res.status).toBe(200)
      expect(RecommendationMetricsSchema.parse(await res.json()).window).toBe(window)
    }
  })

  test('GET /admin/recommendations/metrics 非法窗口 → 422 VALIDATION_FAILED', async () => {
    for (const query of ['?window=1d', '?window=', '?window=7d&extra=1']) {
      const res = await app.request(`${ADMIN_ROUTES.recommendationMetrics}${query}`, {
        headers: { cookie: adminCookie },
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_FAILED')
    }
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
      `${ADMIN_ROUTES.auditLogs}?actorId=${encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_TARGET_ID)}&action=ADMIN_PROMOTED`,
      { headers: { cookie: adminCookie } },
    )
    expect(AdminAuditLogPageSchema.parse(await filtered.json()).items).toHaveLength(1)
  })

  // #464 回归：worker 写入的 `ACCOUNT_DELETION_COMPLETED` 系统审计行必须读得到。
  // 修复前契约枚举缺该值：`toAuditLogEntry` 的 `AdminAuditLogEntrySchema.safeParse` 失败 →
  // `pageOf` 的 `.filter(item => item !== null)` 把整行静默丢掉（列表里少一条「账号注销完成」），
  // 且 `?action=ACCOUNT_DELETION_COMPLETED` 会在 `AdminAuditLogsQuerySchema` 处直接 422。
  test('GET /admin/audit-logs 透出系统动作 ACCOUNT_DELETION_COMPLETED（actor 为 null）', async () => {
    await scratch.insert(adminAuditLogs).values({
      id: newId(),
      actorUserId: null,
      action: 'ACCOUNT_DELETION_COMPLETED',
      targetType: 'USER',
      targetId: USER_ID,
      before: jsonParam({ accountStatus: 'DELETION_REQUESTED' }),
      after: jsonParam({ accountStatus: 'DELETED', counts: { listings: 0, wishes: 0 } }),
      reason: '账号注销冷静期到期，系统执行去标识化',
      requestId: null,
      createdAt: new Date('2026-09-03T00:00:00Z'),
    })

    const res = await app.request(ADMIN_ROUTES.auditLogs, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const entry = AdminAuditLogPageSchema.parse(await res.json()).items.find(
      (item) => item.action === 'ACCOUNT_DELETION_COMPLETED',
    )
    expect(entry).toBeDefined()
    expect(entry?.actor).toBeNull()
    expect(entry?.targetType).toBe('USER')
    expect(entry?.targetId).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID))
    expect(entry?.after).toEqual({ accountStatus: 'DELETED', counts: { listings: 0, wishes: 0 } })

    // 按该 action 过滤不得 422（query 走同一份契约枚举）。
    const filtered = await app.request(
      `${ADMIN_ROUTES.auditLogs}?action=ACCOUNT_DELETION_COMPLETED`,
      { headers: { cookie: adminCookie } },
    )
    expect(filtered.status).toBe(200)
    expect(
      AdminAuditLogPageSchema.parse(await filtered.json()).items.map((item) => item.action),
    ).toEqual(['ACCOUNT_DELETION_COMPLETED'])
  })

  test('审计公开 ID 按资源投影历史映射；数据库快照原文不改', async () => {
    const oldReport = '01930000-0000-4000-8000-000000000061'
    const oldRecord = '01930000-0000-4000-8000-000000000062'
    const reportId = newId()
    const recordId = newId()
    const auditId = newId()
    await scratch.insert(idRekeys).values([
      { resourceTable: 'reports', oldId: oldReport, newId: reportId },
      { resourceTable: 'listing_moderation_records', oldId: oldRecord, newId: recordId },
    ])
    await scratch.insert(adminAuditLogs).values({
      id: auditId,
      actorUserId: ADMIN_TARGET_ID,
      action: 'REPORT_DECISION',
      targetType: 'REPORT',
      targetId: oldReport,
      before: jsonParam({ status: 'PENDING' }),
      after: jsonParam({
        sourceReportId: oldReport,
        manualRecordId: oldRecord,
        targetType: 'LISTING',
        targetId: LISTING_ID,
        reporterId: ADMIN_TARGET_ID,
      }),
      requestId: 'historical-audit-test',
    })
    const response = await app.request(ADMIN_ROUTES.auditLogs, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    const entry = AdminAuditLogPageSchema.parse(await response.json()).items.find(
      (item) => item.id === encodePublicId(PUBLIC_ID_PREFIX.auditLog, auditId),
    )
    expect(entry).toMatchObject({
      targetId: encodePublicId(PUBLIC_ID_PREFIX.report, reportId),
      after: {
        sourceReportId: encodePublicId(PUBLIC_ID_PREFIX.report, reportId),
        manualRecordId: encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, recordId),
        targetId: encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID),
        reporterId: encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_TARGET_ID),
      },
    })
    const [stored] = await scratch
      .select({ after: adminAuditLogs.after })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.id, auditId))
    expect(stored?.after).toEqual({
      sourceReportId: oldReport,
      manualRecordId: oldRecord,
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reporterId: ADMIN_TARGET_ID,
    })

    const wrong = await app.request(
      `${ADMIN_ROUTES.auditLogs}?targetType=REPORT&targetId=${encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_TARGET_ID)}`,
      { headers: { cookie: adminCookie } },
    )
    expect(wrong.status).toBe(422)
    for (const query of [
      `actorId=${ADMIN_TARGET_ID}`,
      `targetType=REPORT&targetId=${reportId}`,
      `targetType=REPORT&targetId=${encodePublicId(PUBLIC_ID_PREFIX.listing, reportId)}`,
    ]) {
      expect(
        (
          await app.request(`${ADMIN_ROUTES.auditLogs}?${query}`, {
            headers: { cookie: adminCookie },
          })
        ).status,
      ).toBe(422)
    }
    const filtered = await app.request(
      `${ADMIN_ROUTES.auditLogs}?targetType=REPORT&targetId=${encodePublicId(PUBLIC_ID_PREFIX.report, reportId)}`,
      { headers: { cookie: adminCookie } },
    )
    expect(AdminAuditLogPageSchema.parse(await filtered.json()).items).toHaveLength(1)
  })

  test('历史无映射目标只省略脏引用，不丢整条审计', async () => {
    const auditId = newId()
    const orphan = '01930000-0000-4000-8000-000000000069'
    await scratch.insert(adminAuditLogs).values({
      id: auditId,
      actorUserId: ADMIN_TARGET_ID,
      action: 'REPORT_DECISION',
      targetType: 'REPORT',
      targetId: orphan,
      after: jsonParam({ status: 'RESOLVED', sourceReportId: orphan }),
      requestId: 'orphan-audit-test',
    })
    const response = await app.request(ADMIN_ROUTES.auditLogs, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    const entry = AdminAuditLogPageSchema.parse(await response.json()).items.find(
      (item) => item.id === encodePublicId(PUBLIC_ID_PREFIX.auditLog, auditId),
    )
    expect(entry).toMatchObject({ targetId: null, after: { status: 'RESOLVED' } })
    expect(JSON.stringify(entry)).not.toContain(orphan)
  })

  test('用户详情同时列出限制/解除历史审计，不混入其他用户的审计', async () => {
    const restrictionId = newId()
    const auditId = newId()
    await scratch.insert(userRestrictions).values({
      id: restrictionId,
      userId: USER_ID,
      actorUserId: ADMIN_TARGET_ID,
      type: 'PUBLISH_RESTRICT',
      status: 'LIFTED',
      reason: '历史处罚',
      liftedAt: new Date(),
      liftedBy: ADMIN_TARGET_ID,
    })
    await scratch.insert(adminAuditLogs).values({
      id: auditId,
      actorUserId: ADMIN_TARGET_ID,
      action: 'USER_RESTRICTION_LIFTED',
      targetType: 'USER_RESTRICTION',
      targetId: restrictionId,
      before: jsonParam({ status: 'ACTIVE' }),
      after: jsonParam({ status: 'LIFTED' }),
      reason: '解除限制',
      requestId: `test-audit-${auditId}`,
    })
    const user = await app.request(ADMIN_ROUTES.userDetail(USER_ID), {
      headers: { cookie: adminCookie },
    })
    expect(user.status).toBe(200)
    expect(AdminUserDetailSchema.parse(await user.json()).recentAuditLogs).toContainEqual(
      expect.objectContaining({
        id: encodePublicId(PUBLIC_ID_PREFIX.auditLog, auditId),
        targetType: 'USER_RESTRICTION',
        targetId: encodePublicId(PUBLIC_ID_PREFIX.userRestriction, restrictionId),
      }),
    )

    const other = await app.request(ADMIN_ROUTES.userDetail(ADMIN_TARGET_ID), {
      headers: { cookie: adminCookie },
    })
    const otherLogs = AdminUserDetailSchema.parse(await other.json()).recentAuditLogs
    expect(otherLogs.map((log) => log.id)).not.toContain(
      encodePublicId(PUBLIC_ID_PREFIX.auditLog, auditId),
    )
    expect(otherLogs).toContainEqual(expect.objectContaining({ action: 'ADMIN_PROMOTED' }))
  })

  test('moderation detail and decision update the listing and audit atomically', async () => {
    const recordId = REVIEW_RECORD_ID
    const detail = await app.request(ADMIN_ROUTES.moderationDetail(recordId), {
      headers: { cookie: adminCookie },
    })
    expect(detail.status).toBe(200)
    const detailBody = AdminModerationDetailSchema.parse(await detail.json())
    expect(detailBody.machineDecision).toBe('REVIEW')
    expect(detailBody.humanDecision).toBeNull()
    // #228 §6：详情要能追溯到腾讯上游结论。
    expect(detailBody.item.record).toMatchObject({
      provider: 'TENCENT_TMS',
      providerRequestId: 'req-tms-0001',
      suggestion: 'Review',
      label: 'Porn',
      subLabel: 'Sexy',
      score: 88.5,
    })
    // #228 之前落库的历史行没有上游来源，六列必须是 null 而不是空串或 0。
    const legacyHistory = detailBody.history.find(
      (record) =>
        record.id === encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, BLOCKED_EDIT_RECORD_ID),
    )
    expect(legacyHistory).toMatchObject({
      provider: null,
      providerRequestId: null,
      suggestion: null,
      label: null,
      subLabel: null,
      score: null,
    })

    // 本地词表行（dev / CI / core-smoke 的默认 transport）与"历史全 NULL"是**两种形状**：
    // 它有 suggestion 与 subLabel，但没有腾讯的 label / score / RequestId。
    // 详情返回必须原样回读，不能把 LOCAL 行也拍平成 null。
    const localHistory = detailBody.history.find(
      (record) =>
        record.id ===
        encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, LOCAL_BLOCKED_EDIT_RECORD_ID),
    )
    expect(localHistory).toMatchObject({
      provider: 'LOCAL',
      suggestion: 'Block',
      subLabel: 'PROHIBITED_CONTENT',
      providerRequestId: null,
      label: null,
      score: null,
    })

    const decided = await app.request(ADMIN_ROUTES.moderationDecision(recordId), {
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
    // #228 §6「人工结果也可追溯」：人工改判自己写成一条 provider=MANUAL 的记录，
    // 且不得伪造腾讯的 label / score。
    const manualRecord = decidedBody.history.find((record) => record.provider === 'MANUAL')
    expect(manualRecord).toMatchObject({
      providerRequestId: null,
      suggestion: null,
      label: null,
      subLabel: null,
      score: null,
    })

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
      listingNo: await reserveTestListingNo(scratch, OFFLINE_REVIEW_LISTING_ID),
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

    const edited = await app.request(
      LISTING_ROUTES.detail(encodePublicId(PUBLIC_ID_PREFIX.listing, OFFLINE_REVIEW_LISTING_ID)),
      {
        method: 'PATCH',
        headers: { cookie: userCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ description: '加微信联系' }),
      },
    )
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
        listingNo: await reserveTestListingNo(scratch, REPEATED_REVIEW_LISTING_ID),
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
        listingNo: await reserveTestListingNo(scratch, CREATE_REVIEW_CHAIN_LISTING_ID),
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
      const edited = await app.request(
        LISTING_ROUTES.detail(encodePublicId(PUBLIC_ID_PREFIX.listing, listingId)),
        {
          method: 'PATCH',
          headers: { cookie: userCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ description }),
        },
      )
      expect(edited.status).toBe(200)
    }

    const repeatedEdit = await app.request(
      LISTING_ROUTES.detail(encodePublicId(PUBLIC_ID_PREFIX.listing, REPEATED_REVIEW_LISTING_ID)),
      {
        method: 'PATCH',
        headers: { cookie: userCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ description: '第二次加微信联系' }),
      },
    )
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

  test('missing user / listing is 404 ADMIN_NOT_FOUND; malformed TypeID is 404, not 500', async () => {
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

  test('审核记录按 lst_ 商品筛选，裸 UUID 与错误前缀在入库前拒绝', async () => {
    const publicListingId = encodePublicId(PUBLIC_ID_PREFIX.listing, REVIEW_LISTING_ID)
    const matching = await app.request(
      `${ADMIN_ROUTES.moderationRecords}?listingId=${publicListingId}`,
      { headers: { cookie: adminCookie } },
    )
    expect(matching.status).toBe(200)
    const page = AdminModerationRecordsSchema.parse(await matching.json())
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((item) => item.record.listingId === publicListingId)).toBe(true)

    for (const id of [
      REVIEW_LISTING_ID,
      encodePublicId(PUBLIC_ID_PREFIX.user, REVIEW_LISTING_ID),
    ]) {
      const invalid = await app.request(`${ADMIN_ROUTES.moderationRecords}?listingId=${id}`, {
        headers: { cookie: adminCookie },
      })
      expect(invalid.status).toBe(422)
    }
  })

  test('审核记录历史保留已删除商品的快照，listing 明确为 null', async () => {
    const listingId = newId()
    const recordId = newId()
    await scratch.insert(listings).values({
      id: listingId,
      listingNo: await reserveTestListingNo(scratch, listingId),
      sellerId: USER_ID,
      title: '已删除的历史商品',
      description: '历史描述',
      priceCents: 100,
      category: 'BOOKS',
      condition: 'GOOD',
      status: 'ACTIVE',
    })
    await scratch.insert(listingModerationRecords).values({
      id: recordId,
      listingId,
      sellerId: USER_ID,
      action: 'CREATE',
      titleSnapshot: '已删除的历史商品',
      descriptionSnapshot: '历史描述',
      decision: 'ALLOW',
      matchedRules: jsonParam([]),
      matchedTermsMasked: jsonParam([]),
      ruleVersion: 'test-v1',
    })
    await scratch.delete(listings).where(eq(listings.id, listingId))

    const response = await app.request(`${ADMIN_ROUTES.moderationRecords}?decision=ALLOW`, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    const page = AdminModerationRecordsSchema.parse(await response.json())
    const historical = page.items.find(
      (item) => item.record.id === encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, recordId),
    )
    expect(historical?.record).toMatchObject({ listingId: null, titleSnapshot: '已删除的历史商品' })
    expect(historical?.listing).toBeNull()
  })

  test('旧人工审核审计保留原文，通过重键映射查回人工决定', async () => {
    const rootId = newId()
    const manualId = newId()
    const oldManualId = crypto.randomUUID()
    await scratch.insert(listingModerationRecords).values([
      {
        id: rootId,
        listingId: REVIEW_LISTING_ID,
        sellerId: USER_ID,
        action: 'CREATE',
        titleSnapshot: '历史审核',
        descriptionSnapshot: '旧记录',
        decision: 'REVIEW',
        matchedRules: jsonParam([]),
        matchedTermsMasked: jsonParam([]),
        ruleVersion: 'test-v1',
      },
      {
        id: manualId,
        listingId: REVIEW_LISTING_ID,
        sellerId: USER_ID,
        action: 'MANUAL_DECISION',
        titleSnapshot: '历史审核',
        descriptionSnapshot: '旧记录',
        decision: 'ALLOW',
        matchedRules: jsonParam([]),
        matchedTermsMasked: jsonParam([]),
        ruleVersion: 'test-v1',
      },
    ])
    await scratch
      .insert(idRekeys)
      .values({ resourceTable: 'listing_moderation_records', oldId: oldManualId, newId: manualId })
    await scratch.insert(adminAuditLogs).values({
      id: newId(),
      actorUserId: ADMIN_TARGET_ID,
      action: 'MODERATION_DECISION',
      targetType: 'MODERATION_RECORD',
      targetId: rootId,
      before: jsonParam({ moderationStatus: 'REVIEW' }),
      after: jsonParam({ decision: 'ALLOW', manualRecordId: oldManualId }),
      reason: '历史人工审核通过',
    })

    const response = await app.request(ADMIN_ROUTES.moderationDetail(manualId), {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    const body = AdminModerationDetailSchema.parse(await response.json())
    expect(body.item.record.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, rootId))
    expect(body.humanDecision?.decision).toBe('ALLOW')
    expect(body.humanDecision?.actor?.id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_TARGET_ID),
    )
    const [audit] = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, rootId))
    expect(audit?.after).toMatchObject({ manualRecordId: oldManualId })
  })

  test('管理交易输出资源 TypeID，筛选只接受各资源对应前缀', async () => {
    const transactionId = newId()
    await scratch.insert(transactions).values({
      id: transactionId,
      listingId: LISTING_ID,
      buyerId: ADMIN_TARGET_ID,
      sellerId: USER_ID,
      amountCents: 15900,
    })
    const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID)
    const buyerId = encodePublicId(PUBLIC_ID_PREFIX.user, ADMIN_TARGET_ID)
    const sellerId = encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)
    const page = await app.request(
      `${ADMIN_ROUTES.transactions}?buyerId=${buyerId}&sellerId=${sellerId}&listingId=${listingId}`,
      { headers: { cookie: adminCookie } },
    )
    expect(page.status).toBe(200)
    expect(AdminTransactionPageSchema.parse(await page.json()).items).toEqual([
      expect.objectContaining({
        id: encodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId),
        listingId,
        buyer: expect.objectContaining({ id: buyerId }),
        seller: expect.objectContaining({ id: sellerId }),
      }),
    ])

    for (const query of [
      `buyerId=${ADMIN_TARGET_ID}`,
      `sellerId=${listingId}`,
      `listingId=${LISTING_ID}`,
      `listingId=${buyerId}`,
    ]) {
      const invalid = await app.request(`${ADMIN_ROUTES.transactions}?${query}`, {
        headers: { cookie: adminCookie },
      })
      expect(invalid.status).toBe(422)
    }
  })
})
