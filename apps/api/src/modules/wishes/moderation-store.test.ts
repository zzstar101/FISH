import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import {
  createSqlWishModerationStore,
  insertWishModerationRecord,
  type WishModerationRecordInput,
} from './moderation-store'

const databaseUrl = process.env.DATABASE_URL
const describeDb = databaseUrl ? describe : describe.skip

const baseRecord = (version: number): WishModerationRecordInput => ({
  keyword: '待审关键词',
  description: '待审描述',
  version,
  machineDecision: 'REVIEW',
  decision: 'REVIEW',
  provider: 'LOCAL',
  providerRequestId: null,
  policyVersion: 'test',
  suggestion: 'Review',
  label: null,
  subLabel: null,
  score: null,
  matchedRules: [],
  matchedTermsMasked: [],
})

describeDb('wish moderation store (#694 M5)', () => {
  let db: Db
  const userId = newId()
  const ids: string[] = []

  beforeAll(async () => {
    db = createDb(databaseUrl as string)
    await db.execute(sql`INSERT INTO users (id, nickname) VALUES (${userId}::uuid, '待审作者')`)
  })

  afterAll(async () => {
    for (const id of ids) {
      await db.execute(sql`DELETE FROM wishes WHERE id = ${id}::uuid`)
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`)
  })

  async function createWish(mode: 'PENDING_REVIEW' | 'APPROVED', pendingVersion?: number) {
    const id = newId()
    ids.push(id)
    await db.execute(sql`
      INSERT INTO wishes (id, user_id, keyword, category, budget_min_cents, budget_max_cents,
                          accept_similar, status, moderation_status,
                          pending_keyword, pending_description, pending_version)
      VALUES (${id}::uuid, ${userId}::uuid, '公开关键词', 'DIGITAL', 10000, 20000, true, 'ACTIVE',
              ${mode}::wish_moderation_status,
              ${pendingVersion ? '待审关键词' : null}, ${pendingVersion ? '待审描述' : null},
              ${pendingVersion ?? null})
    `)
    return id
  }

  test('新建待审 ALLOW 后公开；同结论重放、异结论冲突', async () => {
    const store = createSqlWishModerationStore(db)
    const wishId = await createWish('PENDING_REVIEW')
    const recordId = newId()
    await insertWishModerationRecord(db, wishId, userId, baseRecord(1))
    const [row] = (await db.execute(
      sql`SELECT id FROM wish_moderation_records WHERE wish_id = ${wishId}::uuid`,
    )) as unknown as { id: string }[]
    expect(row?.id).toBeDefined()
    const actualRecordId = row?.id ?? recordId

    const decided = await store.decide({
      recordId: actualRecordId,
      decision: 'ALLOW',
      reason: '人工放行',
      version: 0,
      actorUserId: userId,
    })
    expect(decided).toMatchObject({ outcome: 'applied', decision: 'ALLOW', initial: true })
    const [wish] = (await db.execute(
      sql`SELECT moderation_status FROM wishes WHERE id = ${wishId}::uuid`,
    )) as unknown as { moderation_status: string }[]
    expect(wish?.moderation_status).toBe('APPROVED')
    const [record] = (await db.execute(
      sql`SELECT status, version FROM wish_moderation_records WHERE id = ${actualRecordId}::uuid`,
    )) as unknown as { status: string; version: number }[]
    expect(record).toMatchObject({ status: 'SETTLED', version: 1 })

    const replay = await store.decide({
      recordId: actualRecordId,
      decision: 'ALLOW',
      reason: '重复提交',
      version: 0,
      actorUserId: userId,
    })
    expect(replay.outcome).toBe('replayed')
    const conflict = await store.decide({
      recordId: actualRecordId,
      decision: 'BLOCK',
      reason: '改判',
      version: 1,
      actorUserId: userId,
    })
    expect(conflict.outcome).toBe('conflict')
  })

  test('编辑待审 ALLOW：公开字段切换、版本 +1、pending 清空', async () => {
    const store = createSqlWishModerationStore(db)
    const wishId = await createWish('APPROVED', 2)
    await insertWishModerationRecord(db, wishId, userId, baseRecord(2))
    const [row] = (await db.execute(
      sql`SELECT id FROM wish_moderation_records WHERE wish_id = ${wishId}::uuid`,
    )) as unknown as { id: string }[]

    const decided = await store.decide({
      recordId: row?.id as string,
      decision: 'ALLOW',
      reason: '放行编辑',
      version: 0,
      actorUserId: userId,
    })
    expect(decided).toMatchObject({ outcome: 'applied', initial: false })
    const [wish] = (await db.execute(sql`
      SELECT keyword, description, content_version, pending_keyword, pending_version
      FROM wishes WHERE id = ${wishId}::uuid
    `)) as unknown as {
      keyword: string
      description: string
      content_version: number
      pending_keyword: string | null
      pending_version: number | null
    }[]
    expect(wish).toMatchObject({
      keyword: '待审关键词',
      description: '待审描述',
      content_version: 2,
      pending_keyword: null,
      pending_version: null,
    })
  })

  test('新建待审 BLOCK：愿望标记 REJECTED，不公开', async () => {
    const store = createSqlWishModerationStore(db)
    const wishId = await createWish('PENDING_REVIEW')
    await insertWishModerationRecord(db, wishId, userId, baseRecord(1))
    const [row] = (await db.execute(
      sql`SELECT id FROM wish_moderation_records WHERE wish_id = ${wishId}::uuid`,
    )) as unknown as { id: string }[]
    const decided = await store.decide({
      recordId: row?.id as string,
      decision: 'BLOCK',
      reason: '违规',
      version: 0,
      actorUserId: userId,
    })
    expect(decided).toMatchObject({ outcome: 'applied', decision: 'BLOCK', initial: true })
    const [wish] = (await db.execute(
      sql`SELECT moderation_status FROM wishes WHERE id = ${wishId}::uuid`,
    )) as unknown as { moderation_status: string }[]
    expect(wish?.moderation_status).toBe('REJECTED')
  })
})
