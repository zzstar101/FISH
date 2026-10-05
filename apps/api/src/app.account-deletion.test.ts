import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { userRestrictions } from '@fish/db/schema/governance'
import { listings } from '@fish/db/schema/listings'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** scratch 库模式（与 app.favorites.test.ts 一致）：注销是全局状态变更，隔离库才能断言精确行数。 */
const scratchDatabase = `fish_account_deletion_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

const DELETION_PATH = '/me/account-deletion'
const CONFIRMATION = '注销账号'
const COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

type Session = { cookie: string; userId: string; studentNo: string }

let studentSerial = 0

/** 学号唯一且必须满 12 位数字（`StudentNoSchema` 是 `/^\d{12}$/`），pid 段补足 4 位。 */
function nextStudentNo(): string {
  return `2022${String(process.pid % 10000).padStart(4, '0')}${String(studentSerial++).padStart(4, '0')}`
}

async function register(nickname: string): Promise<Session> {
  const studentNo = nextStudentNo()
  const response = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentNo, password: 'fish123456', nickname }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  return {
    cookie: cookieOf(response),
    userId: decodePublicId(PUBLIC_ID_PREFIX.user, body.user.id),
    studentNo,
  }
}

async function login(studentNo: string): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentNo, password: 'fish123456' }),
  })
  expect(response.status).toBe(200)
  return cookieOf(response)
}

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

async function createListing(
  sellerId: string,
  status: 'ACTIVE' | 'SOLD' | 'RESERVED' | 'OFFLINE' = 'ACTIVE',
): Promise<string> {
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

/** 收藏入口要的是对外 id（`listing_xxx`），不是库里的 uuid。 */
function favoritePath(listingId: string): string {
  return `/listings/${encodePublicId(PUBLIC_ID_PREFIX.listing, listingId)}/favorite`
}

/**
 * 第三方在架商品：写入口探针不能用「自己的商品」——
 * 收藏自己的商品另有业务规则（403），会把「写被拦」的断言污染成假阳性。
 */
async function createForeignActiveListing(): Promise<string> {
  const owner = await register('探针卖家')
  return createListing(owner.userId, 'ACTIVE')
}

async function createPendingTransaction(
  listingId: string,
  buyerId: string,
  sellerId: string,
): Promise<void> {
  await db.insert(transactions).values({
    id: newId(),
    listingId,
    buyerId,
    sellerId,
    amountCents: 16000,
    status: 'PENDING_MEETUP',
  })
}

async function listingStatusOf(listingId: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: listings.status })
    .from(listings)
    .where(eq(listings.id, listingId))
  return rows[0]?.status
}

async function accountStatusOf(userId: string): Promise<string | undefined> {
  const rows = await db
    .select({ accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, userId))
  return rows[0]?.accountStatus
}

type DeletionStatus = {
  status: string
  requestedAt: string | null
  purgeScheduledAt: string | null
  offlinedListingCount?: number
}

async function readStatus(cookie: string): Promise<DeletionStatus> {
  const response = await app.request(DELETION_PATH, { headers: { cookie } })
  expect(response.status).toBe(200)
  return (await response.json()) as DeletionStatus
}

async function requestDeletion(cookie: string): Promise<{ status: number; body: unknown }> {
  const response = await app.request(DELETION_PATH, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: CONFIRMATION }),
  })
  return { status: response.status, body: await response.json() }
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

describe('app 级接线：注销端点要求登录', () => {
  test('三个方法匿名都 401 UNAUTHENTICATED', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await app.request(DELETION_PATH, { method })
      expect(response.status).toBe(401)
      expect(await errorCodeOf(response)).toBe('UNAUTHENTICATED')
    }
  })
})

describe('完整注销闭环：申请 → 冷静期 → 撤回', () => {
  test('初始状态是 ACTIVE 且两个时间戳为空', async () => {
    const session = await register('初始状态')
    expect(await readStatus(session.cookie)).toEqual({
      status: 'ACTIVE',
      requestedAt: null,
      purgeScheduledAt: null,
    })
  })

  test('确认串不对 422，且状态不变（不会因为手滑就进冷静期）', async () => {
    const session = await register('确认串')
    const response = await app.request(DELETION_PATH, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: '注销' }),
    })
    expect(response.status).toBe(422)
    expect(await errorCodeOf(response)).toBe('VALIDATION_FAILED')
    expect((await readStatus(session.cookie)).status).toBe('ACTIVE')
    expect(await accountStatusOf(session.userId)).toBe('ACTIVE')
  })

  test('申请成功：进冷静期、下架在架商品、撤销其它会话、保留当前会话、写被拦、读不受影响', async () => {
    const session = await register('申请成功')
    const otherCookie = await login(session.studentNo)
    const activeListing = await createListing(session.userId, 'ACTIVE')
    const reservedListing = await createListing(session.userId, 'RESERVED')
    const soldListing = await createListing(session.userId, 'SOLD')
    const probeListing = await createForeignActiveListing()

    const before = new Date()
    const { status, body } = await requestDeletion(session.cookie)
    expect(status).toBe(200)
    const applied = body as DeletionStatus
    expect(applied.status).toBe('DELETION_REQUESTED')
    expect(applied.offlinedListingCount).toBe(2)
    const requestedAt = new Date(applied.requestedAt ?? '')
    const purgeScheduledAt = new Date(applied.purgeScheduledAt ?? '')
    expect(requestedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    expect(purgeScheduledAt.getTime() - requestedAt.getTime()).toBe(COOLING_OFF_MS)

    // 在架 / 预约中下架；已成交保留（历史证据不能被抹掉）。
    expect(await listingStatusOf(activeListing)).toBe('OFFLINE')
    expect(await listingStatusOf(reservedListing)).toBe('OFFLINE')
    expect(await listingStatusOf(soldListing)).toBe('SOLD')

    // 其它会话被撤销，当前会话保留（要能看状态、能撤回）。
    const otherSession = await app.request('/me', { headers: { cookie: otherCookie } })
    expect(otherSession.status).toBe(401)
    // GET 只回状态本身（下架数只在申请响应里出现），这里对齐三个共享字段。
    const current = await readStatus(session.cookie)
    expect(current.status).toBe(applied.status)
    expect(current.requestedAt).toBe(applied.requestedAt)
    expect(current.purgeScheduledAt).toBe(applied.purgeScheduledAt)

    // 写被拦：收藏是「本来会成功」的写入口（第三方在架商品），证明拦的是写而不是路径/业务规则。
    const blocked = await app.request(favoritePath(probeListing), {
      method: 'POST',
      headers: { cookie: session.cookie },
    })
    expect(blocked.status).toBe(403)
    expect(await errorCodeOf(blocked)).toBe('ACCOUNT_DELETION_PENDING')

    // 读不受影响。
    const me = await app.request('/me', { headers: { cookie: session.cookie } })
    expect(me.status).toBe(200)

    // 重复申请幂等：时间戳不重置（否则反复点就能无限延长冷静期），下架数归零。
    const again = await requestDeletion(session.cookie)
    expect(again.status).toBe(200)
    const repeated = again.body as DeletionStatus
    expect(repeated.requestedAt).toBe(applied.requestedAt)
    expect(repeated.purgeScheduledAt).toBe(applied.purgeScheduledAt)
    expect(repeated.offlinedListingCount).toBe(0)
  })

  test('撤回：回到 ACTIVE、清空时间戳、写恢复，但商品不会自动重新上架', async () => {
    const session = await register('撤回')
    const listingId = await createListing(session.userId, 'ACTIVE')
    const probeListing = await createForeignActiveListing()
    const { status } = await requestDeletion(session.cookie)
    expect(status).toBe(200)
    expect(await listingStatusOf(listingId)).toBe('OFFLINE')

    const blocked = await app.request(favoritePath(probeListing), {
      method: 'POST',
      headers: { cookie: session.cookie },
    })
    expect(blocked.status).toBe(403)

    const withdrawn = await app.request(DELETION_PATH, {
      method: 'DELETE',
      headers: { cookie: session.cookie },
    })
    expect(withdrawn.status).toBe(200)
    expect((await withdrawn.json()) as DeletionStatus).toEqual({
      status: 'ACTIVE',
      requestedAt: null,
      purgeScheduledAt: null,
    })
    expect(await accountStatusOf(session.userId)).toBe('ACTIVE')

    // 写恢复：同一个收藏入口从 403 变回 200。
    const write = await app.request(favoritePath(probeListing), {
      method: 'POST',
      headers: { cookie: session.cookie },
    })
    expect(write.status).toBe(200)
    // 商品保持下架：注销申请已经产生过真实副作用，撤回不假装什么都没发生。
    expect(await listingStatusOf(listingId)).toBe('OFFLINE')
  })

  test('撤回后可以重新申请，拿到新的冷静期起点', async () => {
    const session = await register('重新申请')
    const first = (await requestDeletion(session.cookie)).body as DeletionStatus
    await app.request(DELETION_PATH, { method: 'DELETE', headers: { cookie: session.cookie } })
    const second = (await requestDeletion(session.cookie)).body as DeletionStatus
    expect(second.status).toBe('DELETION_REQUESTED')
    expect(new Date(second.requestedAt ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(first.requestedAt ?? '').getTime(),
    )
    expect(second.purgeScheduledAt).not.toBe(first.purgeScheduledAt)
  })

  test('未申请注销时撤回是无副作用 noop', async () => {
    const session = await register('无申请撤回')
    const response = await app.request(DELETION_PATH, {
      method: 'DELETE',
      headers: { cookie: session.cookie },
    })
    expect(response.status).toBe(200)
    expect((await response.json()) as DeletionStatus).toEqual({
      status: 'ACTIVE',
      requestedAt: null,
      purgeScheduledAt: null,
    })
  })
})

describe('注销资格校验', () => {
  test('有未完成交易（卖家侧）409，回报对方昵称，且商品没有被下架（事务回滚）', async () => {
    const seller = await register('未完成卖家')
    const buyer = await register('未完成买家')
    const listingId = await createListing(seller.userId, 'ACTIVE')
    await createPendingTransaction(listingId, buyer.userId, seller.userId)

    const { status, body } = await requestDeletion(seller.cookie)
    expect(status).toBe(409)
    const error = body as { error: { code: string; message: string } }
    expect(error.error.code).toBe('ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION')
    expect(error.error.message).toContain('未完成交易')
    expect(error.error.message).toContain('未完成买家')

    // 关键：拦截发生在同一个事务里，下架必须一起回滚。
    expect(await listingStatusOf(listingId)).toBe('ACTIVE')
    expect(await accountStatusOf(seller.userId)).toBe('ACTIVE')
  })

  test('有未完成交易（买家侧）同样 409', async () => {
    const seller = await register('买家侧卖家')
    const buyer = await register('买家侧买家')
    const listingId = await createListing(seller.userId, 'RESERVED')
    await createPendingTransaction(listingId, buyer.userId, seller.userId)

    const { status, body } = await requestDeletion(buyer.cookie)
    expect(status).toBe(409)
    expect((body as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION',
    )
  })

  test('已完成的交易不阻塞注销', async () => {
    const seller = await register('已完成卖家')
    const buyer = await register('已完成买家')
    const listingId = await createListing(seller.userId, 'SOLD')
    await db.insert(transactions).values({
      id: newId(),
      listingId,
      buyerId: buyer.userId,
      sellerId: seller.userId,
      amountCents: 16000,
      status: 'COMPLETED',
      completedAt: new Date(),
    })

    const { status } = await requestDeletion(seller.cookie)
    expect(status).toBe(200)
    expect(await listingStatusOf(listingId)).toBe('SOLD')
  })

  test('封禁生效中 403，不能靠注销逃掉封禁', async () => {
    const banned = await register('被封禁')
    const actor = await register('管理员演员')
    await db.insert(userRestrictions).values({
      id: newId(),
      userId: banned.userId,
      type: 'BAN',
      status: 'ACTIVE',
      reason: '注销验收：模拟封禁',
      actorUserId: actor.userId,
    })

    const { status, body } = await requestDeletion(banned.cookie)
    expect(status).toBe(403)
    expect((body as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETION_BLOCKED_BANNED')
    expect(await accountStatusOf(banned.userId)).toBe('ACTIVE')
  })

  test('已解除的封禁不阻塞注销', async () => {
    const lifted = await register('已解封')
    const actor = await register('管理员演员二')
    await db.insert(userRestrictions).values({
      id: newId(),
      userId: lifted.userId,
      type: 'BAN',
      status: 'LIFTED',
      reason: '注销验收：已解除封禁',
      actorUserId: actor.userId,
      liftedAt: new Date(),
      liftedBy: actor.userId,
    })

    const { status } = await requestDeletion(lifted.cookie)
    expect(status).toBe(200)
  })
})

describe('双账号隔离', () => {
  test('A 进冷静期不影响 B：B 仍能写、商品仍在上架、状态仍 ACTIVE', async () => {
    const a = await register('隔离A')
    const b = await register('隔离B')
    const bListing = await createListing(b.userId, 'ACTIVE')
    const probeListing = await createForeignActiveListing()

    expect((await requestDeletion(a.cookie)).status).toBe(200)

    expect((await readStatus(b.cookie)).status).toBe('ACTIVE')
    const bWrite = await app.request(favoritePath(probeListing), {
      method: 'POST',
      headers: { cookie: b.cookie },
    })
    expect(bWrite.status).toBe(200)
    expect(await listingStatusOf(bListing)).toBe('ACTIVE')
    // A 的会话被撤销的只有「其它会话」，B 的会话完全不受影响。
    expect((await app.request('/me', { headers: { cookie: b.cookie } })).status).toBe(200)
  })
})

describe('写拦截的作用域', () => {
  test('同一个写入口：ACTIVE 账号 200，进冷静期后 403，撤回后又是 200', async () => {
    const session = await register('作用域')
    const probeListing = await createForeignActiveListing()
    const write = () =>
      app.request(favoritePath(probeListing), {
        method: 'POST',
        headers: { cookie: session.cookie },
      })

    // 这里守的是「写拦截只对 DELETION_REQUESTED 生效」：漏掉状态判断的实现
    // 会让所有正常账号的第一笔写就 403，而只测注销态的用例完全看不出来。
    expect((await write()).status).toBe(200)
    expect((await requestDeletion(session.cookie)).status).toBe(200)
    expect((await write()).status).toBe(403)
    await app.request(DELETION_PATH, { method: 'DELETE', headers: { cookie: session.cookie } })
    expect((await write()).status).toBe(200)
  })
})

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 冷静期内仍放行的写入口（与 `write-policy.ts` 白名单同源）。 */
const ALLOWED_WHILE_PENDING = new Set([
  'POST /me/account-deletion',
  'DELETE /me/account-deletion',
  'POST /auth/wechat/scan/ticket/:ticket/confirm',
])

/**
 * 不挂 `requireAuth` 的公开写入口。没有登录态就无从谈起「注销态写拦截」，
 * 所以它们只能被显式列在这里 —— 新增公开写入口必须改这份清单，改动会在评审里显形。
 *
 * 这份清单**必须靠事实说话**：写多一条（把其实挂了 `requireAuth` 的入口列进来）就等于
 * 给那条路由开了拦截盲区，而枚举测试会安静地跳过它。下面那条「每一条都真的没挂
 * requireAuth」的用例就是反过来验证豁免资格的 —— `POST /reports`、`POST /uploads/presign`、
 * `POST /uploads/confirm` 曾被我误列在这里，实测它们都走过 `requireAuth`（冷静期内回
 * 403 `ACCOUNT_DELETION_PENDING`），已移出。
 */
const PUBLIC_WRITE_ROUTES = new Set([
  'POST /auth/login',
  'POST /auth/register',
  'POST /auth/logout',
  'POST /auth/wechat/session',
  'POST /auth/wechat/scan/ticket',
  'POST /auth/wechat/scan/ticket/:ticket/exchange',
  'POST /recommendations/events',
  'POST /visual-search',
  'POST /visual-search/uploads',
])

const DUMMY_ID = '01990000-0000-7000-8000-00000000dead'

describe('写拦截的自维护清单', () => {
  test('冷静期内：除白名单外，所有非 GET 路由都必须是 403 ACCOUNT_DELETION_PENDING', async () => {
    const session = await register('枚举写入口')
    expect((await requestDeletion(session.cookie)).status).toBe(200)

    const routes = new Map<string, string>()
    for (const route of app.routes) {
      if (SAFE_METHODS.has(route.method) || route.method === 'ALL') continue
      // 参数段用假 id 填实：路径能匹配上，拦截才会发生在 requireAuth 而不是 404。
      routes.set(`${route.method} ${route.path}`, route.path.replace(/:[^/]+/g, DUMMY_ID))
    }
    expect(routes.size).toBeGreaterThan(30)

    const notBlocked: string[] = []
    for (const [key, path] of routes) {
      if (ALLOWED_WHILE_PENDING.has(key) || PUBLIC_WRITE_ROUTES.has(key)) continue
      const response = await app.request(path, {
        method: key.slice(0, key.indexOf(' ')),
        headers: { cookie: session.cookie },
      })
      if (response.status !== 403) {
        notBlocked.push(`${key} → ${response.status}`)
        continue
      }
      expect(await errorCodeOf(response)).toBe('ACCOUNT_DELETION_PENDING')
    }
    expect(notBlocked).toEqual([])
  })

  test('公开写入口清单没有过期项：每个 key 都仍是一条真实路由', async () => {
    const known = new Set(app.routes.map((route) => `${route.method} ${route.path}`))
    const stale = [...PUBLIC_WRITE_ROUTES, ...ALLOWED_WHILE_PENDING].filter(
      (key) => !known.has(key),
    )
    expect(stale).toEqual([])
  })

  /**
   * 上一份清单是**手写的豁免单**：写错一条（把其实挂了 `requireAuth` 的入口列进"公开"）
   * 就等于给那条路由开了拦截盲区，而枚举测试会安静地跳过它。所以这里反过来验证豁免资格：
   * 带着冷静期内的 cookie 打过去，凡是回 403 `ACCOUNT_DELETION_PENDING` 的，说明它走过了
   * `requireAuth`，根本不该被豁免。
   */
  test('公开写入口清单里的每一条都真的没挂 requireAuth', async () => {
    const wronglyExempt: string[] = []
    // 每条入口用**独立**的冷静期会话：`POST /auth/logout` 就在这份清单里，
    // 共用一条 cookie 会让它之后的请求全部退化成匿名 401，测不出真实归属。
    for (const key of PUBLIC_WRITE_ROUTES) {
      const [method, path] = key.split(' ') as [string, string]
      const session = await register('豁免单核对')
      expect((await requestDeletion(session.cookie)).status).toBe(200)

      const response = await app.request(path.replace(/:[^/]+/g, DUMMY_ID), {
        method,
        headers: { cookie: session.cookie },
      })
      if (response.status === 403 && (await errorCodeOf(response)) === 'ACCOUNT_DELETION_PENDING') {
        wronglyExempt.push(key)
      }
    }
    expect(wronglyExempt).toEqual([])
  })
})

describe('会话与注销态的一致性', () => {
  test('撤回后旧会话不会被复活：被撤销的会话仍然 401', async () => {
    const session = await register('撤销后撤回')
    const otherCookie = await login(session.studentNo)
    expect((await requestDeletion(session.cookie)).status).toBe(200)
    await app.request(DELETION_PATH, { method: 'DELETE', headers: { cookie: session.cookie } })

    // 会话是删行而不是置无效标记：撤回不会把已经删掉的会话变回来。
    expect((await app.request('/me', { headers: { cookie: otherCookie } })).status).toBe(401)
    expect((await app.request('/me', { headers: { cookie: session.cookie } })).status).toBe(200)
  })
})
