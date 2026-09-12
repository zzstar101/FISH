import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlMessageStore } from '../messages/store'
import { createSqlTransactionStore, type TransactionRow } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 wishes store.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_transaction_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlTransactionStore(db)
const messages = createSqlMessageStore(db)

const buyer1 = '01990000-0000-7000-8000-0000000000a1'
const buyer2 = '01990000-0000-7000-8000-0000000000a2'
const seller = '01990000-0000-7000-8000-0000000000a3'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const listingB = '01990000-0000-7000-8000-0000000000b2'
const conversationA = '01990000-0000-7000-8000-0000000000c1' // listingA + buyer1
const conversationA2 = '01990000-0000-7000-8000-0000000000c2' // listingA + buyer2
const conversationB = '01990000-0000-7000-8000-0000000000c3' // listingB + buyer1

async function seedListing(id: string) {
  await db.execute(sql`
    INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${id}, ${seller}, '测试商品', '描述', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
}

async function seedConversation(id: string, listingId: string, buyerId: string) {
  await db.execute(sql`
    INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
    VALUES (${id}, ${listingId}, ${buyerId}, ${seller})
  `)
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [buyer1, buyer2, seller].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`tx${process.pid}_${i}`}, 'test-hash', '交易测试')
    `)
  }
  await seedListing(listingA)
  await seedListing(listingB)
  await seedConversation(conversationA, listingA, buyer1)
  await seedConversation(conversationA2, listingA, buyer2)
  await seedConversation(conversationB, listingB, buyer1)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

describe('transactions store (integration)', () => {
  test('two concurrent accepts for the same listing: exactly one wins', async () => {
    const [a1, a2] = await Promise.all([
      store
        .findConversation(conversationA, buyer1)
        .then((l) => (l.kind === 'ok' ? store.accept(l.brief, 15000) : null)),
      store
        .findConversation(conversationA2, buyer2)
        .then((l) => (l.kind === 'ok' ? store.accept(l.brief, 12000) : null)),
    ])
    const outcomes = [a1, a2].map((r) => r?.kind)
    expect(outcomes.filter((kind) => kind === 'created')).toHaveLength(1)
    expect(outcomes.filter((kind) => kind === 'listing-not-active')).toHaveLength(1)

    // listing 被锁定为 RESERVED，且只有一笔 live 交易
    const listing = rows(
      await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${listingA}`),
    )[0] as { status: string }
    expect(listing.status).toBe('RESERVED')
    const live = rows(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM transactions WHERE listing_id = ${listingA}`,
      ),
    )[0] as { n: number }
    expect(live.n).toBe(1)
  })

  test('double confirm completes the transaction and sells the listing atomically', async () => {
    const brief = await store.findConversation(conversationB, buyer1)
    if (brief.kind !== 'ok') throw new Error('unreachable')
    const accepted = await store.accept(brief.brief, 9000)
    if (accepted.kind !== 'created') throw new Error('unreachable')
    const txId = accepted.row.id

    const first = await store.confirm(txId, buyer1, 'buyer')
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') throw new Error('unreachable')
    expect(first.row.status).toBe('PENDING_MEETUP')
    expect(first.row.buyer_confirmed_at).not.toBeNull()

    const second = await store.confirm(txId, seller, 'seller')
    if (second.kind !== 'ok') throw new Error('unreachable')
    expect(second.row.status).toBe('COMPLETED')
    expect(second.row.completed_at).not.toBeNull()

    // COMPLETED 上重复 confirm 幂等返回现状
    const again = await store.confirm(txId, buyer1, 'buyer')
    if (again.kind !== 'ok') throw new Error('unreachable')
    expect(again.row.status).toBe('COMPLETED')

    const listing = rows(
      await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${listingB}`),
    )[0] as { status: string }
    expect(listing.status).toBe('SOLD')
  })

  test('cancel restores the listing to ACTIVE; confirm after cancel → 409 语义', async () => {
    // listingA 的 live 交易先取消：listing 应回 ACTIVE
    const live = rows(
      await db.execute(sql`SELECT id FROM transactions WHERE listing_id = ${listingA} LIMIT 1`),
    )[0] as { id: string }
    const cancelled = await store.cancel(live.id, buyer1)
    if (cancelled.kind !== 'ok') throw new Error('unreachable')
    expect(cancelled.row.status).toBe('CANCELLED')

    const listing = rows(
      await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${listingA}`),
    )[0] as { status: string }
    expect(listing.status).toBe('ACTIVE')

    // CANCELLED 上 confirm → cancelled；重复 cancel 幂等
    expect((await store.confirm(live.id, buyer1, 'buyer')).kind).toBe('cancelled')
    const repeat = await store.cancel(live.id, seller)
    if (repeat.kind !== 'ok') throw new Error('unreachable')
    expect(repeat.row.status).toBe('CANCELLED')

    // 再次接受现在应该成功（listing 已回 ACTIVE）——取消恢复可用性
    const reBrief = await store.findConversation(conversationA, buyer1)
    if (reBrief.kind !== 'ok') throw new Error('unreachable')
    const reAccepted = await store.accept(reBrief.brief, 15000)
    expect(reAccepted.kind).toBe('created')
  })

  test('cancel on COMPLETED → not-cancellable', async () => {
    const completed = rows(
      await db.execute(sql`SELECT id FROM transactions WHERE status = 'COMPLETED' LIMIT 1`),
    )[0] as { id: string }
    const result = await store.cancel(completed.id, buyer1)
    expect(result.kind).toBe('not-cancellable')
  })

  test('listForUser pages by (created_at, id) DESC with no gap or repeat on ties', async () => {
    // 把该买家的全部交易改成同一 created_at：排序只能靠 id tie-break 决出
    await db.execute(sql`
      UPDATE transactions SET created_at = '2026-09-12 10:00:00.123456+00'
      WHERE buyer_id = ${buyer1}
    `)

    const all = rows(
      await db.execute(sql`SELECT id FROM transactions WHERE buyer_id = ${buyer1} ORDER BY id`),
    ).map((row) => row.id as string)

    const collected: string[] = []
    let cursor: { sortKey: string; id: string } | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page = await store.listForUser(buyer1, { limit: 1, cursor })
      if (page.length === 0) break
      // store 返回 limit+1 行，service 保留前 limit 行、用其最后一行生成游标
      const kept = page.slice(0, 1)
      const last = kept.at(-1)
      if (!last) break
      const lastCursor = (last as TransactionRow & { created_at_cursor?: string }).created_at_cursor
      if (!lastCursor) throw new Error('created_at_cursor missing')
      collected.push(last.id)
      if (page.length <= 1) break // 没有判底行 = 已到末页
      cursor = { sortKey: lastCursor, id: last.id }
    }

    // 翻页不重不漏：恰好覆盖全部交易各一次
    expect(collected.sort()).toEqual([...all].sort())
  })

  test('unique-index fallback maps to listing-not-active when listing drifts back to ACTIVE', async () => {
    // 构造不变量漂移：listingA 已有 live 交易（前面的测试留下的 PENDING），
    // 把 listing 强行改回 ACTIVE 后再次 accept——条件更新放行，唯一索引必须拦下。
    const pending = rows(
      await db.execute(
        sql`SELECT id FROM transactions WHERE listing_id = ${listingA} AND status = 'PENDING_MEETUP' LIMIT 1`,
      ),
    )[0]
    if (!pending) throw new Error('需要一笔 listingA 的 PENDING 交易作为前置')
    await db.execute(sql`UPDATE listings SET status = 'ACTIVE' WHERE id = ${listingA}`)

    const brief = await store.findConversation(conversationA, buyer1)
    if (brief.kind !== 'ok') throw new Error('unreachable')
    // 修复前：这里会原样抛 DrizzleQueryError → 500；修复后：映射为 listing-not-active
    const result = await store.accept(brief.brief, 1)
    expect(result.kind).toBe('listing-not-active')

    // 现场还原：listing 回 RESERVED，测试相互独立
    await db.execute(sql`UPDATE listings SET status = 'RESERVED' WHERE id = ${listingA}`)
  })

  test('insertSystem writes a SYSTEM message without sender and bumps last_message_at', async () => {
    const row = await messages.insertSystem(conversationA, '{"type":"tx.proposal"}')
    expect(row.type).toBe('SYSTEM')
    expect(row.sender_id).toBeNull()
    const conversation = rows(
      await db.execute(sql`SELECT last_message_at FROM conversations WHERE id = ${conversationA}`),
    )[0] as { last_message_at: Date | string }
    expect(new Date(conversation.last_message_at).getTime()).toBe(
      new Date(row.created_at).getTime(),
    )
  })
})
