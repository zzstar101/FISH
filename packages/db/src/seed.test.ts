import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from './client'
import { jsonParam } from './json'
import { conversations } from './schema/conversations'
import { disputeAttachments, disputeEvidenceMessages, disputes } from './schema/disputes'
import { embeddings } from './schema/embeddings'
import { jobs } from './schema/jobs'
import { listingMediaObjects } from './schema/listing-media'
import { listingNumbers } from './schema/listing-numbers'
import { listingImages, listings } from './schema/listings'
import { matches } from './schema/matches'
import { messages } from './schema/messages'
import { notifications } from './schema/notifications'
import { transactions } from './schema/transactions'
import { userInterestProfiles } from './schema/user-interest-profiles'
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
      listingMediaObjects,
      wishes,
      embeddings,
      matches,
      conversations,
      messages,
      transactions,
      disputes,
      disputeAttachments,
      disputeEvidenceMessages,
      notifications,
      jobs,
      userInterestProfiles,
    })) {
      counts[name] = await scratch.$count(table)
    }

    expect(counts).toEqual({
      users: 3,
      listings: 6,
      listingImages: 4,
      // #286：审核台账由 confirm 写入，seed 不预置（本地 transport 恒 REVIEW，预置反而会造出
      // "已确认"的假象）。它引用 users，因此必须一起 TRUNCATE，否则 seed 会撞外键。
      listingMediaObjects: 0,
      wishes: 2,
      // #322 M1：向量由 worker 的 EMBED_* job 生成，seed 不预置（假向量落进 seed 库比空表更误导）。
      embeddings: 0,
      // `matches` / `notifications` 由 worker 用真实打分产出（#43）：seed 只投一条
      // PENDING 的 MATCH_LISTING，不再预写结果，否则 seed 会成为引擎之外的第二份真相。
      matches: 0,
      // #157：每笔交易都有三元组一致的会话（K380 + 台灯 + 篮球），订单页在 seed
      // 库上才有可演示数据；messages 相应多了两条 tx.accepted SYSTEM 消息。
      conversations: 3,
      messages: 4,
      transactions: 2,
      // #465：争议与证据由用户真实发起产生，seed 不预置（同 matches / embeddings 的取舍：
      // 假争议落进 seed 库比空表更误导，它还会伪造一条不存在的处理进度）。
      // 这三条断言锁住的是**写侧确实不预置**争议数据：seed 只写 users / listingNumbers /
      // listings / listingImages / wishes / conversations / messages / transactions / jobs
      // 九张表。
      // 它们**测不到 TRUNCATE 清单漏列**：清单漏掉任何一张被引用的表时，seed() 自身的
      // TRUNCATE 会先抛 0A000（实测 detail: Table "dispute_attachments" references
      // "users"），根本走不到下面的 counts —— 换成父提交 d170f609 的旧 counts 在同一处
      // 破坏下同样失败。清单不变量由 TRUNCATE 语句自身兜住：它覆盖 39 张业务表，本 counts
      // 只覆盖其中 16 张，其余 23 张靠 seed() 抛出的 0A000 把关。
      disputes: 0,
      disputeAttachments: 0,
      disputeEvidenceMessages: 0,
      notifications: 0,
      jobs: 1,
      // #323 R2：兴趣画像由 worker 的 REFRESH_USER_INTEREST job 从真实行为聚合产出，
      // seed 不预置（假向量/假画像落进 seed 库比空表更误导，同 embeddings 的取舍）。
      userInterestProfiles: 0,
    })

    const originalNumbers = await scratch
      .select({ id: listings.id, no: listings.listingNo })
      .from(listings)
      .orderBy(listings.id)
    expect(originalNumbers.every((row) => /^[1-9][0-9]{11}$/.test(row.no.toString()))).toBe(true)
    await scratch.transaction((tx) => seed(tx))
    expect(
      await scratch
        .select({ id: listings.id, no: listings.listingNo })
        .from(listings)
        .orderBy(listings.id),
    ).toEqual(originalNumbers)
    expect(await scratch.$count(listingNumbers)).toBe(6)

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

    // #301 业务不变量：SQL 直查库（不经客户端 mock），违规行一律期望空数组。
    // 断言口径取自真实读写路径：交易状态机由 accept 的条件更新驱动
    // （schema/transactions.ts 的「UPDATE listings ... WHERE status='ACTIVE'」注释），
    // fixture 若绕过状态机写脏数据，这里必须红。CANCELLED 不参与：交易取消后
    // 商品可以另行售出，CANCELLED ↔ 非 SOLD 不构成不变量。
    const txListingStatusViolations = await scratch.execute<{
      id: string
      txStatus: string
      listingStatus: string
    }>(sql`
      select t.id, t.status as "txStatus", l.status as "listingStatus"
      from transactions t
      join listings l on l.id = t.listing_id
      where (t.status = 'COMPLETED' and l.status <> 'SOLD')
         or (t.status = 'PENDING_MEETUP' and l.status = 'SOLD')
    `)
    expect([...txListingStatusViolations]).toEqual([])

    // 会话参与者对称：buyer ≠ seller，且两人都真实存在于 users。
    const conversationParticipantViolations = await scratch.execute<{ id: string }>(sql`
      select c.id
      from conversations c
      left join users b on b.id = c.buyer_id
      left join users s on s.id = c.seller_id
      where c.buyer_id = c.seller_id or b.id is null or s.id is null
    `)
    expect([...conversationParticipantViolations]).toEqual([])

    // 消息发送者合法：sender 为 null（SYSTEM），或属于该会话的买家/卖家。
    const messageSenderViolations = await scratch.execute<{ id: string }>(sql`
      select m.id
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.sender_id is not null
        and m.sender_id <> c.buyer_id
        and m.sender_id <> c.seller_id
    `)
    expect([...messageSenderViolations]).toEqual([])

    // tx.accepted SYSTEM 消息必须指向真实交易，且不带发送者。content 是 text，
    // 可能是纯文案（如「买家发起了交易确认。」），不能无条件 ::jsonb——
    // CASE 包住 pg_input_is_valid，Postgres 只对命中的分支求值，纯文案行安全跳过。
    // 先限定 m.type = 'SYSTEM'：用户合法发一条 TEXT、内容恰好是
    // {"type":"tx.accepted",...} 时，不该被误当成交易系统事件。
    // join 用 id::text 比较：payload 是坏 UUID 时报「违规行」而不是把测试打崩。
    const txMessageViolations = await scratch.execute<{ id: string }>(sql`
      with payloads as (
        select m.id,
               m.sender_id,
               case when pg_input_is_valid(m.content, 'jsonb') then m.content::jsonb end as payload
        from messages m
        where m.type = 'SYSTEM'
      )
      select p.id
      from payloads p
      left join transactions t on t.id::text = p.payload ->> 'transactionId'
      where p.payload ->> 'type' = 'tx.accepted'
        and (t.id is null or p.sender_id is not null)
    `)
    expect([...txMessageViolations]).toEqual([])

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

    // #301：补上 payload 引用的 listing 存在性（上面只查了 jsonb_typeof）。
    // 口径 = listings.id：契约 MatchListingJobPayloadSchema 是 z.uuid()，worker 的
    // matchListing 也按 id 消费；issue 原文写的 listingNo 与契约/fixture 均不符，不采用。
    const jobListingViolations = await scratch.execute<{ id: string }>(sql`
      select j.id
      from jobs j
      left join listings l on l.id::text = j.payload ->> 'listingId'
      where j.payload ->> 'listingId' is not null
        and l.id is null
    `)
    expect([...jobListingViolations]).toEqual([])
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
