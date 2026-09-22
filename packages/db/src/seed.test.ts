import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from './client'
import { jsonParam } from './json'
import { conversations } from './schema/conversations'
import { jobs } from './schema/jobs'
import { listingImages, listings } from './schema/listings'
import { matches } from './schema/matches'
import { messages } from './schema/messages'
import { notifications } from './schema/notifications'
import { transactions } from './schema/transactions'
import { users } from './schema/users'
import { wishes } from './schema/wishes'
import { DEMO_PASSWORD, seed } from './seed'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * seed 会 TRUNCATE 全部业务表，因此必须跑在**独立数据库**里：
 * 既不碰开发库，也不受其他测试文件顺序/并发方式的影响。
 * 顺带独立验证一次"migration 可在空库执行"。
 */
const scratchDatabase = `fish_seed_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

/** 只是拿它当"建/删库"的执行通道，所有断言都在 scratch 库上。 */
const admin = createDb(databaseUrl)

test('seed 可生成基础数据（matches/notifications 留空，由 worker 产出），且演示账号可登录', async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  const scratch = createDb(scratchUrl)

  try {
    await migrate(scratch, { migrationsFolder })
    await scratch.transaction((tx) => seed(tx))

    const counts: Record<string, number> = {}
    for (const [name, table] of Object.entries({
      users,
      listings,
      listingImages,
      wishes,
      matches,
      conversations,
      messages,
      transactions,
      notifications,
      jobs,
    })) {
      counts[name] = await scratch.$count(table)
    }

    expect(counts).toEqual({
      users: 3,
      listings: 6,
      listingImages: 4,
      wishes: 2,
      // `matches` / `notifications` 由 worker 用真实打分产出（#43）：seed 只投一条
      // PENDING 的 MATCH_LISTING，不再预写结果，否则 seed 会成为引擎之外的第二份真相。
      matches: 0,
      // #157：每笔交易都有三元组一致的会话（K380 + 台灯 + 篮球），订单页在 seed
      // 库上才有可演示数据；messages 相应多了两条 tx.accepted SYSTEM 消息。
      conversations: 3,
      messages: 4,
      transactions: 2,
      notifications: 0,
      jobs: 1,
    })

    // #157 / #147 不变量：每笔交易都能按 (listing_id, buyer_id, seller_id) join 到
    // 会话——GET /transactions 的 listForUser / findById 就是这个 join，join 不上的
    // 交易在订单页上静默消失，而 profile 不 join 所以计数正常（自相矛盾）。
    // 真实链路里 accept 自己就是 join 会话得到 conversation_id，seed 曾绕过它。
    const orphanTx = await scratch.execute<{ id: string }>(sql`
      select t.id from transactions t
      left join conversations c
        on c.listing_id = t.listing_id
       and c.buyer_id = t.buyer_id
       and c.seller_id = t.seller_id
      where c.id is null
    `)
    expect([...orphanTx]).toEqual([])

    // seed 写的是真实 argon2id 哈希（#3 替换了 #2 的占位值），前端要用它登录调试，
    // 因此这里断言文档里的演示密码（README「演示账号」）确实能校验通过，而不只断言行数。
    const demoUsers = await scratch
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.studentNo, '202101000001'))
    const demoHash = demoUsers[0]?.passwordHash
    expect(demoHash).toBeDefined()
    expect(await Bun.password.verify(DEMO_PASSWORD, demoHash ?? '')).toBe(true)
    expect(await Bun.password.verify('wrong-password', demoHash ?? '')).toBe(false)

    // 回归：jsonb 列必须落成真正的 JSON object。
    // 用 `insert().values({ payload: {...} })` 写时 drizzle + bun-sql 会 stringify 两次，
    // 落库成为「JSON 字符串套 JSON」：drizzle 读回正常，但 `payload->>'x'` 在 SQL 层恒为 NULL，
    // #8 的 worker 只要按 payload 查就永远匹配不到。修复方式是 `jsonParam()`（见 src/json.ts）。
    //
    // 这里现在只剩 jobs 一条（match / notification 改由 worker 产出），但断言方法不变：
    // 只要能按 `payload->>'listingId'` 读到字符串，就说明种子里那条 job 是可被消费的。
    const payloadRows = await scratch.execute<{ kind: string; ref: string | null }>(
      sql`select jsonb_typeof(payload) as kind, payload->>'listingId' as ref from jobs`,
    )
    expect([...payloadRows]).toHaveLength(1)
    for (const row of payloadRows) {
      expect(row.kind).toBe('object')
      expect(typeof row.ref).toBe('string')
    }

    // 种子的 job 必须是 PENDING：demo 的"愿望成真"由 worker 真实算出来（#43）。
    const seededJobs = await scratch
      .select({ status: jobs.status, attempts: jobs.attempts })
      .from(jobs)
    expect(seededJobs).toEqual([{ status: 'PENDING', attempts: 0 }])
  } finally {
    await scratch.$client.close()
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  }
})

/**
 * `jsonParam` 的契约：对象 → jsonb **object**，**数组 → jsonb array**（而不是 string）。
 *
 * 数组那一支曾经是坏的：`sql\`${value}::jsonb\`` 会被 drizzle 的 `sql` 模板当成参数列表展开，
 * `['a']` 变成 `('a')::jsonb`（jsonb_typeof = 'string'），空数组更会变成 `()::jsonb`（语法错）。
 * 读路径会 parse 两次而「看起来正常」，所以必须按 SQL 层的 typeof / containment 断言。
 */
test('jsonParam 把对象与数组都编码成对应类型的 jsonb', async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  const scratch = createDb(scratchUrl)

  try {
    const rows = await scratch.execute<{
      objType: string
      arrType: string
      emptyType: string
      len: number
      contains: boolean
      ref: string
    }>(sql`
      SELECT jsonb_typeof(${jsonParam({ listingId: 'x' })}) AS "objType",
             jsonb_typeof(${jsonParam(['EXTERNAL_CONTACT'])}) AS "arrType",
             jsonb_typeof(${jsonParam([])}) AS "emptyType",
             jsonb_array_length(${jsonParam(['a', 'b'])}) AS "len",
             (${jsonParam(['EXTERNAL_CONTACT'])} @> '["EXTERNAL_CONTACT"]'::jsonb) AS "contains",
             (${jsonParam({ listingId: 'x' })} ->> 'listingId') AS "ref"
    `)

    // `JSON.stringify(undefined)` 返回的是 JS undefined：直接绑进模板会变成缺表达式的
    // `::text::jsonb` 语法错（评审 D5）。应当收敛成 JSON null。
    const undef = await scratch.execute<{ t: string }>(
      sql`SELECT jsonb_typeof(${jsonParam(undefined)}) AS t`,
    )
    expect(undef[0]?.t).toBe('null')

    expect(rows[0]?.objType).toBe('object')
    expect(rows[0]?.arrType).toBe('array')
    expect(rows[0]?.emptyType).toBe('array')
    expect(rows[0]?.len).toBe(2)
    expect(rows[0]?.contains).toBe(true)
    expect(rows[0]?.ref).toBe('x')
  } finally {
    await scratch.$client.close()
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  }
})
