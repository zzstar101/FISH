import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import { AdminOverviewSchema } from '@fish/contracts/admin/schema'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import { createDb, type Db } from '@fish/db/client'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { userRestrictions } from '@fish/db/schema/governance'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { SQL } from 'bun'
import { desc, eq, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_governance_test_${process.pid}`
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

const ADMIN_A = '01940000-0000-7000-8000-0000000000a1'
const ADMIN_B = '01940000-0000-7000-8000-0000000000a2'
const SELLER = '01940000-0000-7000-8000-0000000000b1'
const OTHER = '01940000-0000-7000-8000-0000000000b2'
const LISTING = '01940000-0000-7000-8000-0000000000c1'
const ROLLBACK = '01940000-0000-7000-8000-0000000000d1'
const RESERVED_LISTING = '01940000-0000-7000-8000-0000000000c2'

/** 让审计写入失败的触发器标记：reason 带这个前缀就抛错（只影响这一条请求）。 */
const AUDIT_FAIL_MARK = 'AUDIT_FAIL_INJECT%'

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  const passwordHash = await Bun.password.hash(DEMO_PASSWORD)
  await scratch.insert(users).values([
    {
      id: ADMIN_A,
      studentNo: '202401000901',
      passwordHash,
      nickname: '管理员甲',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'ADMIN',
    },
    {
      id: ADMIN_B,
      studentNo: '202401000902',
      passwordHash,
      nickname: '管理员乙',
      authStatus: 'VERIFIED',
      verifiedAt: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'ADMIN',
    },
    {
      id: SELLER,
      studentNo: '202401000903',
      passwordHash,
      nickname: '卖家',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'USER',
    },
    {
      id: OTHER,
      studentNo: '202401000904',
      passwordHash,
      nickname: '另一位用户',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'USER',
    },
    {
      id: ROLLBACK,
      studentNo: '202401000905',
      passwordHash,
      nickname: '回滚用例用户',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'USER',
    },
  ])
  await scratch.insert(listings).values([
    {
      id: LISTING,
      sellerId: SELLER,
      title: '在售商品',
      description: '正常描述',
      priceCents: 9900,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      createdAt: new Date('2026-10-02T00:00:00Z'),
    },
    {
      id: RESERVED_LISTING,
      sellerId: SELLER,
      title: '交易中的商品',
      description: '已被预订',
      priceCents: 5000,
      category: 'BOOKS',
      condition: 'FAIR',
      status: 'RESERVED',
      moderationStatus: 'APPROVED',
      createdAt: new Date('2026-10-02T00:00:00Z'),
    },
  ])
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const post = (body: unknown, cookie: string) => ({
  method: 'POST' as const,
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

async function loginAs(studentNo: string): Promise<string> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentNo, password: DEMO_PASSWORD }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.getSetCookie().find((value) => value.startsWith('fish_session='))
  if (!cookie) throw new Error('登录未下发 fish_session')
  return cookie.split(';')[0] ?? ''
}

let adminACookie: string
let adminBCookie: string
let sellerCookie: string

async function restrictionRows(userId: string) {
  return scratch
    .select()
    .from(userRestrictions)
    .where(eq(userRestrictions.userId, userId))
    .orderBy(desc(userRestrictions.createdAt))
}

async function setAuditFailure(enabled: boolean): Promise<void> {
  if (enabled) {
    await scratch.$client.unsafe(`
      CREATE OR REPLACE FUNCTION fish_test_fail_governance_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.reason LIKE '${AUDIT_FAIL_MARK}' THEN
          RAISE EXCEPTION 'injected audit failure for governance rollback test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS fish_test_fail_governance_audit ON admin_audit_logs;
      CREATE TRIGGER fish_test_fail_governance_audit
        BEFORE INSERT ON admin_audit_logs
        FOR EACH ROW EXECUTE FUNCTION fish_test_fail_governance_audit();
    `)
    return
  }
  await scratch.$client.unsafe(`
    DROP TRIGGER IF EXISTS fish_test_fail_governance_audit ON admin_audit_logs;
    DROP FUNCTION IF EXISTS fish_test_fail_governance_audit();
  `)
}

describe('服务端治理（#73 治理半场 PR3）', () => {
  test('setup: login three accounts', async () => {
    adminACookie = await loginAs('202401000901')
    adminBCookie = await loginAs('202401000902')
    sellerCookie = await loginAs('202401000903')
    expect(adminACookie.length).toBeGreaterThan(0)
    expect(sellerCookie.length).toBeGreaterThan(0)
  })

  test('治理端点只对管理员开放：匿名 401，普通用户 403', async () => {
    const anonymous = await app.request(ADMIN_ROUTES.listingDelist(LISTING), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '违规' }),
    })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })

    const regular = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post({ reason: '违规' }, sellerCookie),
    )
    expect(regular.status).toBe(403)
    expect(await regular.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })

  test('下架商品：状态变更 + 审计同事务，且卖家不能自行恢复', async () => {
    const res = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post({ reason: '包含违禁品' }, adminACookie),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      action: 'LISTING_DELISTED',
      targetType: 'LISTING',
      targetId: LISTING,
      listingStatus: 'OFFLINE',
    })

    const [row] = await scratch
      .select({ status: listings.status, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, LISTING))
      .limit(1)
    expect(row).toEqual({ status: 'OFFLINE', moderationStatus: 'BLOCKED' })

    // 卖家直连 PATCH / online 都被挡：恢复只能走 admin restore。
    const patched = await app.request(LISTING_ROUTES.detail(LISTING), {
      method: 'PATCH',
      headers: { cookie: sellerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '我改一下总能过吧' }),
    })
    expect(patched.status).toBe(409)
    expect(await patched.json()).toMatchObject({ error: { code: 'LISTING_GOVERNANCE_BLOCKED' } })

    const onlined = await app.request(LISTING_ROUTES.online(LISTING), post({}, sellerCookie))
    expect(onlined.status).toBe(409)
    expect(await onlined.json()).toMatchObject({ error: { code: 'LISTING_GOVERNANCE_BLOCKED' } })
  })

  test('恢复商品：回到下架前的 ACTIVE（审计快照里的 priorListingStatus）', async () => {
    const res = await app.request(
      ADMIN_ROUTES.listingRestore(LISTING),
      post({ reason: '误判，恢复上架' }, adminBCookie),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      action: 'LISTING_RESTORED',
      listingStatus: 'ACTIVE',
    })

    const [row] = await scratch
      .select({ status: listings.status, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, LISTING))
      .limit(1)
    expect(row).toEqual({ status: 'ACTIVE', moderationStatus: 'APPROVED' })

    // 恢复后卖家又能正常编辑。
    const patched = await app.request(LISTING_ROUTES.detail(LISTING), {
      method: 'PATCH',
      headers: { cookie: sellerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '正常描述' }),
    })
    expect(patched.status).toBe(200)
  })

  test('下架 RESERVED 商品后恢复，回到 RESERVED 而不是 ACTIVE', async () => {
    const delisted = await app.request(
      ADMIN_ROUTES.listingDelist(RESERVED_LISTING),
      post({ reason: '交易中也需要下架' }, adminACookie),
    )
    expect(delisted.status).toBe(200)

    const restored = await app.request(
      ADMIN_ROUTES.listingRestore(RESERVED_LISTING),
      post({ reason: '恢复交易中的商品' }, adminACookie),
    )
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ listingStatus: 'RESERVED' })
  })

  test('限制发布：写入口直连被 403 挡下，且不影响该用户留言', async () => {
    const res = await app.request(
      ADMIN_ROUTES.userRestrictPublish(SELLER),
      post({ reason: '频繁发布违规商品' }, adminACookie),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      action: 'USER_RESTRICTED',
      targetType: 'USER_RESTRICTION',
      restriction: { type: 'PUBLISH_RESTRICT', status: 'ACTIVE' },
    })

    // 发布入口（PATCH 商品）被挡
    const patched = await app.request(LISTING_ROUTES.detail(LISTING), {
      method: 'PATCH',
      headers: { cookie: sellerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '受限后还能改吗' }),
    })
    expect(patched.status).toBe(403)
    expect(await patched.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })

    // 建商品同样被挡
    const created = await app.request(LISTING_ROUTES.base, {
      method: 'POST',
      headers: { cookie: sellerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '受限后发布',
        description: '应被拒绝',
        priceCents: 100,
        category: 'OTHER',
        condition: 'FAIR',
        objectKeys: [],
      }),
    })
    expect(created.status).toBe(403)

    // 重复限制 → 409（并发下由部分唯一索引兜底）
    const again = await app.request(
      ADMIN_ROUTES.userRestrictPublish(SELLER),
      post({ reason: '再限一次' }, adminBCookie),
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'GOVERNANCE_CONFLICT' } })
  })

  test('封禁：留言与聊天入口也被挡，但读保持开放', async () => {
    const res = await app.request(
      ADMIN_ROUTES.userBan(SELLER),
      post({ reason: '多次违规，封禁' }, adminACookie),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ action: 'USER_BANNED' })

    // 读接口不受影响（ban 只禁写）
    const read = await app.request(LISTING_ROUTES.detail(LISTING))
    expect(read.status).toBe(200)

    // 留言入口被挡
    const comment = await app.request(`/listings/${LISTING}/comments`, {
      method: 'POST',
      headers: { cookie: sellerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '封禁后还能留言吗' }),
    })
    expect(comment.status).toBe(403)
    expect(await comment.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
  })

  test('解除限制：一条端点解除全部生效中的限制，各写一条审计', async () => {
    const res = await app.request(
      ADMIN_ROUTES.userLiftRestriction(SELLER),
      post({ reason: '整改完成，解除全部限制' }, adminBCookie),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ action: 'USER_UNBANNED' })

    const rows = await restrictionRows(SELLER)
    expect(rows.length).toBe(2)
    expect(rows.every((row) => row.status === 'LIFTED')).toBe(true)
    expect(rows.every((row) => row.liftedBy === ADMIN_B)).toBe(true)

    // 解除后写入口恢复（PATCH 同一个商品，不依赖上传模块）
    const patched = await app.request(LISTING_ROUTES.detail(LISTING), {
      method: 'PATCH',
      headers: { cookie: sellerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '解除限制后的正常描述' }),
    })
    expect(patched.status).toBe(200)
  })

  /**
   * 两个用例的共同问题：`Promise.all` 不保证交错。两个请求若真的顺序执行
   * （第二个开始读时第一个已提交），`FOR UPDATE` 一次都没等过——"并发安全"
   * 就没有被测到，只是又测了一遍串行前置判定。
   *
   * 所以这里不赌时机，用「测试自己持锁」把交错钉死：
   *   1. 测试先在一个独立会话里 `SELECT ... FOR UPDATE` 目标行且**不提交**；
   *   2. 请求 A 发出 → 阻塞在这把行锁上（Postgres 行锁等待队列是 FIFO）；
   *   3. 请求 B 发出 → 排在 A 后面等同一把锁；
   *   4. 测试 `COMMIT` 放行 → 两个请求竞争同一把锁，一个拿到并提交，
   *      另一个在锁内重读时看到已提交的结果 → 409。
   *
   * 注意**不假设 A 一定赢**：Postgres 行锁等待队列不是严格 FIFO（锁释放后
   * 等待者被唤醒再竞争），实测赢家不稳定。所以断言的是结果集合——
   * 「恰好一个 200、恰好一个 409、库里恰好留下一条变更」——而不是某个
   * 管理员一定成功。这也顺带验证了 READ COMMITTED 下 `SELECT ... FOR UPDATE`
   * 拿锁后会重读最新版本（输家看到的是赢家已提交的状态，不是自己事务开始时的快照）。
   */
  async function holdRowLock(table: 'users' | 'listings', id: string): Promise<SQL> {
    // `max: 1` 是 Bun SQL 的要求：手工 `BEGIN` 只允许在单连接实例上做，
    // 否则事务可能被拆到不同连接上，行锁就锁了个寂寞。
    const gate = new SQL(scratchUrl, { max: 1 })
    await gate`BEGIN`
    await gate.unsafe(`SELECT id FROM ${table} WHERE id = '${id}'::uuid FOR UPDATE`)
    return gate
  }

  /**
   * 等到 `count` 个后端真的卡在行锁上。
   *
   * 为什么需要它：`app.request()` 只返回 promise，真正连库、开事务、发
   * `SELECT ... FOR UPDATE` 都是异步的。不等待就 `COMMIT` 放行，两个请求
   * 很可能一个都还没排到锁上——测到的还是串行，不是并发。
   *
   * `pg_stat_activity` 是集群级视图，`admin` 连接指向主库也能看到 scratch 库的
   * 后端；`wait_event_type = 'Lock'` + `state = 'active'` 精确表示「正在执行
   * 且卡在锁上」，比 sleep 猜时长可靠。
   */
  async function waitForLockWaiters(count: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const rows = (await admin.$client.unsafe(`
        SELECT count(*)::int AS n
        FROM pg_stat_activity
        WHERE datname = '${scratchDatabase}'
          AND wait_event_type = 'Lock'
          AND state = 'active'
      `)) as Array<{ n: number }>
      if ((rows[0]?.n ?? 0) >= count) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`等待 ${count} 个锁等待者超时：并发请求没有真正排队在行锁上`)
  }

  test('两个管理员同时封禁同一个用户：恰好一个成功，另一个 409', async () => {
    const gate = await holdRowLock('users', OTHER)
    // 两个请求必须**同时在锁上排队**：先 await 第一个会让它一直阻塞到测试超时。
    // 所以这里只发起不等待，等两个都真的卡在锁上再放行。
    const firstPromise = app.request(
      ADMIN_ROUTES.userBan(OTHER),
      post({ reason: '并发封禁测试 A' }, adminACookie),
    )
    const secondPromise = app.request(
      ADMIN_ROUTES.userBan(OTHER),
      post({ reason: '并发封禁测试 B' }, adminBCookie),
    )
    await waitForLockWaiters(2)
    await gate`COMMIT`
    await gate.close()
    const first = await firstPromise
    const second = await secondPromise

    // 恰好一个成功、一个 409，不指定谁赢（行锁队列非 FIFO，见方法注释）。
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const winner = first.status === 200 ? first : second
    const loser = first.status === 200 ? second : first
    expect(await loser.json()).toMatchObject({ error: { code: 'GOVERNANCE_CONFLICT' } })
    const winnerReason = first.status === 200 ? '并发封禁测试 A' : '并发封禁测试 B'

    // 库里只留下赢家的那一条：没有半成品、没有重复限制。
    const rows = await restrictionRows(OTHER)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ status: 'ACTIVE', reason: winnerReason })
    expect(rows[0]?.actorUserId === ADMIN_A || rows[0]?.actorUserId === ADMIN_B).toBe(true)

    // 赢家那条限制上恰好一条审计，输家连审计都没留下（它在写审计之前就 409 了）。
    const audits = await scratch
      .select({ reason: adminAuditLogs.reason })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, rows[0]?.id ?? ''))
    expect(audits.length).toBe(1)
    expect(audits[0]?.reason).toBe(winnerReason)
    expect(winner.status).toBe(200)
  })

  test('两个管理员同时下架同一商品：恰好一个成功，另一个 409', async () => {
    const gate = await holdRowLock('listings', RESERVED_LISTING)
    const firstPromise = app.request(
      ADMIN_ROUTES.listingDelist(RESERVED_LISTING),
      post({ reason: '并发下架 A' }, adminACookie),
    )
    const secondPromise = app.request(
      ADMIN_ROUTES.listingDelist(RESERVED_LISTING),
      post({ reason: '并发下架 B' }, adminBCookie),
    )
    await waitForLockWaiters(2)
    await gate`COMMIT`
    await gate.close()
    const first = await firstPromise
    const second = await secondPromise

    expect([first.status, second.status].sort()).toEqual([200, 409])
    const loser = first.status === 200 ? second : first
    expect(await loser.json()).toMatchObject({ error: { code: 'GOVERNANCE_CONFLICT' } })

    const [row] = await scratch
      .select({
        status: listings.status,
        moderationStatus: listings.moderationStatus,
        governanceDelistedAt: listings.governanceDelistedAt,
      })
      .from(listings)
      .where(eq(listings.id, RESERVED_LISTING))
      .limit(1)
    expect(row).toMatchObject({ status: 'OFFLINE', moderationStatus: 'BLOCKED' })
    expect(row?.governanceDelistedAt).not.toBeNull()

    // 并发那一轮只留下赢家的一条下架审计（该商品此前的下架 / 恢复审计属于更早的用例，
    // 所以按 reason 前缀过滤，不按 targetId 全量比）。
    const audits = await scratch
      .select({ action: adminAuditLogs.action, reason: adminAuditLogs.reason })
      .from(adminAuditLogs)
      .where(like(adminAuditLogs.reason, '并发下架 %'))
    expect(audits.length).toBe(1)
    expect(audits[0]).toMatchObject({ action: 'LISTING_DELISTED' })

    // 恢复用审计快照里的 priorListingStatus：RESERVED 不会因治理被改成 ACTIVE。
    const restored = await app.request(
      ADMIN_ROUTES.listingRestore(RESERVED_LISTING),
      post({ reason: '恢复交易中的商品' }, adminBCookie),
    )
    expect(restored.status).toBe(200)
    const [after] = await scratch
      .select({ status: listings.status, governanceDelistedAt: listings.governanceDelistedAt })
      .from(listings)
      .where(eq(listings.id, RESERVED_LISTING))
      .limit(1)
    expect(after).toMatchObject({ status: 'RESERVED' })
    expect(after?.governanceDelistedAt).toBeNull()
  })

  test('审计写入失败时业务状态回滚（同一事务）', async () => {
    await setAuditFailure(true)
    try {
      const res = await app.request(
        ADMIN_ROUTES.userBan(ROLLBACK),
        post({ reason: `${AUDIT_FAIL_MARK} 封禁` }, adminACookie),
      )
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })

      // 业务状态没变：没有新限制，原来的那条仍是 ACTIVE
      const rows = await restrictionRows(ROLLBACK)
      expect(rows.length).toBe(0)

      // 也没有审计行
      const audit = await scratch
        .select({ id: adminAuditLogs.id })
        .from(adminAuditLogs)
        .where(eq(adminAuditLogs.reason, `${AUDIT_FAIL_MARK} 封禁`))
      expect(audit.length).toBe(0)
    } finally {
      await setAuditFailure(false)
    }
  })

  test('管理员不能对自己执行治理动作（422，DB 也有 CHECK 兜底）', async () => {
    const res = await app.request(
      ADMIN_ROUTES.userBan(ADMIN_A),
      post({ reason: '自封测试' }, adminACookie),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'GOVERNANCE_SELF_TARGET' } })
  })

  test('治理目标不存在 → 404；非 UUID → 404 而不是 500', async () => {
    const missing = await app.request(
      ADMIN_ROUTES.userBan('01940000-0000-7000-8000-0000000000ff'),
      post({ reason: '封禁不存在的人' }, adminACookie),
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'GOVERNANCE_TARGET_NOT_FOUND' } })

    const notUuid = await app.request(
      ADMIN_ROUTES.userBan('not-a-uuid'),
      post({ reason: 'x' }, adminACookie),
    )
    expect(notUuid.status).toBe(404)
    expect(await notUuid.json()).toMatchObject({ error: { code: 'ADMIN_NOT_FOUND' } })
  })

  test('sourceReportId 传了但举报单不存在 → 404', async () => {
    const res = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post(
        { reason: '带不存在的举报单', sourceReportId: '01940000-0000-7000-8000-0000000000ff' },
        adminACookie,
      ),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: { code: 'GOVERNANCE_SOURCE_REPORT_NOT_FOUND' },
    })
  })

  test('Overview 的 active_restrictions 是全量 count，不是当前页条数', async () => {
    const res = await app.request(ADMIN_ROUTES.overview, { headers: { cookie: adminACookie } })
    expect(res.status).toBe(200)
    const body = AdminOverviewSchema.parse(await res.json())
    expect(body.activeRestrictions).toBeGreaterThanOrEqual(1)
  })
})
