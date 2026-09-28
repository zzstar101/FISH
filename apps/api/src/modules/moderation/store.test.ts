import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, sql } from 'drizzle-orm'
import { createSqlModerationStore, type ModerationDbTransaction } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `moderation-store-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '集成测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

type ReviewFixture = { sellerId: string; listingId: string; recordId: string }

/**
 * 一条待人工处理的审核中商品：`listings.moderation_status = 'REVIEW'` + 最新 REVIEW 记录。
 * 每个用例自建、自清（jobs 无外键只能按 payload 清，审核记录引用 users 必须比 users 先删）。
 */
async function withReviewListing(run: (fixture: ReviewFixture) => Promise<void>) {
  const sellerId = await createUser()
  const listingId = newId()
  await db.insert(listings).values({
    id: listingId,
    listingNo: await reserveTestListingNo(db, listingId),
    sellerId,
    title: '待人工审核的商品',
    description: '集成测试',
    priceCents: 1000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'OFFLINE',
    moderationStatus: 'REVIEW',
  })
  const recordId = newId()
  await db.insert(listingModerationRecords).values({
    id: recordId,
    listingId,
    sellerId,
    action: 'CREATE',
    titleSnapshot: '待人工审核的商品',
    descriptionSnapshot: '集成测试',
    decision: 'REVIEW',
    matchedRules: [],
    matchedTermsMasked: [],
    ruleVersion: 'test-rule-v1',
    priorListingStatus: null,
  })

  try {
    await run({ sellerId, listingId, recordId })
  } finally {
    await db.delete(jobs).where(sql`${jobs.payload}->>'listingId' = ${listingId}`)
    await db.delete(listingModerationRecords).where(eq(listingModerationRecords.sellerId, sellerId))
    await db.delete(listings).where(eq(listings.id, listingId))
    await db.delete(users).where(eq(users.id, sellerId))
  }
}

async function listingState(listingId: string) {
  const [row] = await db
    .select({ status: listings.status, moderationStatus: listings.moderationStatus })
    .from(listings)
    .where(eq(listings.id, listingId))
  return row
}

async function moderationActions(listingId: string) {
  const rows = await db
    .select({
      action: listingModerationRecords.action,
      decision: listingModerationRecords.decision,
    })
    .from(listingModerationRecords)
    .where(eq(listingModerationRecords.listingId, listingId))
  return rows.map((row) => `${row.action}:${row.decision}`)
}

test('人工放行在 listings 更新之后调用图片结算钩子，参数为 listingId 与 decision', async () => {
  await withReviewListing(async ({ listingId, recordId }) => {
    const calls: { listingId: string; decision: string; statusAtCall: unknown }[] = []
    const store = createSqlModerationStore(db, {
      settleListingMedia: async (tx, input) => {
        // 钩子必须看到同一事务里已经写好的商品结论：否则「放行」与「图片转公开」之间
        // 存在一个卖家编辑能把商品压回人工队列的窗口。
        const rows = rowsOf(
          await tx.execute(
            sql`SELECT moderation_status::text AS moderation_status FROM listings WHERE id = ${input.listingId}`,
          ),
        )
        calls.push({
          listingId: input.listingId,
          decision: input.decision,
          statusAtCall: rows[0]?.moderation_status,
        })
      },
    })

    const result = await db.transaction((tx) =>
      store.decideWithin(tx, { recordId, decision: 'ALLOW', reason: '人工放行' }),
    )

    expect(result.kind).toBe('applied')
    expect(calls).toEqual([{ listingId, decision: 'ALLOW', statusAtCall: 'APPROVED' }])
    expect(await listingState(listingId)).toEqual({
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
    })
    expect(await moderationActions(listingId)).toEqual(['CREATE:REVIEW', 'MANUAL_DECISION:ALLOW'])
  })
})

test('人工下架同样调用结算钩子，商品转为 BLOCKED 且 OFFLINE', async () => {
  await withReviewListing(async ({ listingId, recordId }) => {
    const calls: { decision: string }[] = []
    const store = createSqlModerationStore(db, {
      settleListingMedia: async (_tx, input) => {
        calls.push({ decision: input.decision })
      },
    })

    const result = await db.transaction((tx) =>
      store.decideWithin(tx, { recordId, decision: 'BLOCK', reason: '人工下架' }),
    )

    expect(result.kind).toBe('applied')
    expect(calls).toEqual([{ decision: 'BLOCK' }])
    expect(await listingState(listingId)).toEqual({
      status: 'OFFLINE',
      moderationStatus: 'BLOCKED',
    })
  })
})

test('结算钩子失败时整个决策回滚，不留下列表已放行、图片未结算的半截状态', async () => {
  await withReviewListing(async ({ listingId, recordId }) => {
    const store = createSqlModerationStore(db, {
      settleListingMedia: async () => {
        throw new Error('对象存储不可用')
      },
    })

    await expect(
      db.transaction((tx) =>
        store.decideWithin(tx, { recordId, decision: 'ALLOW', reason: '人工放行' }),
      ),
    ).rejects.toThrow('对象存储不可用')

    expect(await listingState(listingId)).toEqual({ status: 'OFFLINE', moderationStatus: 'REVIEW' })
    expect(await moderationActions(listingId)).toEqual(['CREATE:REVIEW'])
  })
})

test('不是人工队列中的商品直接冲突，结算钩子不被调用', async () => {
  await withReviewListing(async ({ listingId, recordId }) => {
    let called = 0
    const store = createSqlModerationStore(db, {
      settleListingMedia: async () => {
        called += 1
      },
    })
    await db
      .update(listings)
      .set({ moderationStatus: 'APPROVED' })
      .where(eq(listings.id, listingId))

    const result = await db.transaction((tx) =>
      store.decideWithin(tx, { recordId, decision: 'ALLOW', reason: '人工放行' }),
    )

    expect(result.kind).toBe('conflict')
    expect(called).toBe(0)
  })
})

test('未注入结算钩子时决策行为不变（无图片链路的调用方）', async () => {
  await withReviewListing(async ({ listingId, recordId }) => {
    const store = createSqlModerationStore(db)
    const result = await db.transaction((tx: ModerationDbTransaction) =>
      store.decideWithin(tx, { recordId, decision: 'ALLOW', reason: '人工放行' }),
    )

    expect(result.kind).toBe('applied')
    expect(await listingState(listingId)).toEqual({
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
    })
  })
})
