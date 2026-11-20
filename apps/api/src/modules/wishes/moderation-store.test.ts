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
    // 审计行同时按 actor 与 target 清：decide 的 target_id 是记录 id，而 record 会随 wishes 级联删除。
    await db.execute(sql`
      DELETE FROM admin_audit_logs
      WHERE actor_user_id = ${userId}::uuid
         OR (target_type = 'WISH_MODERATION_RECORD'
             AND target_id IN (
               SELECT r.id FROM wish_moderation_records r
               JOIN wishes w ON w.id = r.wish_id
               WHERE w.user_id = ${userId}::uuid
             ))
    `)
    for (const id of ids) {
      await db.execute(sql`DELETE FROM wishes WHERE id = ${id}::uuid`)
    }
    await db.execute(sql`DELETE FROM admin_audit_logs WHERE actor_user_id = ${userId}::uuid`)
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

  test('同一愿望反复进入 REVIEW：复用待审版本且不撞唯一索引；放行后按新版本公开', async () => {
    const store = createSqlWishModerationStore(db)
    const wishId = await createWish('APPROVED')
    const first = newId()
    await insertWishModerationRecord(db, wishId, userId, baseRecord(2))
    await db.execute(
      sql`UPDATE wishes SET pending_keyword = '第一次待审', pending_version = 2 WHERE id = ${wishId}::uuid`,
    )
    // 模拟第二次 REVIEW 编辑：同版本覆盖 pending 记录，不应 23505。
    await db.execute(
      sql`DELETE FROM wish_moderation_records WHERE wish_id = ${wishId}::uuid AND status = 'PENDING'`,
    )
    await insertWishModerationRecord(db, wishId, userId, {
      ...baseRecord(2),
      keyword: '第二次待审',
    })
    const [pending] = (await db.execute(
      sql`SELECT id FROM wish_moderation_records WHERE wish_id = ${wishId}::uuid AND status = 'PENDING'`,
    )) as unknown as { id: string }[]
    expect(pending?.id).toBeString()

    const decided = await store.decide({
      recordId: pending?.id as string,
      decision: 'ALLOW',
      reason: '放行第二次编辑',
      version: 0,
      actorUserId: userId,
    })
    expect(decided.outcome).toBe('applied')
    const [wish] = (await db.execute(
      sql`SELECT keyword, content_version, pending_version, moderation_status
          FROM wishes WHERE id = ${wishId}::uuid`,
    )) as unknown as {
      keyword: string
      content_version: number
      pending_version: number | null
      moderation_status: string
    }[]
    expect(wish).toMatchObject({
      keyword: '第二次待审',
      content_version: 2,
      pending_version: null,
      moderation_status: 'APPROVED',
    })
    // 审计落库（P0-3）。
    const audits = (await db.execute(
      sql`SELECT action, target_type FROM admin_audit_logs WHERE target_id = ${pending?.id}::uuid`,
    )) as unknown as { action: string; target_type: string }[]
    expect(audits).toEqual([
      { action: 'WISH_MODERATION_DECISION', target_type: 'WISH_MODERATION_RECORD' },
    ])
    expect(first).toBeString()
  })

  test('REJECTED 愿望不能被剩余待审记录复活', async () => {
    const store = createSqlWishModerationStore(db)
    const wishId = await createWish('PENDING_REVIEW')
    const recordId = newId()
    await insertWishModerationRecord(db, wishId, userId, baseRecord(1))
    const [row] = (await db.execute(
      sql`SELECT id FROM wish_moderation_records WHERE wish_id = ${wishId}::uuid`,
    )) as unknown as { id: string }[]
    const blocked = await store.decide({
      recordId: row?.id as string,
      decision: 'BLOCK',
      reason: '拒绝',
      version: 0,
      actorUserId: userId,
    })
    expect(blocked.outcome).toBe('applied')
    // 再放行同一记录：已 SETTLED 且异结论 → conflict，不会把 REJECTED 改回 APPROVED。
    const again = await store.decide({
      recordId: row?.id as string,
      decision: 'ALLOW',
      reason: '试图复活',
      version: 0,
      actorUserId: userId,
    })
    expect(again.outcome).toBe('conflict')
    const [wish] = (await db.execute(
      sql`SELECT moderation_status FROM wishes WHERE id = ${wishId}::uuid`,
    )) as unknown as { moderation_status: string }[]
    expect(wish?.moderation_status).toBe('REJECTED')
    expect(recordId).toBeString()
  })
})
