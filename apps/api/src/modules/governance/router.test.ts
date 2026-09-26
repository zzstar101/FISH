import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES as PUBLIC_ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import { AdminOverviewSchema, AdminUserDetailSchema } from '@fish/contracts/admin/schema'
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { conversations } from '@fish/db/schema/conversations'
import { userRestrictions } from '@fish/db/schema/governance'
import { listings } from '@fish/db/schema/listings'
import { reports } from '@fish/db/schema/reports'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { SQL } from 'bun'
import { desc, eq, like, sql } from 'drizzle-orm'
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
// DB fixtures remain UUIDs; all admin request paths use their canonical public IDs.
const ADMIN_ROUTES = {
  ...PUBLIC_ADMIN_ROUTES,
  listingDelist: (id: string) =>
    PUBLIC_ADMIN_ROUTES.listingDelist(encodePublicId(PUBLIC_ID_PREFIX.listing, id)),
  listingRestore: (id: string) =>
    PUBLIC_ADMIN_ROUTES.listingRestore(encodePublicId(PUBLIC_ID_PREFIX.listing, id)),
  userRestrictPublish: (id: string) =>
    PUBLIC_ADMIN_ROUTES.userRestrictPublish(encodePublicId(PUBLIC_ID_PREFIX.user, id)),
  userBan: (id: string) => PUBLIC_ADMIN_ROUTES.userBan(encodePublicId(PUBLIC_ID_PREFIX.user, id)),
  userLiftRestriction: (id: string) =>
    PUBLIC_ADMIN_ROUTES.userLiftRestriction(encodePublicId(PUBLIC_ID_PREFIX.user, id)),
  userDetail: (id: string) =>
    PUBLIC_ADMIN_ROUTES.userDetail(encodePublicId(PUBLIC_ID_PREFIX.user, id)),
}

const SELLER = '01940000-0000-7000-8000-0000000000b1'
const OTHER = '01940000-0000-7000-8000-0000000000b2'
const ROLLBACK = '01940000-0000-7000-8000-0000000000d1'
/** 只看媒体写入口的封禁用例用户：与其它用例的用户分开，互不污染限制状态。 */
const RESTRICTED = '01940000-0000-7000-8000-0000000000b3'
/** 到期惰性用例专用用户：并发用例给 OTHER 留了一条生效中的 BAN，不能复用。 */
const EXPIRY = '01940000-0000-7000-8000-0000000000b4'
const LOCK_BAN = '01940000-0000-7000-8000-0000000000b5'
const LOCK_LIFT = '01940000-0000-7000-8000-0000000000b6'
const RACE_USER = '01940000-0000-7000-8000-0000000000b7'
const RACE_CONVERSATION = '01940000-0000-7000-8000-0000000000e7'
const LISTING = '01940000-0000-7000-8000-0000000000c1'
const RESERVED_LISTING = '01940000-0000-7000-8000-0000000000c2'
/** 引擎屏蔽用例专用商品：只改 moderationStatus，不碰 LISTING / RESERVED_LISTING 的状态。 */
const ROLLBACK_LISTING = '01940000-0000-7000-8000-0000000000c3'

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
    {
      id: RESTRICTED,
      studentNo: '202401000906',
      passwordHash,
      nickname: '媒体入口用例用户',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'USER',
    },
    {
      id: EXPIRY,
      studentNo: '202401000907',
      passwordHash,
      nickname: '到期用例用户',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'USER',
    },
    ...[LOCK_BAN, LOCK_LIFT, RACE_USER].map((id, index) => ({
      id,
      studentNo: `2024010009${String(index + 8).padStart(2, '0')}`,
      passwordHash,
      nickname: '跨锁到期用例用户',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      role: 'USER' as const,
    })),
  ])
  await scratch.insert(listings).values([
    {
      id: LISTING,
      listingNo: await reserveTestListingNo(scratch, LISTING),
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
      listingNo: await reserveTestListingNo(scratch, RESERVED_LISTING),
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
    {
      id: ROLLBACK_LISTING,
      listingNo: await reserveTestListingNo(scratch, ROLLBACK_LISTING),
      sellerId: ROLLBACK,
      title: '被引擎屏蔽的商品',
      description: '普通描述',
      priceCents: 3000,
      category: 'OTHER',
      condition: 'FAIR',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      createdAt: new Date('2026-10-02T00:00:00Z'),
    },
  ])
  await scratch.insert(conversations).values({
    id: RACE_CONVERSATION,
    listingId: LISTING,
    buyerId: RACE_USER,
    sellerId: SELLER,
  })
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
let otherCookie: string
let restrictedCookie: string
let expiryCookie: string
let raceCookie: string

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
  test('setup: login 五个账号', async () => {
    adminACookie = await loginAs('202401000901')
    adminBCookie = await loginAs('202401000902')
    sellerCookie = await loginAs('202401000903')
    otherCookie = await loginAs('202401000904')
    restrictedCookie = await loginAs('202401000906')
    expiryCookie = await loginAs('202401000907')
    raceCookie = await loginAs('202401000910')
    expect(adminACookie.length).toBeGreaterThan(0)
    expect(sellerCookie.length).toBeGreaterThan(0)
    expect(otherCookie.length).toBeGreaterThan(0)
    expect(restrictedCookie.length).toBeGreaterThan(0)
    expect(expiryCookie.length).toBeGreaterThan(0)
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

  for (const outcome of ['CANCELLED', 'COMPLETED'] as const) {
    test(`治理下架 RESERVED 后交易 ${outcome} 不解禁；恢复按交易终态还原商品`, async () => {
      const listingId = newId()
      const conversationId = newId()
      const transactionId = newId()
      await scratch.insert(listings).values({
        id: listingId,
        sellerId: SELLER,
        listingNo: await reserveTestListingNo(scratch, listingId),
        title: `交易${outcome}测试商品`,
        description: '治理交易交叉场景',
        priceCents: 5000,
        category: 'BOOKS',
        condition: 'GOOD',
        status: 'RESERVED',
        moderationStatus: 'APPROVED',
      })
      await scratch.insert(conversations).values({
        id: conversationId,
        listingId,
        buyerId: RACE_USER,
        sellerId: SELLER,
      })
      await scratch.insert(transactions).values({
        id: transactionId,
        listingId,
        buyerId: RACE_USER,
        sellerId: SELLER,
        amountCents: 5000,
      })

      const delisted = await app.request(
        ADMIN_ROUTES.listingDelist(listingId),
        post({ reason: '交易期间下架检查' }, adminACookie),
      )
      expect(delisted.status).toBe(200)
      if (outcome === 'CANCELLED') {
        const cancelled = await app.request(
          TRANSACTION_ROUTES.cancel(transactionId),
          post({}, raceCookie),
        )
        expect(cancelled.status).toBe(200)
      } else {
        const buyerConfirmed = await app.request(
          TRANSACTION_ROUTES.confirm(transactionId),
          post({}, raceCookie),
        )
        const sellerConfirmed = await app.request(
          TRANSACTION_ROUTES.confirm(transactionId),
          post({}, sellerCookie),
        )
        expect(buyerConfirmed.status).toBe(200)
        expect(sellerConfirmed.status).toBe(200)
      }
      const [during] = await scratch
        .select({
          status: listings.status,
          moderationStatus: listings.moderationStatus,
          governanceDelistedAt: listings.governanceDelistedAt,
        })
        .from(listings)
        .where(eq(listings.id, listingId))
      expect(during).toMatchObject({ status: 'OFFLINE', moderationStatus: 'BLOCKED' })
      expect(during?.governanceDelistedAt).not.toBeNull()

      const restored = await app.request(
        ADMIN_ROUTES.listingRestore(listingId),
        post({ reason: '交易终态后恢复' }, adminACookie),
      )
      expect(restored.status).toBe(200)
      const expected = outcome === 'CANCELLED' ? 'ACTIVE' : 'SOLD'
      expect(await restored.json()).toMatchObject({ listingStatus: expected })
      const [after] = await scratch
        .select({
          status: listings.status,
          moderationStatus: listings.moderationStatus,
          governanceDelistedAt: listings.governanceDelistedAt,
        })
        .from(listings)
        .where(eq(listings.id, listingId))
      expect(after).toEqual({
        status: expected,
        moderationStatus: 'APPROVED',
        governanceDelistedAt: null,
      })
    })
  }

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
    const [createdRestriction] = await restrictionRows(SELLER)
    expect(createdRestriction?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)

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

    const reported = await app.request(
      REPORT_ROUTES.create,
      post({ targetType: 'USER', targetId: OTHER, reason: 'ABUSE' }, sellerCookie),
    )
    expect(reported.status).toBe(403)
    expect(await reported.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
    expect(
      (await app.request(REPORT_ROUTES.mine, { headers: { cookie: sellerCookie } })).status,
    ).toBe(200)
  })

  test('解除限制:一条端点解除全部生效中的限制，各写一条审计', async () => {
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

  test('被封禁账号不能直调校园认证或手机号绑定写入口，认证状态仍可读', async () => {
    for (const path of [
      '/auth/verification/code',
      '/auth/verification/verify',
      '/auth/phone/bind',
    ]) {
      const response = await app.request(path, post({}, otherCookie))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
    }
    const status = await app.request('/auth/verification/status', {
      headers: { cookie: otherCookie },
    })
    expect(status.status).toBe(200)
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

  test('治理目标不存在 → 404；非法 TypeID → 404 而不是 500', async () => {
    const missing = await app.request(
      ADMIN_ROUTES.userBan('01940000-0000-7000-8000-0000000000ff'),
      post({ reason: '封禁不存在的人' }, adminACookie),
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'GOVERNANCE_TARGET_NOT_FOUND' } })

    const notUuid = await app.request(
      PUBLIC_ADMIN_ROUTES.userBan('not-a-uuid'),
      post({ reason: 'x' }, adminACookie),
    )
    expect(notUuid.status).toBe(404)
    expect(await notUuid.json()).toMatchObject({ error: { code: 'ADMIN_NOT_FOUND' } })
  })

  test('sourceReportId 传了但举报单不存在 → 404', async () => {
    const res = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post(
        {
          reason: '带不存在的举报单',
          sourceReportId: encodePublicId(
            PUBLIC_ID_PREFIX.report,
            '01940000-0000-7000-8000-0000000000ff',
          ),
        },
        adminACookie,
      ),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: { code: 'GOVERNANCE_SOURCE_REPORT_NOT_FOUND' },
    })
  })

  test('举报来源前缀错误在进入数据库前返回 422', async () => {
    const res = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post(
        { reason: '非法举报来源', sourceReportId: encodePublicId(PUBLIC_ID_PREFIX.user, OTHER) },
        adminACookie,
      ),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  test('处罚举报回链必须与商品或用户相关；错目标不留错误归因', async () => {
    const ownListingReport = newId()
    const otherListingReport = newId()
    const userReport = newId()
    const ownListingPublic = encodePublicId(PUBLIC_ID_PREFIX.report, ownListingReport)
    const otherListingPublic = encodePublicId(PUBLIC_ID_PREFIX.report, otherListingReport)
    const userPublic = encodePublicId(PUBLIC_ID_PREFIX.report, userReport)
    await scratch.insert(reports).values([
      {
        id: ownListingReport,
        reporterId: OTHER,
        targetType: 'LISTING',
        targetId: LISTING,
        reason: 'OTHER',
      },
      {
        id: otherListingReport,
        reporterId: OTHER,
        targetType: 'LISTING',
        targetId: RESERVED_LISTING,
        reason: 'OTHER',
      },
      {
        id: userReport,
        reporterId: OTHER,
        targetType: 'USER',
        targetId: RACE_USER,
        reason: 'OTHER',
      },
    ])

    const wrongDelist = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post({ reason: '错误举报来源', sourceReportId: otherListingPublic }, adminACookie),
    )
    expect(wrongDelist.status).toBe(422)
    expect(await wrongDelist.json()).toMatchObject({
      error: { code: 'GOVERNANCE_SOURCE_REPORT_MISMATCH' },
    })
    const wrongUser = await app.request(
      ADMIN_ROUTES.userRestrictPublish(RACE_USER),
      post({ reason: '商品 A 的卖家不是该用户', sourceReportId: ownListingPublic }, adminACookie),
    )
    expect(wrongUser.status).toBe(422)
    expect(await restrictionRows(RACE_USER)).toEqual([])

    const delisted = await app.request(
      ADMIN_ROUTES.listingDelist(LISTING),
      post({ reason: '关联本商品举报', sourceReportId: ownListingPublic }, adminACookie),
    )
    expect(delisted.status).toBe(200)
    const wrongRestore = await app.request(
      ADMIN_ROUTES.listingRestore(LISTING),
      post({ reason: '错误恢复来源', sourceReportId: otherListingPublic }, adminACookie),
    )
    expect(wrongRestore.status).toBe(422)
    const restored = await app.request(
      ADMIN_ROUTES.listingRestore(LISTING),
      post({ reason: '关联本商品举报恢复', sourceReportId: ownListingPublic }, adminACookie),
    )
    expect(restored.status).toBe(200)

    const restricted = await app.request(
      ADMIN_ROUTES.userRestrictPublish(RACE_USER),
      post({ reason: '关联被举报用户', sourceReportId: userPublic }, adminACookie),
    )
    expect(restricted.status).toBe(200)
    expect(await restricted.json()).toMatchObject({
      restriction: { sourceReportId: userPublic },
    })
    const lifted = await app.request(
      ADMIN_ROUTES.userLiftRestriction(RACE_USER),
      post({ reason: '关联被举报用户解除', sourceReportId: userPublic }, adminACookie),
    )
    expect(lifted.status).toBe(200)
  })

  test('Overview 的 active_restrictions 是全量 count，不是当前页条数', async () => {
    const res = await app.request(ADMIN_ROUTES.overview, { headers: { cookie: adminACookie } })
    expect(res.status).toBe(200)
    const body = AdminOverviewSchema.parse(await res.json())
    expect(body.activeRestrictions).toBeGreaterThanOrEqual(1)
  })

  /**
   * 到期惰性生效的闭环（评审 M1）。
   *
   * 部分唯一索引 `user_restrictions_active_user_type_uidx` 的谓词只有
   * `status = 'ACTIVE'`，写不了 `now()`（Postgres 要求索引谓词 immutable，而 now()
   * 只是 stable）。于是「已过期但没人碰过」的行会继续占着 (user, type) 槽位，
   * 出现三个症状：写守卫不认它（还好）、Overview 把它算成生效中（虚高）、
   * 再施加同类限制撞 23505 变成一句假的 409（管理端看不到任何限制却点不动）。
   * 这条用例把三件事一起钉住。
   */
  test('管理员不能创建已过期的封禁，失败后也不留下 ACTIVE 行或审计', async () => {
    const reason = '已到期的封禁不得成功'
    const response = await app.request(
      ADMIN_ROUTES.userBan(EXPIRY),
      post({ reason, expiresAt: new Date(Date.now() - 60_000).toISOString() }, adminACookie),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    expect(await restrictionRows(EXPIRY)).toEqual([])
    expect(
      await scratch
        .select({ id: adminAuditLogs.id })
        .from(adminAuditLogs)
        .where(eq(adminAuditLogs.reason, reason)),
    ).toEqual([])
  })

  test('等待用户行锁跨越到期边界：新封禁成功，解除已过期限制不冒充成功', async () => {
    const expiresAt = new Date(Date.now() + 2200)
    await scratch.insert(userRestrictions).values(
      [LOCK_BAN, LOCK_LIFT].map((userId) => ({
        userId,
        type: 'BAN' as const,
        status: 'ACTIVE' as const,
        reason: '等待时到期',
        actorUserId: ADMIN_A,
        expiresAt,
      })),
    )

    let banRequest: Promise<Response> | undefined
    let liftRequest: Promise<Response> | undefined
    await scratch.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id IN (${LOCK_BAN}, ${LOCK_LIFT}) FOR UPDATE`)
      banRequest = Promise.resolve(
        app.request(
          ADMIN_ROUTES.userBan(LOCK_BAN),
          post({ reason: '到期后重新封禁' }, adminACookie),
        ),
      )
      liftRequest = Promise.resolve(
        app.request(
          ADMIN_ROUTES.userLiftRestriction(LOCK_LIFT),
          post({ reason: '已到期不得被人工解除' }, adminACookie),
        ),
      )
      let waiters = 0
      for (let attempt = 0; attempt < 25; attempt++) {
        const [state] = await scratch.execute(sql`
          SELECT count(*)::int AS waiters FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM users WHERE id = %FOR UPDATE%'
        `)
        waiters = Number(state?.waiters ?? 0)
        if (waiters >= 2) break
        await Bun.sleep(30)
      }
      expect(waiters).toBeGreaterThanOrEqual(2)
      expect(Date.now()).toBeLessThan(expiresAt.getTime())
      await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now() + 180))
    })

    expect((await banRequest)?.status).toBe(200)
    expect((await liftRequest)?.status).toBe(409)
    const oldBan = (await restrictionRows(LOCK_BAN)).find((row) => row.reason === '等待时到期')
    expect(oldBan?.status).toBe('LIFTED')
    expect(oldBan?.liftedBy).toBeNull()
    expect(
      (await restrictionRows(LOCK_BAN)).find((row) => row.reason === '到期后重新封禁')?.status,
    ).toBe('ACTIVE')
    const [oldLift] = await restrictionRows(LOCK_LIFT)
    expect(oldLift?.status).toBe('ACTIVE')
    expect(oldLift?.liftedBy).toBeNull()
  })

  test('过期的限制不生效、不占唯一索引、不进 Overview 计数', async () => {
    const staleReason = '限时封禁，已到期'
    // 直接插一条「已过期但仍然 ACTIVE」的行：这正是只写 status 的索引留下的形状。
    await scratch.insert(userRestrictions).values({
      userId: EXPIRY,
      type: 'BAN',
      status: 'ACTIVE',
      reason: staleReason,
      actorUserId: ADMIN_A,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })

    // 1) 写守卫不认它：过期后仍能留言。
    const comment = await app.request(
      COMMENT_ROUTES.ofListing(LISTING),
      post({ content: '封禁已经到期了' }, expiryCookie),
    )
    expect(comment.status).toBe(201)

    // 2) Overview 的口径必须与写守卫 / service 一致：过期行不计入 active_restrictions。
    const before = await app.request(ADMIN_ROUTES.overview, {
      headers: { cookie: adminACookie },
    })
    const overviewBefore = AdminOverviewSchema.parse(await before.json())

    // 3) 再施加同类限制：同事务先把过期行标 LIFTED，再正常插入，而不是假的 409。
    const reban = await app.request(
      ADMIN_ROUTES.userBan(EXPIRY),
      post({ reason: '严重违规，再次封禁' }, adminACookie),
    )
    expect(reban.status).toBe(200)
    expect(await reban.json()).toMatchObject({ action: 'USER_BANNED' })

    const after = await app.request(ADMIN_ROUTES.overview, {
      headers: { cookie: adminACookie },
    })
    const overviewAfter = AdminOverviewSchema.parse(await after.json())
    expect(overviewAfter.activeRestrictions).toBe(overviewBefore.activeRestrictions + 1)

    // 过期行被标成 LIFTED 且 lifted_by 为空（区分「到期自动失效」与「管理员解除」），
    // 生效中的只剩刚施加的这一条。
    const rows = await restrictionRows(EXPIRY)
    const stale = rows.filter((row) => row.reason === staleReason)
    expect(stale.length).toBe(1)
    expect(stale[0]?.status).toBe('LIFTED')
    expect(stale[0]?.liftedBy).toBeNull()
    expect(rows.filter((row) => row.status === 'ACTIVE').length).toBe(1)

    // 自动失效不写审计（没有任何管理员动作发生）。
    const audit = await scratch
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.reason, staleReason))
    expect(audit.length).toBe(0)

    // 新的封禁真的生效：同一条留言入口现在被挡。
    const blocked = await app.request(
      COMMENT_ROUTES.ofListing(LISTING),
      post({ content: '刚被封禁还能说话吗' }, expiryCookie),
    )
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
  })

  /**
   * 媒体写入口也挂封禁守卫（评审 M2）。
   *
   * 封禁若只挡文字消息，被封用户仍能 `POST /:id/media/presign` + `POST /:id/media`
   * 发图 / 语音——「限制在服务端生效」就只在文字上成立。守卫挂在 UUID 校验与
   * 参数校验之前，所以用一个不存在的会话 id 也能验证到 403。
   */
  test('消息通过守卫后被写锁阻塞：封禁等待写入提交，随后新写入被拒绝', async () => {
    let sending: Promise<Response> | undefined
    let banning: Promise<Response> | undefined
    await scratch.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`)
      sending = Promise.resolve(
        app.request(
          CHAT_ROUTES.messages(RACE_CONVERSATION),
          post({ content: '封禁前已开始的消息' }, raceCookie),
        ),
      )
      let insertBlocked = false
      for (let attempt = 0; attempt < 30; attempt++) {
        const [state] = await scratch.execute(sql`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%INSERT INTO messages%') AS blocked
        `)
        insertBlocked = state?.blocked === true
        if (insertBlocked) break
        await Bun.sleep(30)
      }
      expect(insertBlocked).toBe(true)
      banning = Promise.resolve(
        app.request(
          ADMIN_ROUTES.userBan(RACE_USER),
          post({ reason: '聊天违规，封禁' }, adminACookie),
        ),
      )
      let banFinished = false
      banning.then(() => {
        banFinished = true
      })
      await Bun.sleep(150)
      expect(banFinished).toBe(false)
    })

    expect((await sending)?.status).toBe(201)
    expect((await banning)?.status).toBe(200)
    const denied = await app.request(
      CHAT_ROUTES.messages(RACE_CONVERSATION),
      post({ content: '封禁后不得提交' }, raceCookie),
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
  })

  test('封禁挡住媒体消息写入口（presign 与 create）', async () => {
    const ban = await app.request(
      ADMIN_ROUTES.userBan(RESTRICTED),
      post({ reason: '发违规图片，封禁' }, adminACookie),
    )
    expect(ban.status).toBe(200)

    const conversationId = '01940000-0000-7000-8000-0000000000ee'

    const presign = await app.request(
      `/conversations/${conversationId}/media/presign`,
      post({ kind: 'IMAGE', contentType: 'image/webp' }, restrictedCookie),
    )
    expect(presign.status).toBe(403)
    expect(await presign.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })

    const create = await app.request(
      `/conversations/${conversationId}/media`,
      post(
        { objectKey: 'chat-media/x.webp', mimeType: 'image/webp', sizeBytes: 100 },
        restrictedCookie,
      ),
    )
    expect(create.status).toBe(403)
    expect(await create.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
  })

  /**
   * 用户详情在目标用户**有生效中的限制**时也必须 200（对抗审查 F3）。
   *
   * store 返回的是 Date 对象，`AdminUserDetailSchema.activeRestrictions` 要的是 ISO
   * 字符串。漏掉这层转换时，ZodError 不是 AdminError，会一路逃到 app.onError 变成 500。
   * 而「契约字段存在的原因」恰恰是这个场景——治理按钮要靠它反映真实状态，
   * 于是最有用的那条查询正好是崩掉的那条。
   *
   * 放在本文件：这里才有真实的限制行（RESTRICTED 已被上面的用例封禁）。
   */
  test('有生效限制的用户详情返回 200 且带出 activeRestrictions', async () => {
    const res = await app.request(ADMIN_ROUTES.userDetail(RESTRICTED), {
      headers: { cookie: adminACookie },
    })
    expect(res.status).toBe(200)
    const body = AdminUserDetailSchema.parse(await res.json())
    expect(body.user.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, RESTRICTED))
    // 至少一条 BAN：上面的封禁用例刚给这个用户写了生效中的限制。
    expect(body.activeRestrictions.length).toBeGreaterThan(0)
    const ban = body.activeRestrictions.find((row) => row.type === 'BAN')
    expect(ban).toBeDefined()
    expect(ban?.expiresAt).toBeNull()
    expect(new Date(ban?.createdAt ?? '').getTime()).toBeGreaterThan(0)
  })

  /**
   * 治理 restore 只解治理下架，不解审核引擎的人工 BLOCKED（评审 M3）。
   *
   * 引擎屏蔽的商品 `moderation_status='BLOCKED'` 但没有 `governance_delisted_at`。
   * 如果 restore 认它，管理员就能用治理端点把违规内容放回公开列表，绕开人工审核，
   * 而且那条 `LISTING_RESTORED` 审计完全看不出它覆盖了引擎结论。
   */
  test('恢复被审核引擎屏蔽的商品 → 409 且不解除引擎屏蔽', async () => {
    await scratch
      .update(listings)
      .set({ moderationStatus: 'BLOCKED', moderatedAt: new Date() })
      .where(eq(listings.id, ROLLBACK_LISTING))

    const res = await app.request(
      ADMIN_ROUTES.listingRestore(ROLLBACK_LISTING),
      post({ reason: '这个不能恢复' }, adminACookie),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'GOVERNANCE_CONFLICT' } })

    // 商品保持引擎屏蔽，也没有被恢复回路改回 APPROVED。
    const [row] = await scratch
      .select({ status: listings.status, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, ROLLBACK_LISTING))
      .limit(1)
    expect(row).toEqual({ status: 'ACTIVE', moderationStatus: 'BLOCKED' })

    // 也没有留下一条「恢复了」的审计。
    const audit = await scratch
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, ROLLBACK_LISTING))
    expect(audit.length).toBe(0)
  })

  test('待审商品不能经治理下架；旧版待审下架恢复时保持 REVIEW', async () => {
    await scratch
      .update(listings)
      .set({ status: 'OFFLINE', moderationStatus: 'REVIEW' })
      .where(eq(listings.id, ROLLBACK_LISTING))
    const delist = await app.request(
      ADMIN_ROUTES.listingDelist(ROLLBACK_LISTING),
      post({ reason: '待审时尝试治理下架' }, adminACookie),
    )
    expect(delist.status).toBe(409)
    const [unchanged] = await scratch
      .select()
      .from(listings)
      .where(eq(listings.id, ROLLBACK_LISTING))
    expect(unchanged?.moderationStatus).toBe('REVIEW')
    expect(unchanged?.governanceDelistedAt).toBeNull()

    // 旧 #73 已存在的待审下架记录仍可恢复，但不能绕过审核变成 APPROVED。
    await scratch
      .update(listings)
      .set({ moderationStatus: 'BLOCKED', governanceDelistedAt: new Date() })
      .where(eq(listings.id, ROLLBACK_LISTING))
    await scratch.execute(sql`INSERT INTO admin_audit_logs
      (id, actor_user_id, action, target_type, target_id, before, after, reason)
      VALUES (${newId()}, ${ADMIN_A}, 'LISTING_DELISTED', 'LISTING', ${ROLLBACK_LISTING},
        jsonb_build_object('moderationStatus', 'REVIEW'),
        jsonb_build_object('priorListingStatus', 'OFFLINE'), '旧版治理下架')`)
    const restored = await app.request(
      ADMIN_ROUTES.listingRestore(ROLLBACK_LISTING),
      post({ reason: '恢复历史待审状态' }, adminACookie),
    )
    expect(restored.status).toBe(200)
    const [row] = await scratch.select().from(listings).where(eq(listings.id, ROLLBACK_LISTING))
    expect(row).toMatchObject({
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
      governanceDelistedAt: null,
    })
  })

  /** 商品下架是发布写入口：限制发布后卖家连自行下架都做不到（评审 m4）。 */
  test('限制发布后卖家不能自行下架商品', async () => {
    const restrict = await app.request(
      ADMIN_ROUTES.userRestrictPublish(SELLER),
      post({ reason: '频繁发布违规内容' }, adminBCookie),
    )
    expect(restrict.status).toBe(200)

    const offlined = await app.request(LISTING_ROUTES.offline(LISTING), post({}, sellerCookie))
    expect(offlined.status).toBe(403)
    expect(await offlined.json()).toMatchObject({ error: { code: 'USER_RESTRICTED' } })
  })

  /** 解除一个没有生效中限制的用户：409 而不是空手返回 200（另一管理员刚解除过）。 */
  test('解除没有生效中限制的用户 → 409', async () => {
    const res = await app.request(
      ADMIN_ROUTES.userLiftRestriction(ROLLBACK),
      post({ reason: '试着解除一个没有限制的人' }, adminACookie),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'GOVERNANCE_CONFLICT' } })

    const rows = await restrictionRows(ROLLBACK)
    expect(rows.length).toBe(0)
  })
})
