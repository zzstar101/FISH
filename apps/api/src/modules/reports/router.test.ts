import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import { createDb, type Db } from '@fish/db/client'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { listings } from '@fish/db/schema/listings'
import { reports } from '@fish/db/schema/reports'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'

/**
 * 举报闭环端到端（#73）：用户提交 → 管理队列 → 处理 → 审计。
 *
 * 与 admin 测试同款自建 scratch 库：举报会插入行、处理会写审计，跑在开发库会污染他人。
 * 覆盖设计 §7 的验收项：匿名 401、普通用户 403、目标不存在 404、重复举报不新增、
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

const DEMO_PASSWORD = 'fish123456'

const ADMIN_ID = '01930000-0000-7000-8000-000000000091'
const REPORTER_ID = '01930000-0000-7000-8000-000000000092'
const SECOND_REPORTER_ID = '01930000-0000-7000-8000-000000000093'
const TARGET_USER_ID = '01930000-0000-7000-8000-000000000094'
const LISTING_ID = '01930000-0000-7000-8000-0000000000a1'

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  const passwordHash = await Bun.password.hash(DEMO_PASSWORD)
  await scratch.insert(users).values([
    {
      id: ADMIN_ID,
      studentNo: '202101000901',
      passwordHash,
      nickname: '管理员甲',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      role: 'ADMIN',
    },
    {
      id: REPORTER_ID,
      studentNo: '202101000902',
      passwordHash,
      nickname: '举报人乙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
    {
      id: SECOND_REPORTER_ID,
      studentNo: '202101000903',
      passwordHash,
      nickname: '举报人丙',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
    {
      id: TARGET_USER_ID,
      studentNo: '202101000904',
      passwordHash,
      nickname: '被举报用户丁',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      role: 'USER',
    },
  ])
  await scratch.insert(listings).values({
    id: LISTING_ID,
    sellerId: TARGET_USER_ID,
    title: '被举报商品',
    description: '用于举报闭环测试的商品',
    priceCents: 9900,
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

/** 带 session cookie 的 POST：`app.request(path, options)` 只接受一个 options，必须合并。 */
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
let reporterCookie: string
let secondReporterCookie: string

describe('举报闭环（#73 用户端）', () => {
  test('setup: login all accounts', async () => {
    adminCookie = await loginAs('202101000901')
    reporterCookie = await loginAs('202101000902')
    secondReporterCookie = await loginAs('202101000903')
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
        targetId: '01930000-0000-7000-8000-0000000000ff',
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
      postAs(reporterCookie, { targetType: 'USER', targetId: REPORTER_ID, reason: 'ABUSE' }),
    )
    expect(self.status).toBe(422)
    expect((await self.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'REPORT_SELF_TARGET' },
    })

    // LISTING 只能用商品类原因：HARASSMENT 是用户类原因，契约层就该拒。
    const mismatch = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, { targetType: 'LISTING', targetId: LISTING_ID, reason: 'HARASSMENT' }),
    )
    expect(mismatch.status).toBe(422)
    const body = (await mismatch.json()) as {
      error: { code: string; details?: { field: string }[] }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.[0]?.field).toBe('reason')
  })

  test('提交举报返回受理结果；同一举报人重复提交不新增（200 + created:false）', async () => {
    const first = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, {
        targetType: 'LISTING',
        targetId: LISTING_ID,
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
    // 用户端 DTO 不得泄漏处理原因（只对管理员可见）。
    expect(firstBody.report.handlingReason).toBeUndefined()

    const again = await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, { targetType: 'LISTING', targetId: LISTING_ID, reason: 'SPAM' }),
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
        targetId: LISTING_ID,
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
    expect(body.nextCursor).toBeNull()

    const other = await app.request(REPORT_ROUTES.mine, {
      headers: { cookie: secondReporterCookie },
    })
    const otherBody = (await other.json()) as { items: { reason: string }[] }
    expect(otherBody.items.map((item) => item.reason)).toEqual(['FRAUD'])
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

  test('普通用户碰举报详情也是 403；非 UUID 的 id 是 404 而不是 500', async () => {
    const detail = await app.request(
      ADMIN_ROUTES.reportDetail('01930000-0000-7000-8000-0000000000ff'),
      {
        headers: { cookie: reporterCookie },
      },
    )
    expect(detail.status).toBe(403)

    // 非 UUID 会在 pg uuid 列上炸出 `invalid input syntax`，路由层必须先拦成 404。
    // 曾经因为 requireTargetId 写在 try 里而 catch 只认 ReportServiceError，漏成 500。
    for (const path of [
      ADMIN_ROUTES.reportDetail('not-a-uuid'),
      ADMIN_ROUTES.reportHandle('not-a-uuid'),
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
        error: { code: 'ADMIN_NOT_FOUND' },
      })
    }
  })

  test('处理不存在的举报是 404 REPORT_NOT_FOUND（合法 UUID）', async () => {
    const res = await app.request(
      ADMIN_ROUTES.reportHandle('01930000-0000-7000-8000-0000000000ff'),
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
        report: { id: string; handlingReason: string | null }
        reporter: { nickname: string }
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
    }
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

    const [row] = await scratch.select().from(reports).where(eq(reports.id, reportId))
    expect(row).toMatchObject({ status: 'HANDLED', handledBy: ADMIN_ID })
    expect(row?.handledAt).toBeInstanceOf(Date)
    expect(row?.handlingReason).toBe('已核实，另行下架处理')

    const audit = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, reportId))
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
    await app.request(
      REPORT_ROUTES.create,
      postAs(secondReporterCookie, {
        targetType: 'USER',
        targetId: TARGET_USER_ID,
        reason: 'IMPERSONATION',
      }),
    )
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

    const audit = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, reportId))
    expect(audit.length).toBe(1)
  })

  test('审计写入失败时业务状态回滚（同一事务）：举报仍 PENDING，且无审计行', async () => {
    await app.request(
      REPORT_ROUTES.create,
      postAs(reporterCookie, { targetType: 'USER', targetId: TARGET_USER_ID, reason: 'ABUSE' }),
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

    const [row] = await scratch.select().from(reports).where(eq(reports.id, reportId))
    expect(row).toMatchObject({ status: 'PENDING', handledBy: null })
    expect(row?.handlingReason).toBeNull()
    const audit = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, reportId))
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
})
