import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { notifications } from '@fish/db/schema/notifications'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { desc, eq, sql } from 'drizzle-orm'
import { createListingMediaSettlement } from '../uploads/listing-media-settlement'
import { listingReviewMediaPrefix } from '../uploads/review-media'
import type { MediaStorage } from '../uploads/storage'
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

test('人工决策同事务写 MODERATION 通知（任务一 #89）：放行 APPROVED / 下架 REJECTED', async () => {
  // 放行：通知卖家 outcome=APPROVED，payload 带 listingId（读侧转公开 TypeID）
  await withReviewListing(async ({ sellerId, listingId, recordId }) => {
    const store = createSqlModerationStore(db)
    const result = await db.transaction((tx) =>
      store.decideWithin(tx, { recordId, decision: 'ALLOW', reason: '人工放行' }),
    )
    expect(result.kind).toBe('applied')
    const rows = await db.select().from(notifications).where(eq(notifications.userId, sellerId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('MODERATION')
    expect(rows[0]?.payload).toEqual({ listingId, outcome: 'APPROVED' })
  })

  // 下架：outcome=REJECTED；决策回滚（结算失败）时通知必须随之消失 —— 同一事务
  await withReviewListing(async ({ sellerId, listingId, recordId }) => {
    const store = createSqlModerationStore(db, {
      settleListingMedia: async () => {
        throw new Error('对象存储不可用')
      },
    })
    await expect(
      db.transaction((tx) =>
        store.decideWithin(tx, { recordId, decision: 'BLOCK', reason: '违规下架' }),
      ),
    ).rejects.toThrow('对象存储不可用')
    const rows = await db.select().from(notifications).where(eq(notifications.userId, sellerId))
    expect(rows).toHaveLength(0)

    // 重放一次成功路径，确认 REJECTED 形状
    const retry = createSqlModerationStore(db)
    const applied = await db.transaction((tx) =>
      retry.decideWithin(tx, { recordId, decision: 'BLOCK', reason: '违规下架' }),
    )
    expect(applied.kind).toBe('applied')
    const written = await db.select().from(notifications).where(eq(notifications.userId, sellerId))
    expect(written).toHaveLength(1)
    expect(written[0]?.payload).toEqual({ listingId, outcome: 'REJECTED' })
  })
})

/**
 * #228 §6：人工改判是「provider 维度」的一种（`MANUAL`），必须能与机器结论、以及 #228 之前的
 * 历史行区分开 —— 这条断言在补写 provider 之前会失败（那时恒为 NULL）。
 */
test('人工改判落库带 provider=MANUAL，且不伪造 provider 的 label/score', async () => {
  await withReviewListing(async ({ listingId: _listingId, recordId }) => {
    const store = createSqlModerationStore(db)

    const result = await db.transaction((tx) =>
      store.decideWithin(tx, { recordId, decision: 'ALLOW', reason: '人工放行' }),
    )
    expect(result.kind).toBe('applied')

    const rows = await db
      .select({
        provider: listingModerationRecords.provider,
        providerRequestId: listingModerationRecords.providerRequestId,
        suggestion: listingModerationRecords.suggestion,
        label: listingModerationRecords.label,
        subLabel: listingModerationRecords.subLabel,
        score: listingModerationRecords.score,
      })
      .from(listingModerationRecords)
      .where(eq(listingModerationRecords.action, 'MANUAL_DECISION'))
      .orderBy(desc(listingModerationRecords.createdAt))
      .limit(1)

    expect(rows[0]).toEqual({
      provider: 'MANUAL',
      providerRequestId: null,
      suggestion: null,
      label: null,
      subLabel: null,
      score: null,
    })
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

    // #322 M4 顺序不变量：人工放行是待审商品进入匹配链路的入口，投递必须 EMBED_LISTING 在前、
    // MATCH_LISTING 在后。按队列自己的领取键 `(run_at, id)` 排序（见 `claimNext`），断的是**入队时刻**
    // 的领取序（同事务、run_at 相同）；反序会让首轮 MATCH 跑在向量落库前。重试/回收推后 `run_at`
    // 之后的执行序反转是已知边界（M4 §6.1 末尾）。
    const queued = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(sql`${jobs.payload}->>'listingId' = ${listingId}`)
      .orderBy(jobs.runAt, jobs.id)
    expect(queued.map((row) => row.type)).toEqual(['EMBED_LISTING', 'MATCH_LISTING'])
  })
})

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4])

type SharedImageFixture = {
  sellerId: string
  blockedListingId: string
  blockedRecordId: string
  pendingListingId: string
  pendingRecordId: string
  reviewKey: string
  storage: MediaStorage
  writes: string[]
}

/**
 * 同一张审核图（私有键）被两个商品引用。客户端正常流程不会产生这种数据（每个表单都新传对象），
 * 但直接调 API 复用 confirm 返回的键就会 —— 人工结论因此可能对同一个键给出互相矛盾的判定。
 */
async function withSharedReviewImage(run: (fixture: SharedImageFixture) => Promise<void>) {
  const sellerId = await createUser()
  const blockedListingId = newId()
  const pendingListingId = newId()
  const recordIds = [newId(), newId()]
  for (const [index, listingId] of [blockedListingId, pendingListingId].entries()) {
    await db.insert(listings).values({
      id: listingId,
      listingNo: await reserveTestListingNo(db, listingId),
      sellerId,
      title: `共享审核图的商品 ${index}`,
      description: '集成测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
    })
    await db.insert(listingModerationRecords).values({
      id: recordIds[index] as string,
      listingId,
      sellerId,
      action: 'CREATE',
      titleSnapshot: `共享审核图的商品 ${index}`,
      descriptionSnapshot: '集成测试',
      decision: 'REVIEW',
      matchedRules: [],
      matchedTermsMasked: [],
      ruleVersion: 'test-rule-v1',
      priorListingStatus: null,
    })
  }

  const reviewKey = `${listingReviewMediaPrefix(sellerId)}${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.jpg`
  await db.insert(listingMediaObjects).values({
    userId: sellerId,
    stagingKey: `listing-media/${sellerId}/${newId()}.jpg`,
    finalKey: reviewKey,
    contentDigest: 'd'.repeat(64),
    providerMd5: null,
    moderationDecision: 'REVIEW',
    provider: 'LOCAL',
    providerRequestId: null,
  })
  await db.insert(listingImages).values([
    { listingId: blockedListingId, objectKey: reviewKey, sortOrder: 0 },
    { listingId: pendingListingId, objectKey: reviewKey, sortOrder: 0 },
  ])

  const objects = new Map<string, Uint8Array>([[reviewKey, IMAGE_BYTES]])
  const writes: string[] = []
  const storage: MediaStorage = {
    presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
    stat: async () => null,
    publicUrl: (key) => `https://cdn.test/${key}`,
    readMediaBytes: async (key) => objects.get(key) ?? null,
    writeMediaBytes: async (key, bytes) => {
      writes.push(key)
      objects.set(key, bytes)
    },
  }

  try {
    await run({
      sellerId,
      blockedListingId,
      blockedRecordId: recordIds[0] as string,
      pendingListingId,
      pendingRecordId: recordIds[1] as string,
      reviewKey,
      storage,
      writes,
    })
  } finally {
    await db
      .delete(jobs)
      .where(
        sql`${jobs.payload}->>'listingId' = ${blockedListingId} or ${jobs.payload}->>'listingId' = ${pendingListingId}`,
      )
    await db.delete(listingModerationRecords).where(eq(listingModerationRecords.sellerId, sellerId))
    await db.delete(listings).where(eq(listings.sellerId, sellerId))
    await db.delete(users).where(eq(users.id, sellerId))
  }
}

test('同一个键已被人工 BLOCK 后，另一个引用它的商品放行失败并整事务回滚', async () => {
  await withSharedReviewImage(
    async ({
      blockedListingId,
      blockedRecordId,
      pendingListingId,
      pendingRecordId,
      reviewKey,
      storage,
      writes,
    }) => {
      const store = createSqlModerationStore(db, {
        settleListingMedia: createListingMediaSettlement({ storage }),
      })

      const blocked = await db.transaction((tx) =>
        store.decideWithin(tx, {
          recordId: blockedRecordId,
          decision: 'BLOCK',
          reason: '人工下架',
        }),
      )
      expect(blocked.kind).toBe('applied')
      expect(await listingState(blockedListingId)).toEqual({
        status: 'OFFLINE',
        moderationStatus: 'BLOCKED',
      })

      // 阻断过的字节绝不能借第二个商品的 ALLOW 变成匿名可读的公开对象：决策整体回滚。
      await expect(
        db.transaction((tx) =>
          store.decideWithin(tx, {
            recordId: pendingRecordId,
            decision: 'ALLOW',
            reason: '人工放行',
          }),
        ),
      ).rejects.toThrow('审核图片已被人工阻断')

      expect(writes).toEqual([])
      expect(await listingState(pendingListingId)).toEqual({
        status: 'OFFLINE',
        moderationStatus: 'REVIEW',
      })
      expect(await moderationActions(pendingListingId)).toEqual(['CREATE:REVIEW'])
      const [row] = await db
        .select()
        .from(listingMediaObjects)
        .where(eq(listingMediaObjects.finalKey, reviewKey))
      expect(row?.settledDecision).toBe('BLOCK')
    },
  )
})
