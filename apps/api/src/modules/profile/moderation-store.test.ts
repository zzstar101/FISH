import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import {
  createSqlProfileModerationStore,
  type ProfileModerationRecordInput,
} from './moderation-store'
import { createSqlProfileStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 profile/store.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_profile_moderation_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlProfileModerationStore(db)
const profileStore = createSqlProfileStore(db)

const moderator = '01990000-0000-7000-8000-0000000000a0'
let seq = 0

/** 每个用例一个独立用户，避免「同一用户只有一条待审」的唯一索引互相干扰。 */
function nextUserId(): string {
  seq += 1
  return `01990000-0000-7000-8000-${String(seq).padStart(12, '0')}`
}

const reviewRecord = (
  overrides: Partial<ProfileModerationRecordInput> = {},
): ProfileModerationRecordInput => ({
  machineDecision: 'REVIEW',
  decision: 'REVIEW',
  provider: 'LOCAL',
  providerRequestId: null,
  policyVersion: 'local-v1',
  suggestion: 'Review',
  label: null,
  subLabel: 'PUBLIC_EXTERNAL_CONTACT',
  score: null,
  matchedRules: ['PUBLIC_EXTERNAL_CONTACT'],
  matchedTermsMasked: [],
  ...overrides,
})

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  await db.execute(sql`INSERT INTO users (id, nickname) VALUES (${moderator}, '管理员')`)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

async function createAuthor(overrides: { signature?: string | null; avatarUrl?: string } = {}) {
  const id = nextUserId()
  await db.execute(sql`
    INSERT INTO users (id, nickname, signature, avatar_url)
    VALUES (${id}, '公开昵称', ${overrides.signature ?? '公开签名'}, ${overrides.avatarUrl ?? null})
  `)
  return id
}

async function pendingRecordId(userId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT id FROM profile_moderation_records
    WHERE user_id = ${userId} AND status = 'PENDING'
  `)) as unknown as { id: string }[]
  const id = rows[0]?.id
  if (!id) throw new Error('待审记录未写入')
  return id
}

async function publicRow(userId: string) {
  const rows = (await db.execute(sql`
    SELECT nickname, signature, avatar_url FROM users WHERE id = ${userId}
  `)) as unknown as { nickname: string; signature: string | null; avatar_url: string | null }[]
  return rows[0]
}

describe('profile moderation store（#694 M5 昵称/签名）', () => {
  test('listPending 带出当前公开值，按时间倒序并支持游标分页', async () => {
    const older = await createAuthor()
    await profileStore.queuePendingProfileChange(older, { nickname: '待审老' }, reviewRecord())
    await Bun.sleep(2)
    const newer = await createAuthor()
    await profileStore.queuePendingProfileChange(newer, { nickname: '待审新' }, reviewRecord())
    await Bun.sleep(2)
    const newest = await createAuthor()
    await profileStore.queuePendingProfileChange(newest, { nickname: '待审最新' }, reviewRecord())

    // 限定到这三个用户，避免与其它用例的行混在一起比较顺序。
    const mine = (rows: Awaited<ReturnType<typeof store.listPending>>) =>
      rows.filter((row) => [older, newer, newest].includes(row.user_id))

    const firstPage = mine(await store.listPending({ limit: 2 }))
    expect(firstPage.map((row) => row.user_id)).toEqual([newest, newer])
    expect(firstPage[0]?.payload).toEqual({ nickname: '待审最新' })
    // 队列要能同时展示「放行后会变成什么」与「现在对外是什么」。
    expect(firstPage[0]?.current_nickname).toBe('公开昵称')
    expect(firstPage[0]?.current_signature).toBe('公开签名')

    const last = firstPage.at(-1)
    if (!last) throw new Error('第一页为空')
    const secondPage = mine(
      await store.listPending({
        before: { createdAt: new Date(last.created_at), id: last.id },
        limit: 2,
      }),
    )
    expect(secondPage.map((row) => row.user_id)).toEqual([older])
  })

  test('ALLOW：一次切换提交的列，未提交的列不动；写审计；重放不再写第二次', async () => {
    const userId = await createAuthor({ avatarUrl: 'https://cdn.test/old.jpg' })
    await profileStore.queuePendingProfileChange(
      userId,
      { nickname: '新的公开昵称', signature: null },
      reviewRecord(),
    )
    const recordId = await pendingRecordId(userId)

    const applied = await store.decide({
      recordId,
      decision: 'ALLOW',
      reason: '人工放行',
      version: 0,
      actorUserId: moderator,
    })
    expect(applied).toMatchObject({
      outcome: 'applied',
      decision: 'ALLOW',
      fields: ['nickname', 'signature'],
    })

    // 昵称切换 + 签名被显式清空（payload 里 key 存在且为 null）；头像没提交过，必须保持原值。
    expect(await publicRow(userId)).toEqual({
      nickname: '新的公开昵称',
      signature: null,
      avatar_url: 'https://cdn.test/old.jpg',
    })

    const [record] = (await db.execute(sql`
      SELECT status, decision, version, reviewed_by, review_note
      FROM profile_moderation_records WHERE id = ${recordId}
    `)) as unknown as {
      status: string
      decision: string
      version: number
      reviewed_by: string
      review_note: string
    }[]
    expect(record).toMatchObject({
      status: 'SETTLED',
      decision: 'ALLOW',
      version: 1,
      reviewed_by: moderator,
      review_note: '人工放行',
    })

    // 审计：目标类型/动作走新枚举值，正文不复制（before/after 只记状态与字段）。
    const [audit] = (await db.execute(sql`
      SELECT action, target_type, target_id, reason, before, after
      FROM admin_audit_logs WHERE target_id = ${recordId}
    `)) as unknown as {
      action: string
      target_type: string
      target_id: string
      reason: string
      before: { status: string; fields: string[] }
      after: { status: string; decision: string; applied: boolean }
    }[]
    expect(audit).toMatchObject({
      action: 'PROFILE_MODERATION_DECISION',
      target_type: 'PROFILE_MODERATION_RECORD',
      target_id: recordId,
      reason: '人工放行',
    })
    expect(audit?.before).toMatchObject({ status: 'PENDING', fields: ['nickname', 'signature'] })
    expect(audit?.after).toMatchObject({ status: 'SETTLED', decision: 'ALLOW', applied: true })

    // 「放行只切换一次」：之后用户又改了公开值，重放同一条记录不能把旧待审值盖回去。
    await db.execute(sql`UPDATE users SET nickname = '后来又改的' WHERE id = ${userId}`)
    const replay = await store.decide({
      recordId,
      decision: 'ALLOW',
      reason: '重复点击',
      version: 0,
      actorUserId: moderator,
    })
    expect(replay.outcome).toBe('replayed')
    expect((await publicRow(userId))?.nickname).toBe('后来又改的')
  })

  test('BLOCK：记录结算但公开值一个都不改（旧值继续对外可见）', async () => {
    const userId = await createAuthor()
    await profileStore.queuePendingProfileChange(
      userId,
      { nickname: '要拒绝的昵称', signature: '要拒绝的签名' },
      reviewRecord(),
    )
    const recordId = await pendingRecordId(userId)

    const decided = await store.decide({
      recordId,
      decision: 'BLOCK',
      reason: '含外部联系方式',
      version: 0,
      actorUserId: moderator,
    })
    expect(decided).toMatchObject({ outcome: 'applied', decision: 'BLOCK' })
    expect(await publicRow(userId)).toMatchObject({
      nickname: '公开昵称',
      signature: '公开签名',
    })

    const [record] = (await db.execute(sql`
      SELECT status, decision FROM profile_moderation_records WHERE id = ${recordId}
    `)) as unknown as { status: string; decision: string }[]
    expect(record).toEqual({ status: 'SETTLED', decision: 'BLOCK' })
  })

  test('入队后用户又改了公开值：过期审核只能冲突，绝不覆盖最新内容', async () => {
    const userId = await createAuthor()
    // 入队时基线是「公开昵称」；随后用户自己把昵称改成了「更新后的昵称」。
    await profileStore.queuePendingProfileChange(userId, { nickname: '旧待审' }, reviewRecord())
    await db.execute(sql`UPDATE users SET nickname = '更新后的昵称' WHERE id = ${userId}::uuid`)

    const recordId = await pendingRecordId(userId)
    const result = await store.decide({
      recordId,
      decision: 'ALLOW',
      reason: '放行旧待审',
      version: 0,
      actorUserId: moderator,
    })
    expect(result.outcome).toBe('conflict')
    expect(await publicRow(userId)).toMatchObject({ nickname: '更新后的昵称' })
  })

  test('账号注销去标识化后，旧待审记录不能再把资料放行回公开', async () => {
    const userId = await createAuthor()
    await profileStore.queuePendingProfileChange(userId, { nickname: '注销前待审' }, reviewRecord())
    await db.execute(
      sql`UPDATE users SET account_status = 'DELETED', nickname = '已注销用户' WHERE id = ${userId}::uuid`,
    )

    const recordId = await pendingRecordId(userId)
    const result = await store.decide({
      recordId,
      decision: 'ALLOW',
      reason: '放行',
      version: 0,
      actorUserId: moderator,
    })
    expect(result.outcome).toBe('not-found')
    expect(await publicRow(userId)).toMatchObject({ nickname: '已注销用户' })
  })

  test('版本过期 / 反悔改判 / 记录不存在', async () => {
    const userId = await createAuthor()
    await profileStore.queuePendingProfileChange(userId, { nickname: '待审昵称' }, reviewRecord())
    const recordId = await pendingRecordId(userId)

    const stale = await store.decide({
      recordId,
      decision: 'ALLOW',
      reason: '过期版本',
      version: 7,
      actorUserId: moderator,
    })
    expect(stale.outcome).toBe('conflict')
    // 冲突不改任何东西
    expect(await publicRow(userId)).toMatchObject({ nickname: '公开昵称' })

    const applied = await store.decide({
      recordId,
      decision: 'ALLOW',
      reason: '放行',
      version: 0,
      actorUserId: moderator,
    })
    expect(applied.outcome).toBe('applied')

    const flipped = await store.decide({
      recordId,
      decision: 'BLOCK',
      reason: '改判',
      version: 1,
      actorUserId: moderator,
    })
    expect(flipped.outcome).toBe('conflict')

    const missing = await store.decide({
      recordId: '01990000-0000-7000-8000-0000000000ff',
      decision: 'ALLOW',
      reason: '不存在',
      version: 0,
      actorUserId: moderator,
    })
    expect(missing.outcome).toBe('not-found')
  })
})
