import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { MessageIdempotencyConflictError, messageSendKey, textRequestHash } from './idempotency'
import { createSqlMessageStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 wishes store.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_message_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlMessageStore(db)

const buyer = '01990000-0000-7000-8000-0000000000a1'
const seller = '01990000-0000-7000-8000-0000000000a2'
const outsider = '01990000-0000-7000-8000-0000000000a3'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const conversationA = '01990000-0000-7000-8000-0000000000c1'

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [buyer, seller, outsider].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`msg${process.pid}_${i}`}, 'test-hash', '消息测试')
    `)
  }
  const listingNo = await reserveTestListingNo(db, listingA)
  await db.execute(sql`
    INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listingA}, ${listingNo}, ${seller}, 'K380', '测试商品', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
  await db.execute(sql`
    INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
    VALUES (${conversationA}, ${listingA}, ${buyer}, ${seller})
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('messages store (integration)', () => {
  let firstMessageId: string

  test('findConversationForUser admits participants only', async () => {
    expect((await store.findConversationForUser(conversationA, buyer))?.buyerId).toBe(buyer)
    expect(await store.findConversationForUser(conversationA, outsider)).toBeNull()
  })

  test('insertText persists the message and bumps last_message_at atomically', async () => {
    const inserted = await store.insertText(conversationA, buyer, '  在吗  ')
    expect(inserted.type).toBe('TEXT')
    expect(inserted.sender_id).toBe(buyer)
    expect(inserted.content).toBe('  在吗  ') // trim 是 service 的职责，store 只落库
    expect(inserted.sender_nickname).toBe('消息测试')
    firstMessageId = inserted.id

    const result = await db.execute(
      sql`SELECT last_message_at FROM conversations WHERE id = ${conversationA}`,
    )
    const conversation = (
      Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]
    ) as { last_message_at: Date | string }
    expect(new Date(conversation.last_message_at).getTime()).toBe(
      new Date(inserted.created_at).getTime(),
    )
  })

  test('listByConversation returns ascending pages; before cursor walks back without gap or repeat', async () => {
    // 4 条消息同毫秒提交（created_at 全部是 now()），排序键必须落到 id tie-break 上
    const ids = []
    for (let i = 0; i < 4; i++) {
      ids.push((await store.insertText(conversationA, seller, `m${i}`)).id)
    }
    const [id0, id1, id2, id3] = ids
    if (!id0 || !id1 || !id2 || !id3) throw new Error('unreachable')

    const page1 = await store.listByConversation(conversationA, { limit: 2, before: null })
    if (page1.kind !== 'ok') throw new Error('unreachable')
    expect(page1.rows).toHaveLength(3) // limit+1 判底行
    // 升序页保留的是**最新** 2 条，最早的一条是下一页游标
    const newestTwo = page1.rows.slice(-2).map((row) => row.id)
    expect(newestTwo).toEqual([id2, id3])

    const page2 = await store.listByConversation(conversationA, { limit: 2, before: id2 })
    if (page2.kind !== 'ok') throw new Error('unreachable')
    // 游标（严格更早）之后的全部消息（升序）：test 2 的"在吗"也在其中 —— 不重（无 id2/id3）不漏
    expect(page2.rows.map((row) => row.id)).toEqual([firstMessageId, id0, id1])
  })

  test('listByConversation reports invalid-cursor for a foreign-conversation uuid', async () => {
    const result = await store.listByConversation(conversationA, {
      limit: 10,
      before: '01990000-0000-7000-8000-0000000000ff',
    })
    expect(result.kind).toBe('invalid-cursor')
  })

  test('bump 只把 last_message_at 往前推：更旧的时间戳不回退排序键（#40-1）', async () => {
    // `created_at` 取 `defaultNow()` = **事务开始时间**，所以存在「早开始、晚拿到会话行锁」
    // 的事务用更旧时间戳覆盖新值的竞态，让会话在列表里位置倒退、游标分页出错。
    // store 的公开 API 无法控制并发交错，因此这里直接构造出该竞态的前置状态：
    // 「会话上已有更新的时间戳」，再断言 bump 不会把它改旧。
    const future = new Date(Date.now() + 3_600_000)
    await db.execute(
      sql`UPDATE conversations SET last_message_at = ${future} WHERE id = ${conversationA}`,
    )

    const lastMessageAtMs = async () => {
      const result = await db.execute(
        sql`SELECT last_message_at FROM conversations WHERE id = ${conversationA}`,
      )
      const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as {
        last_message_at: Date | string
      }
      return new Date(row.last_message_at).getTime()
    }

    // TEXT 与 SYSTEM 是同构的两条 bump 路径，一起覆盖（等价用例不重复写）
    await store.insertText(conversationA, buyer, '更旧的时间戳不该回退排序键')
    expect(await lastMessageAtMs()).toBe(future.getTime())

    await store.insertSystem(conversationA, '{"type":"tx.rejected"}')
    expect(await lastMessageAtMs()).toBe(future.getTime())
  })

  test('insertText 重放同一幂等键：返回既有消息且只落一行（#67 验收①）', async () => {
    const key = messageSendKey('01990000-0000-7000-8000-0000000000e1', textRequestHash('重试'))
    if (!key) throw new Error('unreachable')
    const first = await store.insertText(conversationA, buyer, '重试', key)
    const retry = await store.insertText(conversationA, buyer, '重试', key)
    expect(retry.id).toBe(first.id)

    const result = await db.execute(
      sql`SELECT count(*)::int AS count FROM messages
          WHERE conversation_id = ${conversationA} AND client_request_id = ${key.clientRequestId}`,
    )
    const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as {
      count: number
    }
    expect(row.count).toBe(1)
  })

  test('并发重放同一幂等键：advisory lock 串行化，只落一行且都拿到同一条消息', async () => {
    const key = messageSendKey('01990000-0000-7000-8000-0000000000e3', textRequestHash('并发重试'))
    if (!key) throw new Error('unreachable')

    // 8 个并发请求 = 「同一瞬间重试了 8 次」。没有事务级 advisory lock 时它们会同时
    // 查不到既有行、各自 INSERT：一个赢，其余撞 (sender, conversation, client_request_id)
    // 的部分唯一索引 → 23505 → 500。锁把「查重 + 插入」压成串行，全部重放同一条。
    const rows = await Promise.all(
      Array.from({ length: 8 }, () => store.insertText(conversationA, buyer, '并发重试', key)),
    )
    expect(new Set(rows.map((row) => row.id)).size).toBe(1)

    const result = await db.execute(
      sql`SELECT count(*)::int AS count FROM messages
          WHERE conversation_id = ${conversationA} AND client_request_id = ${key.clientRequestId}`,
    )
    const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as {
      count: number
    }
    expect(row.count).toBe(1)
  })

  test('insertText 同一键携带不同内容 → MessageIdempotencyConflictError', async () => {
    const clientRequestId = '01990000-0000-7000-8000-0000000000e2'
    await store.insertText(
      conversationA,
      seller,
      'A',
      messageSendKey(clientRequestId, textRequestHash('A')),
    )
    expect(
      store.insertText(
        conversationA,
        seller,
        'B',
        messageSendKey(clientRequestId, textRequestHash('B')),
      ),
    ).rejects.toBeInstanceOf(MessageIdempotencyConflictError)
  })

  test('会话路径大小写不同也视为同一把锁：并发重试只落一行且拿到同一条（#67 R11）', async () => {
    const key = messageSendKey(
      '01990000-0000-7000-8000-0000000000e6',
      textRequestHash('大小写会话'),
    )
    if (!key) throw new Error('unreachable')

    // 路由的 UUID 正则带 /i，所以 `...C1` 与 `...c1` 都会走到 store；Pg 的 uuid 列把两者
    // 当成同一个会话，但规范化前锁键是两个不同字符串 → 两把锁 → 各自查重未命中 → 争用
    // 同一唯一索引，其中一个 23505/500。规范化后必须串行成「全部重放同一条」。
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.insertText(
          index % 2 === 0 ? conversationA.toUpperCase() : conversationA,
          outsider,
          '大小写会话',
          key,
        ),
      ),
    )
    expect(new Set(rows.map((row) => row.id)).size).toBe(1)

    const result = await db.execute(
      sql`SELECT count(*)::int AS count FROM messages
          WHERE conversation_id = ${conversationA} AND client_request_id = ${key.clientRequestId}`,
    )
    const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as {
      count: number
    }
    expect(row.count).toBe(1)
  })

  test('clientRequestId 大小写不同视为同一个键：重试不新增行（#67 R11）', async () => {
    // client_request_id 是 text 列，不规范化就会「同一次发送的重试」各落一行。
    const upper = messageSendKey(
      '01990000-0000-7000-8000-0000000000E7',
      textRequestHash('请求标识'),
    )
    const lower = messageSendKey(
      '01990000-0000-7000-8000-0000000000e7',
      textRequestHash('请求标识'),
    )
    if (!upper || !lower) throw new Error('unreachable')

    const first = await store.insertText(conversationA, seller, '请求标识', upper)
    const retry = await store.insertText(conversationA, seller, '请求标识', lower)
    expect(retry.id).toBe(first.id)

    const result = await db.execute(
      sql`SELECT count(*)::int AS count FROM messages
          WHERE conversation_id = ${conversationA} AND sender_id = ${seller}
            AND client_request_id = ${lower.clientRequestId}`,
    )
    const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as {
      count: number
    }
    expect(row.count).toBe(1)
  })

  test('大小写不同的同一键携带不同内容 → 幂等冲突，而不是唯一冲突 500（#67 R11）', async () => {
    const first = messageSendKey('01990000-0000-7000-8000-0000000000E8', textRequestHash('A'))
    const second = messageSendKey('01990000-0000-7000-8000-0000000000e8', textRequestHash('B'))
    if (!first || !second) throw new Error('unreachable')

    await store.insertText(conversationA, buyer, 'A', first)
    expect(store.insertText(conversationA, buyer, 'B', second)).rejects.toBeInstanceOf(
      MessageIdempotencyConflictError,
    )
  })
})
