import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlMessageStore } from '../messages/store'
import { createSqlTransactionStore, MeetupConsumeRaceError, type TransactionRow } from './store'

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

/** store 层只要求 content 由调用方给出（序列化归 service，见 #40-3）；测试里固定形状即可。 */
const acceptSystemContent = (transactionId: string) =>
  JSON.stringify({ type: 'tx.accepted', transactionId, amountCents: 1 })

describe('transactions store (integration)', () => {
  test('two concurrent accepts for the same listing: exactly one wins', async () => {
    const [a1, a2] = await Promise.all([
      store
        .findConversation(conversationA, buyer1)
        .then((l) => (l.kind === 'ok' ? store.accept(l.brief, 15000, acceptSystemContent) : null)),
      store
        .findConversation(conversationA2, buyer2)
        .then((l) => (l.kind === 'ok' ? store.accept(l.brief, 12000, acceptSystemContent) : null)),
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
    const accepted = await store.accept(brief.brief, 9000, acceptSystemContent)
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
    // listingA 的 live 交易是**上一个用例那次并发 accept** 的产物，而胜者 buyer1 / buyer2 皆有可能
    // （上一个用例断言的正是「恰好一个成功」，并没有说谁成功）。所以这里必须回读该笔交易**自己的**
    // buyer_id 当 viewer：硬编码 buyer1 会在 buyer2 胜出时走进 store.cancel 的 not-found 分支
    // （viewerId 不属于买卖双方），表现为随机出现的 `unreachable`（#56）。
    const live = rows(
      await db.execute(
        sql`SELECT id, buyer_id FROM transactions WHERE listing_id = ${listingA} LIMIT 1`,
      ),
    )[0] as { id: string; buyer_id: string }
    const cancelled = await store.cancel(live.id, live.buyer_id)
    if (cancelled.kind !== 'ok') throw new Error('unreachable')
    expect(cancelled.row.status).toBe('CANCELLED')
    expect(cancelled.row.buyer_id).toBe(live.buyer_id)

    const listing = rows(
      await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${listingA}`),
    )[0] as { status: string }
    expect(listing.status).toBe('ACTIVE')

    // CANCELLED 上 confirm → cancelled；重复 cancel 幂等
    expect((await store.confirm(live.id, live.buyer_id, 'buyer')).kind).toBe('cancelled')
    const repeat = await store.cancel(live.id, seller)
    if (repeat.kind !== 'ok') throw new Error('unreachable')
    expect(repeat.row.status).toBe('CANCELLED')

    // 再次接受现在应该成功（listing 已回 ACTIVE）——取消恢复可用性
    const reBrief = await store.findConversation(conversationA, buyer1)
    if (reBrief.kind !== 'ok') throw new Error('unreachable')
    const reAccepted = await store.accept(reBrief.brief, 15000, acceptSystemContent)
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
    const result = await store.accept(brief.brief, 1, acceptSystemContent)
    expect(result.kind).toBe('listing-not-active')

    // 现场还原：listing 回 RESERVED，测试相互独立
    await db.execute(sql`UPDATE listings SET status = 'RESERVED' WHERE id = ${listingA}`)
  })

  test('#40-4：商品漂移出 RESERVED 时不得把交易标成 COMPLETED（那样商品并未 SOLD）', async () => {
    // 独立 fixture，避免与前序用例的状态纠缠
    const listingC = '01990000-0000-7000-8000-0000000000b4'
    const conversationC = '01990000-0000-7000-8000-0000000000c4'
    await seedListing(listingC)
    await seedConversation(conversationC, listingC, buyer1)

    const lookup = await store.findConversation(conversationC, buyer1)
    if (lookup.kind !== 'ok') throw new Error('unreachable')
    const accepted = await store.accept(lookup.brief, 11000, acceptSystemContent)
    if (accepted.kind !== 'created') throw new Error('unreachable')
    const txId = accepted.row.id

    // 商品状态漂移出 RESERVED（API 侧 #6 的谓词会挡，但运维/脚本漂移是可能的）
    await db.execute(sql`UPDATE listings SET status = 'OFFLINE' WHERE id = ${listingC}`)

    await store.confirm(txId, buyer1, 'buyer')
    await store.confirm(txId, seller, 'seller')

    const listing = rows(
      await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${listingC}`),
    )[0] as { status: string }
    const tx = rows(
      await db.execute(sql`SELECT status::text AS status FROM transactions WHERE id = ${txId}`),
    )[0] as { status: string }

    // 显式钉住不变量两端：交易必须完成、商品必须售出。
    // （只断言「不等于某一对字符串」太弱：PENDING_MEETUP/OFFLINE、CANCELLED/OFFLINE 都会绿，
    //   漏掉「confirm 根本没完成交易」这类回归。）
    expect(tx.status).toBe('COMPLETED')
    expect(listing.status).toBe('SOLD')
  })

  test('#40-3：SYSTEM 消息写入失败时整笔回滚 —— 交易不落库、商品不被锁', async () => {
    const listingD = '01990000-0000-7000-8000-0000000000b5'
    await seedListing(listingD)
    const lookup = await store.findConversation(conversationB, buyer1)
    if (lookup.kind !== 'ok') throw new Error('unreachable')

    // 会话 id 指向不存在的行 → messages 的外键失败，等价于「SYSTEM 消息写不进去」
    const bogusBrief = {
      ...lookup.brief,
      id: '01990000-0000-7000-8000-0000000000ff',
      listingId: listingD,
    }
    await expect(store.accept(bogusBrief, 5000, acceptSystemContent)).rejects.toThrow()

    // 消息与交易同一事务：交易行与 listing 的 RESERVED 锁定都必须一并回滚，
    // 否则就回到 #40-3 的部分成功——交易已创建、确认消息永久缺失。
    const txCount = rows(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM transactions WHERE listing_id = ${listingD}`,
      ),
    )[0] as { n: number }
    expect(txCount.n).toBe(0)
    const listing = rows(
      await db.execute(sql`SELECT status::text AS status FROM listings WHERE id = ${listingD}`),
    )[0] as { status: string }
    expect(listing.status).toBe('ACTIVE')
  })

  test('#40/F3：交易侧封面也只认 sort_order = 0（与 profile / #6 读模型同一口径）', async () => {
    const listingE = '01990000-0000-7000-8000-0000000000b6'
    await seedListing(listingE)
    // 脏数据形状：有图，但没有 0 号图（0 才是封面，见 #6 契约 §1）
    await db.execute(sql`
      INSERT INTO listing_images (id, listing_id, object_key, sort_order)
      VALUES ('01990000-0000-7000-8000-0000000000f6', ${listingE}, 'listings/e/1.jpg', 1)
    `)

    const briefs = await store.listingBriefs([listingE])
    // profile 侧对同一形状返回 null（apps/api/src/modules/profile/store.test.ts 已钉住）。
    // 同一笔交易的订单卡在两个接口必须同口径，否则同一张卡显示不同封面。
    expect(briefs.get(listingE)?.coverObjectKey).toBeNull()
  })

  test('#40-3 回归：accept 等锁期间先提交的消息，不会在刷新后与 SYSTEM 消息顺序倒挂', async () => {
    const listingF = '01990000-0000-7000-8000-0000000000b7'
    const conversationF = '01990000-0000-7000-8000-0000000000c7'
    await seedListing(listingF)
    await seedConversation(conversationF, listingF, buyer1)

    const lookup = await store.findConversation(conversationF, buyer1)
    if (lookup.kind !== 'ok') throw new Error('unreachable')

    // 用本文件已有的连接池开一个独立事务持住 listing 行锁，让 accept 卡在中途 ——
    // 这正是真实竞态：并发 accept 也要等这把锁。
    // （刻意不另开连接池：多个测试文件并行时额外池会加剧 Postgres 连接压力。）
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const holderDone = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM listings WHERE id = ${listingF} FOR UPDATE`)
      await held
    })
    await Bun.sleep(50) // 等锁真的被拿到

    try {
      const accepting = store.accept(lookup.brief, 7000, acceptSystemContent)
      await Bun.sleep(150) // 让 accept 阻塞在 listing 锁上
      const text = await messages.insertText(conversationF, buyer1, '在吗') // 先提交
      release()
      await holderDone
      const accepted = await accepting
      if (accepted.kind !== 'created') throw new Error('unreachable')

      const page = await messages.listByConversation(conversationF, { limit: 10, before: null })
      if (page.kind !== 'ok') throw new Error('unreachable')
      const ids = page.rows.map((row) => row.id)
      // 提交顺序是 TEXT → SYSTEM，按 (created_at, id) 升序重排后必须一致；
      // 若 SYSTEM 用了「事务开始时刻」的 now()，它就会排到 TEXT 前面，实时与刷新后自相矛盾。
      expect(ids.indexOf(accepted.message.id)).toBeGreaterThan(ids.indexOf(text.id))
    } finally {
      release()
      await holderDone
    }
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

  test('listingBriefs returns title/price/status and cover key; userBriefs returns nickname/avatar', async () => {
    // 无图商品封面显式 null（"查过、没有"，不是"没查"）
    const listings = await store.listingBriefs([listingA, listingB])
    expect(listings.get(listingA)).toMatchObject({
      id: listingA,
      title: '测试商品',
      priceCents: 16000,
      coverObjectKey: null,
    })
    const users = await store.userBriefs([buyer1, seller])
    expect(users.get(buyer1)?.nickname).toBe('交易测试')
    expect(users.get(seller)?.avatarUrl).toBeNull()
    // 空入参与缺失键
    expect((await store.listingBriefs([])).size).toBe(0)
    expect((await store.userBriefs([])).size).toBe(0)
    expect(users.has('01990000-0000-7000-8000-0000000000ff')).toBe(false)
  })
})

describe('meetup token store (integration, #70)', () => {
  // 每个场景独立一笔 PENDING 交易（一个 listing 只能有一笔 live 交易），
  // 互不依赖执行顺序。
  const scenarios = {
    happy: {
      listing: '01990000-0000-7000-8000-0000000000c1',
      conversation: '01990000-0000-7000-8000-0000000000c9',
    },
    upsert: {
      listing: '01990000-0000-7000-8000-0000000000c2',
      conversation: '01990000-0000-7000-8000-0000000000da',
    },
    invalidLock: {
      listing: '01990000-0000-7000-8000-0000000000c3',
      conversation: '01990000-0000-7000-8000-0000000000db',
    },
    expired: {
      listing: '01990000-0000-7000-8000-0000000000c4',
      conversation: '01990000-0000-7000-8000-0000000000dc',
    },
    race: {
      listing: '01990000-0000-7000-8000-0000000000c5',
      conversation: '01990000-0000-7000-8000-0000000000dd',
    },
    merge: {
      listing: '01990000-0000-7000-8000-0000000000c6',
      conversation: '01990000-0000-7000-8000-0000000000de',
    },
    issueGuardCancel: {
      listing: '01990000-0000-7000-8000-0000000000c7',
      conversation: '01990000-0000-7000-8000-0000000000df',
    },
    issueGuardComplete: {
      listing: '01990000-0000-7000-8000-0000000000c8',
      conversation: '01990000-0000-7000-8000-0000000000e0',
    },
    issueRace: {
      listing: '01990000-0000-7000-8000-0000000000c9',
      conversation: '01990000-0000-7000-8000-0000000000e1',
    },
    generation: {
      listing: '01990000-0000-7000-8000-0000000000ca',
      conversation: '01990000-0000-7000-8000-0000000000e2',
    },
    // #147 核销 × 取消并发（锁序回归）：三组独立场景，重复并发以降低偶然性
    redeemRaceA: {
      listing: '01990000-0000-7000-8000-0000000000cb',
      conversation: '01990000-0000-7000-8000-0000000000e3',
    },
    redeemRaceB: {
      listing: '01990000-0000-7000-8000-0000000000cc',
      conversation: '01990000-0000-7000-8000-0000000000e4',
    },
    redeemRaceC: {
      listing: '01990000-0000-7000-8000-0000000000cd',
      conversation: '01990000-0000-7000-8000-0000000000e5',
    },
  } as const

  const TOKEN_HASH = 'a'.repeat(64)
  const CODE_HASH = 'b'.repeat(64)

  async function createPendingTx(scenario: (typeof scenarios)[keyof typeof scenarios]) {
    await seedListing(scenario.listing)
    await seedConversation(scenario.conversation, scenario.listing, buyer1)
    const lookup = await store.findConversation(scenario.conversation, buyer1)
    if (lookup.kind !== 'ok') throw new Error('unreachable')
    const accepted = await store.accept(lookup.brief, 16000, acceptSystemContent)
    if (accepted.kind !== 'created') throw new Error('unreachable')
    return accepted.row.id
  }

  test('核销成功：条件更新命中并同事务盖卖家确认；重复核销 → consumed', async () => {
    const txId = await createPendingTx(scenarios.happy)
    await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })

    const ok = await store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })
    expect(ok.kind).toBe('ok')
    if (ok.kind !== 'ok') throw new Error('unreachable')
    expect(ok.row.consumed_by).toBe(buyer1)
    expect(ok.row.consumed_at).not.toBeNull()

    // 卖家确认被同一事务盖上；交易仍 PENDING（等买家侧 confirm）
    const tx = rows(
      await db.execute(
        sql`SELECT seller_confirmed_at, status::text AS status FROM transactions WHERE id = ${txId}`,
      ),
    )[0] as { seller_confirmed_at: Date | null; status: string }
    expect(tx.seller_confirmed_at).not.toBeNull()
    expect(tx.status).toBe('PENDING_MEETUP')

    // 并发/重放的第二次核销 → consumed（一次性）
    const again = await store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })
    expect(again.kind).toBe('consumed')
  })

  test('#175 ensure：同一行、issued_at 不变；未核销时哈希对齐（历史行自愈），已核销不复活；计数与锁定每次清零', async () => {
    const txId = await createPendingTx(scenarios.upsert)
    const first = await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })
    expect(first).not.toBeNull()
    if (!first) throw new Error('unreachable')

    // 先制造「已锁定」状态：卖家取码必须能把它清零（#175 冻结的现场解锁路径）
    await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: TOKEN_HASH, codeHash: CODE_HASH },
      1,
      600,
    )
    expect((await store.findMeetupToken(txId))?.locked_until).not.toBeNull()

    // 未核销时再取码：哈希对齐到传入值（历史遗留随机码 → 派生码的一次性自愈），
    // 计数与锁定清零，issued_at 不刷新（不是「重签一枚新码」）
    const NEW_TOKEN_HASH = 'c'.repeat(64)
    const NEW_CODE_HASH = 'd'.repeat(64)
    const healed = await store.upsertMeetupToken(txId, {
      tokenHash: NEW_TOKEN_HASH,
      codeHash: NEW_CODE_HASH,
      issuedBy: seller,
    })
    expect(healed).not.toBeNull()
    if (!healed) throw new Error('unreachable')
    expect(healed.token_hash).toBe(NEW_TOKEN_HASH)
    expect(healed.code_hash).toBe(NEW_CODE_HASH)
    expect(healed.failed_attempts).toBe(0)
    expect(healed.locked_until).toBeNull()
    expect(new Date(healed.issued_at).getTime()).toBe(new Date(first.issued_at).getTime())

    // 旧（历史）哈希不再匹配 → invalid；对齐后的哈希可核销
    const old = await store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })
    expect(old.kind).toBe('invalid')
    const fresh = await store.consumeMeetupToken(txId, buyer1, {
      kind: 'code',
      hash: NEW_CODE_HASH,
    })
    expect(fresh.kind).toBe('ok')

    // 已核销后再取码（卖家重进页面）：不复活、不重写哈希，consumed 保持
    const afterConsume = await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })
    expect(afterConsume).not.toBeNull()
    if (!afterConsume) throw new Error('unreachable')
    expect(afterConsume.consumed_at).not.toBeNull()
    expect(afterConsume.token_hash).toBe(NEW_TOKEN_HASH)
    expect(afterConsume.code_hash).toBe(NEW_CODE_HASH)
    expect(afterConsume.failed_attempts).toBe(0)
    expect(afterConsume.locked_until).toBeNull()
    const replay = await store.consumeMeetupToken(txId, buyer1, {
      kind: 'code',
      hash: NEW_CODE_HASH,
    })
    expect(replay.kind).toBe('consumed')
  })

  test('哈希不匹配 → invalid；失败计数达阈值置 locked_until；锁定期间 → locked', async () => {
    const txId = await createPendingTx(scenarios.invalidLock)
    await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })

    const miss = await store.consumeMeetupToken(txId, buyer1, {
      kind: 'code',
      hash: 'e'.repeat(64),
    })
    expect(miss.kind).toBe('invalid')
    const first = await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: TOKEN_HASH, codeHash: CODE_HASH },
      3,
      600,
    )
    expect(first?.failedAttempts).toBe(1)
    expect(first?.lockedUntil).toBeNull()

    await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: TOKEN_HASH, codeHash: CODE_HASH },
      3,
      600,
    )
    const third = await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: TOKEN_HASH, codeHash: CODE_HASH },
      3,
      600,
    )
    expect(third?.failedAttempts).toBe(3)
    expect(third?.lockedUntil).not.toBeNull()

    // 锁定期间核销被条件更新拦下（诊断出 locked，而不是 invalid）
    const locked = await store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })
    expect(locked.kind).toBe('locked')
  })

  test('#147 长期凭证：issued_at 早已过去（原 TTL 语义的时间点）核销仍 ok', async () => {
    const txId = await createPendingTx(scenarios.expired)
    await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })
    // 平移 issued_at：模拟「签发很久之后」（原 5 分钟 TTL 早已过去）
    await db.execute(sql`
      UPDATE transaction_meetup_tokens
      SET issued_at = now() - interval '10 minutes'
      WHERE transaction_id = ${txId}
    `)
    const result = await store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })
    expect(result.kind).toBe('ok')
  })

  test('#147 终态销毁：cancel 同事务删凭证行；旧码核销 → 竞态错误（service 映射 409）', async () => {
    const txId = await createPendingTx(scenarios.race)
    await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })
    expect(await store.findMeetupToken(txId)).not.toBeNull()
    await store.cancel(txId, buyer1)
    expect(await store.findMeetupToken(txId)).toBeNull() // 行已随 cancel 删除
    // 终态核销：锁内状态守卫抛竞态错误（不是 not-found），service 据此给
    // 409 TRANSACTION_NOT_IN_PENDING —— 与终态语义一致，不退化成「没有凭证」。
    await expect(
      store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH }),
    ).rejects.toBeInstanceOf(MeetupConsumeRaceError)
  })

  test('买家已单侧确认后核销 → 同事务推进 COMPLETED + listing SOLD（审查 F1）', async () => {
    const txId = await createPendingTx(scenarios.merge)
    // 买家先在订单里单侧确认（#11：单侧确认交易停在 PENDING）
    const stamped = await store.confirm(txId, buyer1, 'buyer')
    if (stamped.kind !== 'ok') throw new Error('unreachable')
    expect(stamped.row.status).toBe('PENDING_MEETUP')

    await store.upsertMeetupToken(txId, {
      tokenHash: TOKEN_HASH,
      codeHash: CODE_HASH,
      issuedBy: seller,
    })
    const ok = await store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })
    expect(ok.kind).toBe('ok')

    const merged = rows(
      await db.execute(sql`
        SELECT t.status::text AS status, t.completed_at, l.status::text AS listing_status
        FROM transactions t JOIN listings l ON l.id = t.listing_id
        WHERE t.id = ${txId}
      `),
    )[0] as { status: string; completed_at: Date | null; listing_status: string }
    expect(merged.status).toBe('COMPLETED')
    expect(merged.completed_at).not.toBeNull()
    expect(merged.listing_status).toBe('SOLD')
    // #147 终态销毁：核销把交易推入 COMPLETED 的同事务必须删除凭证行
    // （上面的 upsert 先造了行；不直接断言的话，删掉 store 里 consume 完成分支的
    // DELETE 整个模块仍全绿——审查 #76 的 mutation 发现）。
    expect(await store.findMeetupToken(txId)).toBeNull()
  })

  test('终态交易不得签发：CANCELLED / COMPLETED 上 upsert 落 0 行返回 null（审查 P1 TOCTOU）', async () => {
    const cancelledTx = await createPendingTx(scenarios.issueGuardCancel)
    await store.cancel(cancelledTx, buyer1)
    expect(
      await store.upsertMeetupToken(cancelledTx, {
        tokenHash: TOKEN_HASH,
        codeHash: CODE_HASH,
        issuedBy: seller,
      }),
    ).toBeNull()
    expect(await store.findMeetupToken(cancelledTx)).toBeNull()

    const completedTx = await createPendingTx(scenarios.issueGuardComplete)
    // 双侧 confirm 完成前先签发凭证：完成路径必须把它同事务删掉。
    // 不先造行的话，下面的 findMeetupToken 断言永远是 null（从未有过行），
    // 删掉 store 里 confirm 完成分支的 DELETE 整个模块仍全绿（审查 #76 的 mutation 发现）。
    expect(
      await store.upsertMeetupToken(completedTx, {
        tokenHash: TOKEN_HASH,
        codeHash: CODE_HASH,
        issuedBy: seller,
      }),
    ).not.toBeNull()
    await store.confirm(completedTx, buyer1, 'buyer')
    await store.confirm(completedTx, seller, 'seller')
    expect(await store.findMeetupToken(completedTx)).toBeNull()
    expect(
      await store.upsertMeetupToken(completedTx, {
        tokenHash: TOKEN_HASH,
        codeHash: CODE_HASH,
        issuedBy: seller,
      }),
    ).toBeNull()
    expect(await store.findMeetupToken(completedTx)).toBeNull()
  })

  test('cancel 与 issue 并发：终态必销毁凭证（CANCELLED ⇒ token 不存在，#76 修复）', async () => {
    const txId = await createPendingTx(scenarios.issueRace)
    const [cancelOut] = await Promise.all([
      store.cancel(txId, buyer1),
      store.upsertMeetupToken(txId, {
        tokenHash: TOKEN_HASH,
        codeHash: CODE_HASH,
        issuedBy: seller,
      }),
    ])
    // cancel 在 PENDING 上不受 token 影响，必然成功（#11 冻结语义）
    if (cancelOut.kind !== 'ok') throw new Error('unreachable')
    // 可观测不变量按交易的**最终状态**断言（#76）：两种交错都合法——issue 先持锁签发、
    // cancel 后到；或 cancel 先持锁、issue 的 FOR UPDATE 重评估后落空（返回 null）。
    // 但无论哪种，终态 CANCELLED ⇒ 凭证行必须不存在。
    // 修复前（store.cancel 把 DELETE 塞在与 UPDATE 同一条 CTE 里）红：READ COMMITTED
    // 下同一条语句对非目标表用语句开头快照，issue 在 cancel 语句求值后提交的凭证行
    // 对 DELETE 不可见 → CANCELLED 交易上 token 幸存。
    const tokenRow = await store.findMeetupToken(txId)
    const finalTx = rows(
      await db.execute(sql`SELECT status::text AS status FROM transactions WHERE id = ${txId}`),
    )[0] as { status: string }
    expect(finalTx.status).toBe('CANCELLED')
    expect(tokenRow).toBeNull()
  })

  test('#147 核销 × 取消并发：统一锁序（先交易行后凭证行）不死锁，终态必销毁凭证', async () => {
    // 修复前：核销先锁凭证行、再锁交易行，而 cancel / confirm 先锁交易行、再 DELETE
    // 凭证行 → AB-BA 死锁（40P01），客户端拿 500。修复后两者都先锁交易行。
    // 死锁是否触发取决于具体交错，因此这里重复 3 组独立场景提高检出率。
    const settle = async <T>(promise: Promise<T>) => {
      try {
        return { ok: true as const, value: await promise }
      } catch (error) {
        return { ok: false as const, error }
      }
    }

    for (const scenario of [scenarios.redeemRaceA, scenarios.redeemRaceB, scenarios.redeemRaceC]) {
      const txId = await createPendingTx(scenario)
      await store.upsertMeetupToken(txId, {
        tokenHash: TOKEN_HASH,
        codeHash: CODE_HASH,
        issuedBy: seller,
      })

      const [redeem, cancelOut] = await Promise.all([
        settle(store.consumeMeetupToken(txId, buyer1, { kind: 'code', hash: CODE_HASH })),
        settle(store.cancel(txId, seller)),
      ])

      // 不变量 1：没有一方因死锁（或任何非预期错误）失败。
      // 核销唯一可接受的失败是「持锁时交易已离开 PENDING」的竞态错误。
      if (!redeem.ok) expect(redeem.error).toBeInstanceOf(MeetupConsumeRaceError)
      // 不变量 2：PENDING 上的 cancel 不受凭证影响，必然成功（#11 冻结语义）
      expect(cancelOut.ok).toBe(true)
      if (!cancelOut.ok) throw new Error('unreachable')
      expect(cancelOut.value.kind).toBe('ok')

      // 不变量 3：无论谁先拿到交易行锁，终态迁移都必然销毁凭证行
      expect(await store.findMeetupToken(txId)).toBeNull()
      const tx = rows(
        await db.execute(sql`SELECT status::text AS status FROM transactions WHERE id = ${txId}`),
      )[0] as { status: string }
      expect(tx.status).toBe('CANCELLED')
    }
  })

  test('失败计数绑定凭证代际：哈希换代后旧请求的失败不污染新码（审查 P1）', async () => {
    const txId = await createPendingTx(scenarios.generation)
    const V1_TOKEN = 'f'.repeat(64)
    const V1_CODE = 'e'.repeat(64)
    await store.upsertMeetupToken(txId, {
      tokenHash: V1_TOKEN,
      codeHash: V1_CODE,
      issuedBy: seller,
    })
    // 旧代凭证上的两次失败
    const first = await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: V1_TOKEN, codeHash: V1_CODE },
      5,
      600,
    )
    expect(first?.failedAttempts).toBe(1)
    // 哈希换代（历史行自愈）→ 新一代凭证（哈希覆写、计数归零）
    const V2_TOKEN = '9'.repeat(64)
    const V2_CODE = '8'.repeat(64)
    await store.upsertMeetupToken(txId, {
      tokenHash: V2_TOKEN,
      codeHash: V2_CODE,
      issuedBy: seller,
    })
    // 并发中的旧请求此刻才落计数：代际不匹配 → 被丢弃
    const stale = await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: V1_TOKEN, codeHash: V1_CODE },
      5,
      600,
    )
    expect(stale).toBeNull()
    const fresh = await store.findMeetupToken(txId)
    expect(fresh?.failed_attempts).toBe(0)
    expect(fresh?.locked_until).toBeNull()
    // 新一代上的失败照常累计
    const counted = await store.recordMeetupTokenFailure(
      txId,
      { tokenHash: V2_TOKEN, codeHash: V2_CODE },
      5,
      600,
    )
    expect(counted?.failedAttempts).toBe(1)
  })
})
