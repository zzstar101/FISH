import { describe, expect, test } from 'bun:test'
import {
  PublicUserListingsQuerySchema,
  PublicUserProfileSchema,
  UserErrorCodeSchema,
} from './schema'

const USER_ID = '01930000-0000-7000-8000-00000000000a'

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    nickname: '阿岚',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    joinedDays: 12,
    activeCount: 3,
    soldCount: 1,
    ...overrides,
  }
}

describe('PublicUserProfileSchema', () => {
  test('accepts the public shape', () => {
    expect(PublicUserProfileSchema.safeParse(profile()).success).toBe(true)
  })

  test('rejects joinedDays below the floor of 1', () => {
    expect(PublicUserProfileSchema.safeParse(profile({ joinedDays: 0 })).success).toBe(false)
    expect(PublicUserProfileSchema.safeParse(profile({ joinedDays: 1 })).success).toBe(true)
  })

  test('rejects a non-integer or negative count', () => {
    expect(PublicUserProfileSchema.safeParse(profile({ activeCount: -1 })).success).toBe(false)
    expect(PublicUserProfileSchema.safeParse(profile({ soldCount: 1.5 })).success).toBe(false)
  })

  test('rejects an unknown authStatus', () => {
    expect(PublicUserProfileSchema.safeParse(profile({ authStatus: 'PENDING' })).success).toBe(
      false,
    )
  })

  /**
   * 隐私边界：契约里**根本不存在**这些字段，所以带上它们的响应仍然"能过" —— 但这不代表
   * 泄漏，而是 zod 的默认 strip 行为。真正的控制在服务端的**列投影**（users store 只 SELECT
   * 公开列）与 service 的逐字段组装（已由 service 测试钉住"DTO 的键集合恰好是这七个"）。
   * 这条用例把"schema 层不会把私有字段透传出去"这件事固定下来，防止有人把 schema 改成
   * `.passthrough()` 后悄悄改变行为。
   */
  test('strips private columns instead of passing them through', () => {
    const parsed = PublicUserProfileSchema.parse(
      profile({ studentNo: '202510014755', campusEmail: 'a@b.c', role: 'ADMIN' }),
    )
    expect(Object.keys(parsed).sort()).toEqual([
      'activeCount',
      'authStatus',
      'avatarUrl',
      'id',
      'joinedDays',
      'nickname',
      'soldCount',
    ])
  })
})

describe('PublicUserListingsQuerySchema', () => {
  test('defaults limit to 20', () => {
    expect(PublicUserListingsQuerySchema.parse({})).toEqual({ limit: 20 })
  })

  test('coerces limit from the query string and caps it at 50', () => {
    expect(PublicUserListingsQuerySchema.parse({ limit: '5' }).limit).toBe(5)
    expect(PublicUserListingsQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
  })

  test('rejects sellerId / status overrides instead of ignoring them', () => {
    expect(PublicUserListingsQuerySchema.safeParse({ sellerId: USER_ID }).success).toBe(false)
    expect(PublicUserListingsQuerySchema.safeParse({ status: 'SOLD' }).success).toBe(false)
  })

  test('rejects an empty cursor', () => {
    expect(PublicUserListingsQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })
})

describe('UserErrorCodeSchema', () => {
  test('only exposes USER_NOT_FOUND', () => {
    expect(UserErrorCodeSchema.options).toEqual(['USER_NOT_FOUND'])
  })
})
