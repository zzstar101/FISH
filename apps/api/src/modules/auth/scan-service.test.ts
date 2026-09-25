import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { loginTickets } from '@fish/db/schema/login-tickets'
import { sessions as sessionsTable } from '@fish/db/schema/sessions'
import { users } from '@fish/db/schema/users'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { AuthError } from './errors'
import { createScanTicketService } from './scan-service'
import {
  createScanTicketStore,
  SCAN_TICKET_CLEANUP_LIMIT,
  SCAN_TICKET_RETENTION_MS,
} from './scan-store'
import { createSessions } from './session'

/**
 * 扫码登录票据流程（#197 T2/T4）的集成测试。
 *
 * 为什么必须是真库：这段代码的正确性几乎全在**并发语义**与**过期判定**上——确认不能被
 * 改绑、兑换只能签发一份会话、过期一律以数据库时间 `now()` 为准——这些用内存桩证明不了。
 * 沿用 `router.test.ts` 的做法：自建 scratch 库 + 跑真实 migration。
 *
 * 时间不靠伪造时钟：过期一律通过把行上的 `expires_at` 改到过去来构造，这样测的就是
 * 真实实现所用的那套数据库时间语义。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_scan_test_${process.pid}`
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
let service: ReturnType<typeof createScanTicketService>
let sessions: ReturnType<typeof createSessions>

const sha256 = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(databaseUrlFor(scratchDatabase))
  await migrate(scratch, { migrationsFolder })
  sessions = createSessions(scratch)
  service = createScanTicketService({ db: scratch, sessions })
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

async function createUser(nickname: string): Promise<string> {
  const rows = await scratch
    .insert(users)
    .values({
      studentNo: null,
      passwordHash: null,
      nickname,
      authStatus: 'UNVERIFIED',
      verifiedAt: null,
    })
    .returning({ id: users.id })
  const id = rows[0]?.id
  if (!id) throw new Error('INSERT users 未返回 id')
  return id
}

/** 把票据改到已过期：不伪造时钟，直接构造真实实现要面对的行状态。 */
async function expireTicket(ticket: string): Promise<void> {
  await scratch
    .update(loginTickets)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(loginTickets.ticketHash, sha256(ticket)))
}

async function countByTicketHashes(hashes: string[]): Promise<number> {
  const rows = await scratch
    .select({ id: loginTickets.id })
    .from(loginTickets)
    .where(inArray(loginTickets.ticketHash, hashes))
  return rows.length
}

async function readBoundAt(ticket: string): Promise<Date | null> {
  const rows = await scratch
    .select({ boundAt: loginTickets.boundAt })
    .from(loginTickets)
    .where(eq(loginTickets.ticketHash, sha256(ticket)))
  return rows[0]?.boundAt ?? null
}

async function countSessions(userId: string): Promise<number> {
  const rows = await scratch
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(eq(sessionsTable.userId, userId))
  return rows.length
}

/** 断言某个 Promise 以 `AuthError` 的指定 code/status 拒绝。 */
async function expectAuthError(
  action: Promise<unknown>,
  code: AuthError['code'],
  status: AuthError['status'],
) {
  const thrown = await action.catch((error: unknown) => error)
  expect(thrown).toBeInstanceOf(AuthError)
  expect((thrown as AuthError).code).toBe(code)
  expect((thrown as AuthError).status).toBe(status)
}

describe('建票', () => {
  test('返回 22 字符 base64url ticket + 64 hex verifier；TTL 5 分钟；库里只有哈希', async () => {
    const before = Date.now()
    const { ticket, verifier, expiresAt } = await service.create()
    const after = Date.now()

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(verifier).toMatch(/^[0-9a-f]{64}$/)
    // 钉死产品要求的 5 分钟本身，而不是复述被测常量。
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60 * 1000)
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 5 * 60 * 1000)

    const rows = await scratch.select().from(loginTickets)
    const row = rows.find((item) => item.ticketHash === sha256(ticket))
    expect(row).toBeDefined()
    expect(row?.verifierHash).toBe(sha256(verifier))
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(ticket)
    expect(dump).not.toContain(verifier)
  })

  test('有界清理：只删「过期超过保留窗口」的行，一次最多删上限条；刚过期与未过期的都不动', async () => {
    const owner = await createUser('清理样本')
    const purgeableAt = new Date(Date.now() - SCAN_TICKET_RETENTION_MS - 1000)
    const recentAt = new Date(Date.now() - 1000)
    const liveAt = new Date(Date.now() + 60_000)

    // 上限 + 1 条「可清理」的过期行，三种绑定状态都覆盖：未绑定 / 已绑定 / 已消费。
    const purgeable = Array.from({ length: SCAN_TICKET_CLEANUP_LIMIT + 1 }, (_, index) => ({
      ticketHash: sha256(`purgeable-${index}`),
      verifierHash: sha256(`purgeable-verifier-${index}`),
      expiresAt: purgeableAt,
      ...(index % 3 === 1 ? { boundUserId: owner, boundAt: purgeableAt } : {}),
      ...(index % 3 === 2
        ? { boundUserId: owner, boundAt: purgeableAt, consumedAt: purgeableAt }
        : {}),
    }))
    const recent = {
      ticketHash: sha256('recently-expired'),
      verifierHash: sha256('recently-expired-verifier'),
      expiresAt: recentAt,
    }
    const live = {
      ticketHash: sha256('still-live'),
      verifierHash: sha256('still-live-verifier'),
      expiresAt: liveAt,
    }
    await scratch.insert(loginTickets).values([...purgeable, recent, live])

    const purgeableHashes = purgeable.map((row) => row.ticketHash)
    expect(await countByTicketHashes(purgeableHashes)).toBe(SCAN_TICKET_CLEANUP_LIMIT + 1)

    await service.create()

    // 恰好删掉上限条；刚过期与未过期的都不许动。
    expect(await countByTicketHashes(purgeableHashes)).toBe(1)
    expect(await countByTicketHashes([recent.ticketHash])).toBe(1)
    expect(await countByTicketHashes([live.ticketHash])).toBe(1)
  })
})

describe('查状态（只有持正确 verifier 才看得到）', () => {
  test('未确认时是 pending；verifier 不对一律 404', async () => {
    const { ticket, verifier } = await service.create()

    expect(await service.status({ ticket, verifier })).toMatchObject({ status: 'pending' })

    await expectAuthError(
      service.status({ ticket, verifier: 'f'.repeat(64) }),
      'SCAN_TICKET_INVALID',
      404,
    )
    await expectAuthError(
      service.status({ ticket: 'A'.repeat(22), verifier }),
      'SCAN_TICKET_INVALID',
      404,
    )
  })

  test('确认后是 confirmed，且带最小公开账号投影', async () => {
    const userId = await createUser('扫码甲')
    const { ticket, verifier } = await service.create()
    await service.confirm({ ticket, userId })

    const status = await service.status({ ticket, verifier })
    expect(status.status).toBe('confirmed')
    if (status.status !== 'confirmed') throw new Error('unreachable')
    expect(status.user).toEqual({ id: userId, nickname: '扫码甲', avatarUrl: null })

    // confirmed 之后 verifier 依然要校验：否则错误的 verifier 就能拿到账号投影。
    await expectAuthError(
      service.status({ ticket, verifier: 'f'.repeat(64) }),
      'SCAN_TICKET_INVALID',
      404,
    )
  })

  test('库里 avatar_url 是非法值时降级为 null（契约要求 z.url()）', async () => {
    const rows = await scratch
      .insert(users)
      .values({
        studentNo: null,
        passwordHash: null,
        nickname: '脏头像',
        // 历史脏值：契约声明是 URL，库里却是裸 text。
        avatarUrl: 'not-a-url',
        authStatus: 'UNVERIFIED',
        verifiedAt: null,
      })
      .returning({ id: users.id })
    const userId = rows[0]?.id
    if (!userId) throw new Error('INSERT users 未返回 id')

    const { ticket, verifier } = await service.create()
    await service.confirm({ ticket, userId })

    const status = await service.status({ ticket, verifier })
    if (status.status !== 'confirmed') throw new Error('unreachable')
    expect(status.user.avatarUrl).toBeNull()
  })

  test('到期后如实返回 expired（verifier 正确时）', async () => {
    const { ticket, verifier } = await service.create()
    await expireTicket(ticket)

    expect(await service.status({ ticket, verifier })).toMatchObject({ status: 'expired' })
  })

  test('过期后即便触发了清理，持正确 verifier 仍能看到 expired', async () => {
    const { ticket, verifier } = await service.create()
    await expireTicket(ticket)

    // 清理是建票的副作用：刚过期的行在保留窗口内，不能被无关流量删掉。
    await service.create()

    expect(await service.status({ ticket, verifier })).toMatchObject({ status: 'expired' })
  })
})

describe('确认（绑定当前身份）', () => {
  test('同人重复确认幂等；换人一律 409 且不改绑', async () => {
    const first = await createUser('先到的')
    const second = await createUser('后到的')
    const { ticket, verifier } = await service.create()

    await service.confirm({ ticket, userId: first })
    await service.confirm({ ticket, userId: first }) // 幂等

    await expectAuthError(service.confirm({ ticket, userId: second }), 'SCAN_TICKET_CONFLICT', 409)

    const status = await service.status({ ticket, verifier })
    if (status.status !== 'confirmed') throw new Error('unreachable')
    expect(status.user.id).toBe(first)
  })

  test('同人重复确认不改写 bound_at（幂等不只看接口结果）', async () => {
    const userId = await createUser('幂等甲')
    const { ticket } = await service.create()

    await service.confirm({ ticket, userId })
    const firstBoundAt = await readBoundAt(ticket)
    expect(firstBoundAt).not.toBeNull()

    await Bun.sleep(15)
    await service.confirm({ ticket, userId })
    expect(await readBoundAt(ticket)).toEqual(firstBoundAt)
  })

  test('两个用户并发确认：只有一个成功，且绑定者只能是胜者', async () => {
    const first = await createUser('并发先到')
    const second = await createUser('并发后到')
    const { ticket, verifier } = await service.create()

    const results = await Promise.allSettled([
      service.confirm({ ticket, userId: first }),
      service.confirm({ ticket, userId: second }),
    ])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((item) => item.status === 'rejected')
    expect(rejected).toHaveLength(1)
    const error = (rejected[0] as PromiseRejectedResult).reason
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).code).toBe('SCAN_TICKET_CONFLICT')

    const status = await service.status({ ticket, verifier })
    if (status.status !== 'confirmed') throw new Error('unreachable')
    const winner = results[0]?.status === 'fulfilled' ? first : second
    expect(status.user.id).toBe(winner)
  })

  test('已过期 / 已兑换的票被别人确认：仍是统一 404，不泄漏「曾经绑给谁」', async () => {
    const owner = await createUser('原绑定者')
    const other = await createUser('后来者')

    const consumed = await service.create()
    await service.confirm({ ticket: consumed.ticket, userId: owner })
    await service.exchange({ ticket: consumed.ticket, verifier: consumed.verifier })
    await expectAuthError(
      service.confirm({ ticket: consumed.ticket, userId: other }),
      'SCAN_TICKET_INVALID',
      404,
    )

    const expired = await service.create()
    await service.confirm({ ticket: expired.ticket, userId: owner })
    await expireTicket(expired.ticket)
    await expectAuthError(
      service.confirm({ ticket: expired.ticket, userId: other }),
      'SCAN_TICKET_INVALID',
      404,
    )
  })

  test('票不存在 / 已过期 / 已兑换：都是 404', async () => {
    await expectAuthError(
      service.confirm({ ticket: 'B'.repeat(22), userId: await createUser('甲') }),
      'SCAN_TICKET_INVALID',
      404,
    )

    const userId = await createUser('乙')
    const expired = await service.create()
    await expireTicket(expired.ticket)
    await expectAuthError(
      service.confirm({ ticket: expired.ticket, userId }),
      'SCAN_TICKET_INVALID',
      404,
    )

    const consumed = await service.create()
    await service.confirm({ ticket: consumed.ticket, userId })
    await service.exchange({ ticket: consumed.ticket, verifier: consumed.verifier })
    await expectAuthError(
      service.confirm({ ticket: consumed.ticket, userId }),
      'SCAN_TICKET_INVALID',
      404,
    )
  })
})

describe('兑换（消费票据 + 签发会话）', () => {
  test('确认后兑换成功，会话真的可用；兑换后该票对谁都不可用', async () => {
    const userId = await createUser('兑换甲')
    const { ticket, verifier } = await service.create()
    await service.confirm({ ticket, userId })

    const result = await service.exchange({ ticket, verifier })
    expect(result.user.id).toBe(userId)
    expect(result.token).toMatch(/^[0-9a-f]{64}$/)
    expect(await sessions.resolve(result.token)).toEqual({ userId })

    // 已消费的票必须彻底失效：状态查询与重复兑换都是统一 404。
    await expectAuthError(service.status({ ticket, verifier }), 'SCAN_TICKET_INVALID', 404)
    await expectAuthError(service.exchange({ ticket, verifier }), 'SCAN_TICKET_INVALID', 404)
  })

  test('未确认 / verifier 错 / 票不存在：都是 404，不签发会话，也不烧掉票据', async () => {
    const userId = await createUser('兑换乙')

    const pending = await service.create()
    await expectAuthError(
      service.exchange({ ticket: pending.ticket, verifier: pending.verifier }),
      'SCAN_TICKET_INVALID',
      404,
    )

    await service.confirm({ ticket: pending.ticket, userId })
    // verifier 错：既不能签发会话，也不能把这张票消费掉（否则等于帮攻击者烧票）。
    await expectAuthError(
      service.exchange({ ticket: pending.ticket, verifier: 'a'.repeat(64) }),
      'SCAN_TICKET_INVALID',
      404,
    )
    await expectAuthError(
      service.exchange({ ticket: 'C'.repeat(22), verifier: pending.verifier }),
      'SCAN_TICKET_INVALID',
      404,
    )
    expect(await countSessions(userId)).toBe(0)

    // 票据仍然可用：正确 verifier 依旧能兑换。
    const result = await service.exchange({ ticket: pending.ticket, verifier: pending.verifier })
    expect(result.user.id).toBe(userId)
    expect(await countSessions(userId)).toBe(1)
  })

  test('建会话失败时整个事务回滚：票据不被消费，稍后仍能兑换成功', async () => {
    const userId = await createUser('事务甲')
    const { ticket, verifier } = await service.create()
    await service.confirm({ ticket, userId })

    const failing = createScanTicketService({
      db: scratch,
      sessions: {
        ...sessions,
        createWith: () => {
          throw new Error('sessions.createWith 故意失败')
        },
      },
    })

    await expect(failing.exchange({ ticket, verifier })).rejects.toThrow(
      'sessions.createWith 故意失败',
    )
    expect(await service.status({ ticket, verifier })).toMatchObject({ status: 'confirmed' })
    expect(await countSessions(userId)).toBe(0)

    const result = await service.exchange({ ticket, verifier })
    expect(result.user.id).toBe(userId)
    expect(await countSessions(userId)).toBe(1)
  })

  test('并发兑换同一张票：只有一个拿到会话，另一个 404', async () => {
    const userId = await createUser('并发甲')
    const { ticket, verifier } = await service.create()
    await service.confirm({ ticket, userId })
    const sessionsBefore = await countSessions(userId)

    const results = await Promise.allSettled([
      service.exchange({ ticket, verifier }),
      service.exchange({ ticket, verifier }),
      service.exchange({ ticket, verifier }),
    ])

    const ok = results.filter((item) => item.status === 'fulfilled')
    const failed = results.filter((item) => item.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(2)
    // 真表里也只能多一行：并发失败方不得泄漏会话。
    expect((await countSessions(userId)) - sessionsBefore).toBe(1)
    for (const item of failed) {
      const error = (item as PromiseRejectedResult).reason
      expect(error).toBeInstanceOf(AuthError)
      expect((error as AuthError).code).toBe('SCAN_TICKET_INVALID')
    }
  })

  test('锁等待跨过过期点：兑换必须失败（不能用事务开始时间判过期）', async () => {
    // 这条用例专门挡 PostgreSQL 的 `now()` 语义：它是**事务开始时间**。
    // 兑换事务若在 expires_at 之前开始、却因行锁等到过期之后才执行 UPDATE，
    // 用 now() 判断会放行——只有 clock_timestamp() 才取到语句执行时的真实时刻。
    const userId = await createUser('锁等待甲')
    const store = createScanTicketStore(scratch)
    const ticket = 'Z'.repeat(22)
    const verifier = 'e'.repeat(64)
    const ticketHash = sha256(ticket)
    const ttlMs = 1500
    await store.insert(scratch, { ticketHash, verifierHash: sha256(verifier), ttlMs })
    await store.bind(scratch, { ticketHash, userId })

    let releaseLock = () => {}
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const holder = scratch.transaction(async (tx) => {
      await tx
        .select({ id: loginTickets.id })
        .from(loginTickets)
        .where(eq(loginTickets.ticketHash, ticketHash))
        .for('update')
      await held
    })
    await Bun.sleep(50)

    // 兑换在票据仍有效时开始，但会阻塞在行锁上。
    const exchange = service.exchange({ ticket, verifier })
    await Bun.sleep(50)

    // 等票据过期之后再放锁：此刻 UPDATE 才真正执行。
    await Bun.sleep(ttlMs)

    releaseLock()
    await holder
    await expectAuthError(exchange, 'SCAN_TICKET_INVALID', 404)
    expect(await countSessions(userId)).toBe(0)
  })

  test('过期后不可兑换', async () => {
    const userId = await createUser('过期甲')
    const { ticket, verifier } = await service.create()
    await service.confirm({ ticket, userId })
    await expireTicket(ticket)

    await expectAuthError(service.exchange({ ticket, verifier }), 'SCAN_TICKET_INVALID', 404)
    expect(await countSessions(userId)).toBe(0)
  })
})
