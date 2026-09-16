import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import {
  AdminAuditLogPageSchema,
  AdminListingDetailSchema,
  AdminListingSummaryPageSchema,
  AdminMeResponseSchema,
  AdminOverviewSchema,
  AdminUserDetailSchema,
  AdminUserSummaryPageSchema,
} from '@fish/contracts/admin/schema'
import { createDb, type Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
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
      campus: '肇庆',
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
      campus: '广州',
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
  await scratch.insert(listings).values({
    id: LISTING_ID,
    sellerId: USER_ID,
    title: '管理后台可见商品',
    description: '用于管理员查询的测试商品',
    priceCents: 15900,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-02T02:00:00Z'),
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
      ADMIN_ROUTES.userDetail(userCookie ? USER_ID : ''),
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
    expect(byId.get(USER_ID)?.studentNoMasked).toBe('2021****0902')
    expect(byId.get(USER_ID)?.listingCount).toBe(1)
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
    // 两页 id 不重复（游标不重不漏）
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
})
