import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  FollowErrorCodeSchema,
  FollowedUserSchema,
  FollowStateSchema,
  MyFollowingQuerySchema,
  MyFollowingResponseSchema,
} from './schema'

const USER_ID = encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-00000000000a')

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    nickname: '林一',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    mutual: true,
    ...overrides,
  }
}

describe('FollowedUserSchema', () => {
  test('accepts the public follow-row shape', () => {
    expect(FollowedUserSchema.safeParse(row()).success).toBe(true)
  })

  test('rejects a bad public id / authStatus / mutual', () => {
    expect(FollowedUserSchema.safeParse(row({ id: 'not-a-user-id' })).success).toBe(false)
    expect(FollowedUserSchema.safeParse(row({ authStatus: 'PENDING' })).success).toBe(false)
    expect(FollowedUserSchema.safeParse(row({ mutual: 'yes' })).success).toBe(false)
  })

  /**
   * 隐私边界：契约里**根本不存在**这些字段，所以带上它们的响应仍然"能过" —— 这不是泄漏，
   * 而是 zod 的默认 strip。真正的控制在服务端的列投影（store 只 SELECT 公开列）。
   * 这条用例把"schema 不会把私有字段透传出去"固定下来，防止有人改成 `.passthrough()`。
   */
  test('strips private columns instead of passing them through', () => {
    const parsed = FollowedUserSchema.parse(
      row({ studentNo: '202510014755', campus: 'A', role: 'ADMIN' }),
    )
    expect(Object.keys(parsed).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'mutual',
      'nickname',
    ])
  })
})

describe('MyFollowingQuerySchema', () => {
  test('defaults limit to 20 and keeps cursor optional', () => {
    expect(MyFollowingQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(MyFollowingQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    })
  })

  test('rejects out-of-range limit and unknown params', () => {
    expect(MyFollowingQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(MyFollowingQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    // 端上不得指定别人的列表：多传 followerId 是 422，不是静默忽略
    expect(MyFollowingQuerySchema.safeParse({ followerId: USER_ID }).success).toBe(false)
  })
})

describe('MyFollowingResponseSchema', () => {
  test('accepts a full page and the last page', () => {
    expect(
      MyFollowingResponseSchema.safeParse({
        items: [row()],
        nextCursor: 'opaque',
        total: 1,
        mutualTotal: 1,
      }).success,
    ).toBe(true)
    expect(
      MyFollowingResponseSchema.safeParse({
        items: [],
        nextCursor: null,
        total: 0,
        mutualTotal: 0,
      }).success,
    ).toBe(true)
  })

  test('rejects negative totals and a missing nextCursor', () => {
    const base = { items: [], nextCursor: null, total: 0, mutualTotal: 0 }
    expect(MyFollowingResponseSchema.safeParse({ ...base, total: -1 }).success).toBe(false)
    const { nextCursor: _omitted, ...withoutCursor } = base
    expect(MyFollowingResponseSchema.safeParse(withoutCursor).success).toBe(false)
  })
})

describe('FollowStateSchema / FollowErrorCodeSchema', () => {
  test('state is a strict boolean pair', () => {
    expect(FollowStateSchema.safeParse({ following: false, mutual: false }).success).toBe(true)
    expect(FollowStateSchema.safeParse({ following: true }).success).toBe(false)
  })

  test('error codes are the frozen two', () => {
    expect(FollowErrorCodeSchema.options).toEqual(['USER_NOT_FOUND', 'CANNOT_FOLLOW_SELF'])
  })
})
