import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlConversationStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 wishes store.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_conversation_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlConversationStore(db)

const buyer = '01990000-0000-7000-8000-0000000000a1'
const seller = '01990000-0000-7000-8000-0000000000a2'
const outsider = '01990000-0000-7000-8000-0000000000a3'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const listingB = '01990000-0000-7000-8000-0000000000b2'

async function seedListing(listingId: string, sellerId: string, title: string) {
  await db.execute(sql`
    INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listingId}, ${sellerId}, ${title}, '测试商品', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
}

/**
 * 按 **service 的口径**把一页会话列表汇总成未读数：store 多取 limit+1 行判底，
 * service 会丢弃多出的那一行（`service.ts` 的 `page.slice(0, limit)`）。
 * 用它构造「列表行相加」这一侧，与 `countUnread` 对账。
 */
async function sumListedUnread(viewerId: string, limit: number) {
  const rows = await store.listForUser(viewerId, { limit, cursor: null })
  return rows.slice(0, limit).reduce((sum, row) => sum + row.unreadCount, 0)
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [buyer, seller, outsider].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`conv${process.pid}_${i}`}, 'test-hash', '会话测试')
    `)
  }
  await seedListing(listingA, seller, 'K380 键盘')
  await seedListing(listingB, seller, '台灯')
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('conversations store (integration)', () => {
  test('insertIfAbsent creates once and reuses via findIdByListingAndBuyer', async () => {
    const inserted = await store.insertIfAbsent(listingA, buyer, seller)
    if (!inserted) throw new Error('unreachable')
    const createdId = inserted.id

    // 并发创建：唯一索引 (listing_id, buyer_id) 保证只赢一个
    const results = await Promise.all([
      store.insertIfAbsent(listingA, buyer, seller),
      store.insertIfAbsent(listingA, buyer, seller),
      store.insertIfAbsent(listingA, buyer, seller),
    ])
    expect(results.every((row) => row === null)).toBe(true)
    expect(await store.findIdByListingAndBuyer(listingA, buyer)).toBe(createdId)
  })

  test('findDetail returns role data for participants and null for outsiders', async () => {
    const conversationId = await store.findIdByListingAndBuyer(listingA, buyer)
    if (!conversationId) throw new Error('unreachable')

    const buyerView = await store.findDetail(conversationId, buyer)
    expect(buyerView?.conversation.buyer_id).toBe(buyer)
    expect(buyerView?.listing.title).toBe('K380 键盘')
    expect(buyerView?.counterpart.id).toBe(seller)
    expect(buyerView?.unreadCount).toBe(0)
    expect(buyerView?.lastMessage).toBeNull() // 还没有任何消息

    expect(await store.findDetail(conversationId, outsider)).toBeNull()
  })

  test('unreadCount counts counterpart and SYSTEM messages after my last read', async () => {
    const conversationId = await store.findIdByListingAndBuyer(listingA, buyer)
    if (!conversationId) throw new Error('unreachable')

    // 显式递增 created_at：同语句 now() 三行相同会让 (created_at, id) 决胜落到
    // 随机的 uuidv4 上，"最新一条"（及 unread 的边界）就不确定了。
    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at) VALUES
        (${crypto.randomUUID()}, ${conversationId}, ${seller}, 'TEXT', '在吗', now() - interval '4 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, NULL, 'SYSTEM', '系统提示', now() - interval '3 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, ${buyer}, 'TEXT', '我自己发的', now() - interval '2 seconds')
    `)
    // #67 第四步：媒体消息也要能当摘要，而且 content 由服务端翻成可读文案。
    // 必须连带写 message_media —— 少了它 last_message_media_kind 是 NULL，
    // 摘要只会退化成 `[媒体]`，就测不出「图片 / 语音」的区分。
    const mediaMessageId = crypto.randomUUID()
    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at) VALUES
        (${mediaMessageId}, ${conversationId}, ${seller}, 'MEDIA', '[media]', now() - interval '1 second')
    `)
    await db.execute(sql`
      INSERT INTO message_media (id, message_id, conversation_id, owner_id, kind, object_key, mime_type, size_bytes, width, height) VALUES
        (${crypto.randomUUID()}, ${mediaMessageId}, ${conversationId}, ${seller}, 'IMAGE',
         ${`conv-test/${mediaMessageId}.jpg`}, 'image/jpeg', 1024, 800, 600)
    `)

    const beforeRead = await store.findDetail(conversationId, buyer)
    expect(beforeRead?.unreadCount).toBe(3) // 对方 TEXT + SYSTEM + 对方的图片；自己发的不算
    // lastMessage 摘要 = created_at 最晚的一条（这里是对头发来的图片）
    expect(beforeRead?.lastMessage).toMatchObject({
      type: 'MEDIA',
      content: '[图片]',
      senderId: seller,
    })
    const sellerView = await store.findDetail(conversationId, seller)
    expect(sellerView?.unreadCount).toBe(2) // 买家的一条 + SYSTEM（SYSTEM 对双方都计未读）
    // 卖家视角的最后一条是**自己发的图**，同样要能出摘要
    expect(sellerView?.lastMessage).toMatchObject({
      type: 'MEDIA',
      content: '[图片]',
      senderId: seller,
    })

    const afterRead = await store.markRead(conversationId, buyer)
    expect(afterRead?.unreadCount).toBe(0)
    // 卖家的未读不受买家标记影响（买家消息 + SYSTEM，共 2 条）
    expect((await store.findDetail(conversationId, seller))?.unreadCount).toBe(2)
  })

  test('markRead returns null for a non-participant', async () => {
    const conversationId = await store.findIdByListingAndBuyer(listingA, buyer)
    if (!conversationId) throw new Error('unreachable')
    expect(await store.markRead(conversationId, outsider)).toBeNull()
  })

  test('listForUser pages by (last_message_at, id) DESC with no gap or repeat on ties', async () => {
    // 两个会话同毫秒创建：last_message_at 相同到微秒，只能靠 id 决出顺序
    for (const listingId of [listingB, listingA]) {
      await store.insertIfAbsent(listingId, buyer, seller)
    }
    const conversationB = await store.findIdByListingAndBuyer(listingB, buyer)
    if (!conversationB) throw new Error('unreachable')
    // 给两个会话写消息，让 last_message_at 尽量接近；再把 A 的消息时间戳改成与 B 完全相同
    await db.execute(sql`
      UPDATE conversations SET last_message_at = '2026-09-12 10:00:00.123456+00'
      WHERE id IN (${conversationB}, (SELECT id FROM conversations WHERE listing_id = ${listingA} AND buyer_id = ${buyer}))
    `)

    const page1 = await store.listForUser(buyer, { limit: 1, cursor: null })
    expect(page1).toHaveLength(2) // limit+1 判底行
    // store 契约：返回 limit+1 行，service 丢弃多余行后用**保留页的最后一行**生成游标
    const kept = page1.slice(0, 1)
    const last = kept.at(-1)
    if (!last?.lastMessageAtCursor) throw new Error('unreachable')
    expect(last.lastMessageAtCursor).toBe('2026-09-12T10:00:00.123456Z')

    const page2 = await store.listForUser(buyer, {
      limit: 1,
      cursor: { sortKey: last.lastMessageAtCursor, id: last.conversation.id },
    })
    expect(page2).toHaveLength(1)
    // 翻页不重不漏：两页的 id 集合恰好是全部两个会话
    const ids = new Set([page1[0]?.conversation.id, page2[0]?.conversation.id])
    expect(ids.size).toBe(2)

    // 卖家视角同样能看到两个会话
    const sellerList = await store.listForUser(seller, { limit: 10, cursor: null })
    expect(sellerList).toHaveLength(2)
  })

  test('countUnread 判据与列表行恒等：MEDIA 计入、SYSTEM 计入、自己发的不计、读位边界生效', async () => {
    const buyerE = '01990000-0000-7000-8000-0000000000a8'
    const sellerE = '01990000-0000-7000-8000-0000000000a9'
    const listingE = '01990000-0000-7000-8000-0000000000b4'
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname) VALUES
        (${buyerE}, ${`conv${process.pid}_e0`}, 'test-hash', '会话测试'),
        (${sellerE}, ${`conv${process.pid}_e1`}, 'test-hash', '会话测试')
    `)
    await seedListing(listingE, sellerE, '判据商品')
    const inserted = await store.insertIfAbsent(listingE, buyerE, sellerE)
    if (!inserted) throw new Error('unreachable')
    const conversationId = inserted.id

    // 显式秒级递减的时间轴（旧 → 新）：读位边界是确定值，不指望 now() 的相对先后。
    // 未读 = **晚于**读位，所以「该计未读的」必须落在时间轴的新端。
    //
    // ② MEDIA 刻意放在**买家读位之后、且由对方发出**（#67 第四步：媒体计入未读）：
    //    只发了图片也必须有红点，否则用户无从得知对方回了消息。
    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at) VALUES
        (${crypto.randomUUID()}, ${conversationId}, ${sellerE}, 'TEXT', '①读位之前的旧消息', now() - interval '60 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, ${buyerE}, 'TEXT', '②买家发的 A', now() - interval '50 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, ${buyerE}, 'TEXT', '③买家发的 B', now() - interval '40 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, ${sellerE}, 'TEXT', '④对方未读', now() - interval '30 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, ${sellerE}, 'MEDIA', '{}', now() - interval '20 seconds'),
        (${crypto.randomUUID()}, ${conversationId}, NULL, 'SYSTEM', '⑤系统未读', now() - interval '10 seconds')
    `)
    // 买家读位落在 ③ 与 ④ 之间：①②③ 已读，④⑤ 未读。
    await db.execute(sql`
      UPDATE conversations SET buyer_last_read_at = now() - interval '35 seconds' WHERE id = ${conversationId}
    `)

    // 买家：④ 对方 TEXT + MEDIA（对方发的图）+ ⑤ SYSTEM = 3；① 在读位之前、②③ 自己发的不计。
    // 卖家：从未读过 → ②③ 买家 TEXT + ⑤ SYSTEM = 3；①④ 自己发的、MEDIA 也是卖家自己发的。
    const expected = { buyer: 3, seller: 3 }

    expect(await store.countUnread(buyerE)).toBe(expected.buyer)
    expect(await store.countUnread(sellerE)).toBe(expected.seller)
    // 需求要求的恒等式：聚合端点必须等于列表行相加。判据任一分支写错，两式就会分叉。
    expect(await sumListedUnread(buyerE, 20)).toBe(expected.buyer)
    expect(await sumListedUnread(sellerE, 20)).toBe(expected.seller)
  })

  test('countUnread 聚合全部会话，不随列表单页上限漏计（#67）', async () => {
    // 专用买卖双方：不占用 buyer/seller 的会话列表，本用例与其它用例的执行顺序无关。
    const buyerD = '01990000-0000-7000-8000-0000000000a6'
    const sellerD = '01990000-0000-7000-8000-0000000000a7'
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname) VALUES
        (${buyerD}, ${`conv${process.pid}_d0`}, 'test-hash', '会话测试'),
        (${sellerD}, ${`conv${process.pid}_d1`}, 'test-hash', '会话测试')
    `)

    // 21 个会话 > 列表默认 limit（20）：把「取一页 unreadCount 再相加」的实现钉死，
    // 那种写法在这里只会数到 20。这正是专用未读端点存在的理由。
    const total = 21
    for (let i = 0; i < total; i++) {
      const listingId = `01990000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`
      await seedListing(listingId, sellerD, `批量商品 ${i}`)
      const inserted = await store.insertIfAbsent(listingId, buyerD, sellerD)
      if (!inserted) throw new Error('unreachable')
      await db.execute(sql`
        INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at)
        VALUES (${crypto.randomUUID()}, ${inserted.id}, ${sellerD}, 'TEXT', '未读', now() - interval '1 second')
      `)
    }

    expect(await store.countUnread(buyerD)).toBe(total)
    // 「取一页列表再求和」的写法在这里只会数到 20（store 多取的那 1 行是判底用的，
    // service 会丢掉它）——这就是专用未读端点存在的理由。
    expect(await sumListedUnread(buyerD, 20)).toBe(total - 1)
    // 把单页放得足够大一页取全时，列表行相加与聚合端点必须相等（恒等式在跨会话时也成立）。
    expect(await sumListedUnread(buyerD, 50)).toBe(total)
    // 卖家一侧没有未读（这些消息都是卖家自己发的）。
    expect(await store.countUnread(sellerD)).toBe(0)
  })

  test('coverObjectKeys 只认 sort_order = 0：缺 0 号图时返回 null，不拿其它序号顶替', async () => {
    await db.execute(sql`
      INSERT INTO listing_images (id, listing_id, object_key, sort_order) VALUES
        (${crypto.randomUUID()}, ${listingA}, 'covers/second.jpg', 1),
        (${crypto.randomUUID()}, ${listingA}, 'covers/first.jpg', 0),
        (${crypto.randomUUID()}, ${listingB}, 'covers/b-only-1.jpg', 1)
    `)
    const covers = await store.coverObjectKeys([listingA, listingB])
    expect(covers.get(listingA)).toBe('covers/first.jpg') // 0 号图存在 → 取它（不是最大序号）
    // listingB 有图但没有 0 号图 → null。旧实现（取最小 sort_order）在这里会返回
    // covers/b-only-1.jpg，因此这一条正是 #40/F3 的「修复前会失败」用例。
    expect(covers.get(listingB)).toBeNull()
  })

  test('markRead 读位单调：后开始的事务先提交后，先开始的事务不把读位写回更早', async () => {
    // 专用买卖双方 + 独立会话：不占用 buyer/seller 的会话列表，本用例与其它用例的执行顺序无关。
    const buyerC = '01990000-0000-7000-8000-0000000000a4'
    const sellerC = '01990000-0000-7000-8000-0000000000a5'
    const listingC = '01990000-0000-7000-8000-0000000000b3'
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname) VALUES
        (${buyerC}, ${`conv${process.pid}_c0`}, 'test-hash', '会话测试'),
        (${sellerC}, ${`conv${process.pid}_c1`}, 'test-hash', '会话测试')
    `)
    await seedListing(listingC, sellerC, '降噪耳机')
    const inserted = await store.insertIfAbsent(listingC, buyerC, sellerC)
    if (!inserted) throw new Error('unreachable')
    const conversationId = inserted.id

    const rowsOf = (result: unknown): Record<string, unknown>[] => {
      if (Array.isArray(result)) return result as Record<string, unknown>[]
      return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<
        string,
        unknown
      >[]
    }

    // 事务开始时刻的毫秒值（now() 在事务内被固定，用它做「谁更早」的判据）。
    const txStartedAt = async (tx: Db) => {
      const rows = rowsOf(await tx.execute(sql`SELECT now() AS started_at`))
      return new Date(rows[0]?.started_at as Date | string).getTime()
    }

    // 在事务里跑 store.markRead，返回写后的读位毫秒值。
    const markReadInTx = async (tx: Db) => {
      const detail = await createSqlConversationStore(tx).markRead(conversationId, buyerC)
      const readAt = detail?.conversation.buyer_last_read_at
      if (readAt == null) throw new Error('unreachable')
      return new Date(readAt).getTime()
    }

    let signalT1Started: () => void = () => {}
    const t1Started = new Promise<void>((resolve) => {
      signalT1Started = resolve
    })
    let signalT2Committed: () => void = () => {}
    const t2Committed = new Promise<void>((resolve) => {
      signalT2Committed = resolve
    })

    // 竞态构造：T1 先 BEGIN（now() 更早）但要等 T2 提交后才 UPDATE；
    // T2 后 BEGIN（now() 更晚）却先拿行锁、先提交。
    const t1 = db.transaction(async (tx) => {
      const startedAt = await txStartedAt(tx as unknown as Db)
      signalT1Started()
      await t2Committed
      return { startedAt, readAt: await markReadInTx(tx as unknown as Db) }
    })
    await t1Started
    await Bun.sleep(30) // 保证 T2 的 now() 严格晚于 T1
    const t2 = db
      .transaction(async (tx) => markReadInTx(tx as unknown as Db))
      .then((readAt) => {
        signalT2Committed()
        return readAt
      })

    const [t1Result, t2ReadAt] = await Promise.all([t1, t2])
    // 前提校验：T1 的事务确实更早，否则这个用例没有验证力。
    expect(t1Result.startedAt).toBeLessThan(t2ReadAt)

    const final = await store.findDetail(conversationId, buyerC)
    const finalReadAt = new Date(final?.conversation.buyer_last_read_at as Date).getTime()
    // 更晚的读位（T2）必须先提交，且不被后提交的 T1 回写覆盖。
    expect(finalReadAt).toBe(t2ReadAt)
  })
})
