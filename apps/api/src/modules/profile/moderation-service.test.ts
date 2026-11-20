import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createProfileModerationService, ProfileModerationServiceError } from './moderation-service'
import type { ProfileModerationQueueRow, ProfileModerationStore } from './moderation-store'

const adminId = '01990000-0000-7000-8000-0000000000a0'
const authorId = '01990000-0000-7000-8000-0000000000a1'
const recordId = '01990000-0000-7000-8000-0000000000c1'

const queueRow = (
  overrides: Partial<ProfileModerationQueueRow> = {},
): ProfileModerationQueueRow => ({
  id: recordId,
  user_id: authorId,
  // 「键存在且为 null」= 主动清空签名（与「没提交」不同），队列要能看出来。
  payload: { nickname: '待审昵称', signature: null },
  machine_decision: 'REVIEW',
  decision: 'REVIEW',
  status: 'PENDING',
  provider: 'LOCAL',
  policy_version: 'local-v1',
  suggestion: 'Review',
  score: 42,
  // 裸 SQL 的 jsonb 回来是文本：service 必须能吃下这种形状。
  matched_rules: '["PUBLIC_EXTERNAL_CONTACT"]',
  matched_terms_masked: '["加微信"]',
  version: 0,
  created_at: new Date('2026-09-12T04:00:00.000Z'),
  current_nickname: '公开昵称',
  current_signature: '公开签名',
  current_avatar_url: 'https://cdn.test/old.jpg',
  ...overrides,
})

function fakeStore(overrides: Partial<ProfileModerationStore> = {}): ProfileModerationStore {
  return {
    listPending: async () => [],
    decide: async () => ({ outcome: 'not-found' }),
    ...overrides,
  }
}

const service = (overrides: Partial<ProfileModerationStore> = {}) =>
  createProfileModerationService({ store: fakeStore(overrides) })

const catchError = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (error: unknown) => error,
  )

describe('profile moderation service（#694 M5）', () => {
  test('队列项映射：公开 ID、待审值/当前值、字段清单、机审命中', async () => {
    const listed = await service({
      listPending: async () => [queueRow()],
    }).list({ limit: 20 })

    expect(listed.items).toEqual([
      {
        id: encodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, recordId),
        userId: encodePublicId(PUBLIC_ID_PREFIX.user, authorId),
        nickname: '待审昵称',
        signature: null,
        avatarUrl: null,
        fields: ['nickname', 'signature'],
        currentNickname: '公开昵称',
        currentSignature: '公开签名',
        currentAvatarUrl: 'https://cdn.test/old.jpg',
        author: {
          id: encodePublicId(PUBLIC_ID_PREFIX.user, authorId),
          nickname: '公开昵称',
        },
        machineDecision: 'REVIEW',
        provider: 'LOCAL',
        policyVersion: 'local-v1',
        suggestion: 'Review',
        score: 42,
        matchedRules: ['PUBLIC_EXTERNAL_CONTACT'],
        matchedTermsMasked: ['加微信'],
        status: 'PENDING',
        // PENDING 记录还没有人工结论：机审的 REVIEW 不能当决策下发。
        decision: null,
        version: 0,
        createdAt: '2026-09-12T04:00:00.000Z',
      },
    ])
    expect(listed.nextCursor).toBeNull()
  })

  test('多取一行判断是否还有下一页，游标 = 最后一条的时间 + id', async () => {
    const second = queueRow({
      id: '01990000-0000-7000-8000-0000000000c2',
      created_at: new Date('2026-09-12T03:00:00.000Z'),
    })
    const listed = await service({
      listPending: async () => [queueRow(), second],
    }).list({ limit: 1 })

    expect(listed.items).toHaveLength(1)
    expect(listed.nextCursor).toBe(`2026-09-12T04:00:00.000Z|${recordId}`)
  })

  test('脏头像降级为 null（契约是 z.url().nullable()）', async () => {
    const listed = await service({
      listPending: async () => [queueRow({ current_avatar_url: 'listings/old.jpg' })],
    }).list({ limit: 20 })
    expect(listed.items[0]?.currentAvatarUrl).toBeNull()
  })

  test('游标非法 → 422 PROFILE_MODERATION_INVALID_CURSOR，且不查库', async () => {
    let called = 0
    const caught = await catchError(
      service({
        listPending: async () => {
          called += 1
          return []
        },
      }).list({ cursor: 'not-a-cursor', limit: 20 }),
    )

    expect(caught).toBeInstanceOf(ProfileModerationServiceError)
    if (!(caught instanceof ProfileModerationServiceError)) throw caught
    expect(caught.status).toBe(422)
    expect(caught.code).toBe('PROFILE_MODERATION_INVALID_CURSOR')
    expect(called).toBe(0)
  })

  test('放行/拒绝：回公开 ID，replayed 由 store 的 outcome 决定', async () => {
    const applied = await service({
      decide: async () => ({
        outcome: 'applied',
        recordId,
        userId: authorId,
        decision: 'ALLOW',
        fields: ['nickname'],
      }),
    }).decide(recordId, { decision: 'ALLOW', reason: '放行', version: 0 }, adminId)

    expect(applied).toEqual({
      id: encodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, recordId),
      userId: encodePublicId(PUBLIC_ID_PREFIX.user, authorId),
      decision: 'ALLOW',
      replayed: false,
    })

    const replayed = await service({
      decide: async () => ({
        outcome: 'replayed',
        recordId,
        userId: authorId,
        decision: 'ALLOW',
        fields: ['nickname'],
      }),
    }).decide(recordId, { decision: 'ALLOW', reason: '重复', version: 0 }, adminId)
    expect(replayed.replayed).toBe(true)
  })

  test('not-found → 404，conflict → 409（乐观版本）', async () => {
    const missing = await catchError(
      service({ decide: async () => ({ outcome: 'not-found' }) }).decide(
        recordId,
        { decision: 'ALLOW', reason: '放行', version: 0 },
        adminId,
      ),
    )
    expect(missing).toBeInstanceOf(ProfileModerationServiceError)
    if (!(missing instanceof ProfileModerationServiceError)) throw missing
    expect(missing.status).toBe(404)
    expect(missing.code).toBe('PROFILE_MODERATION_NOT_FOUND')

    const conflict = await catchError(
      service({ decide: async () => ({ outcome: 'conflict' }) }).decide(
        recordId,
        { decision: 'ALLOW', reason: '放行', version: 0 },
        adminId,
      ),
    )
    expect(conflict).toBeInstanceOf(ProfileModerationServiceError)
    if (!(conflict instanceof ProfileModerationServiceError)) throw conflict
    expect(conflict.status).toBe(409)
    expect(conflict.code).toBe('PROFILE_MODERATION_CONFLICT')
  })
})
