import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { isUserNotFound, profileStats } from './view'

const USER_ID = 'usr_01jc000000e00800000000000a'

describe('isUserNotFound', () => {
  test('is true only for the contract’s USER_NOT_FOUND 404', () => {
    expect(isUserNotFound(new ApiError('USER_NOT_FOUND', 404, '用户不存在或不可见'))).toBe(true)
  })

  test('is false for other failures, so they still render as load errors', () => {
    expect(isUserNotFound(new ApiError('INTERNAL_ERROR', 500, '服务异常'))).toBe(false)
    expect(isUserNotFound(new ApiError('UNAUTHENTICATED', 401, '未登录'))).toBe(false)
    // 同一个错误码但状态不是 404：契约里 USER_NOT_FOUND 恒为 404，别处复用该码时不能误判。
    expect(isUserNotFound(new ApiError('USER_NOT_FOUND', 500, '服务异常'))).toBe(false)
    expect(isUserNotFound(new Error('network down'))).toBe(false)
    expect(isUserNotFound(null)).toBe(false)
  })
})

describe('profileStats', () => {
  /**
   * 契约的公开 DTO 有九个字段（含 #179 的 `signature` 与 #359 第五点的 `presence`），且**没有**好评率 / 关注数 ——
   * 仓库没有 reviews 表、关注关系未拆 Domain（见 `users/schema.ts` 文件头）。
   * 这里锁住「页面上只出这三个统计」，任何编造指标加进来都会让这条断言失败。
   */
  test('exposes exactly the three contract-backed stats', () => {
    const stats = profileStats({
      id: USER_ID,
      nickname: '阿岚',
      avatarUrl: null,
      authStatus: 'UNVERIFIED',
      signature: null,
      joinedDays: 3,
      activeCount: 2,
      soldCount: 1,
      presence: { online: false, lastActiveAt: null },
    })

    expect(stats).toEqual([
      { label: '加入天数', value: 3 },
      { label: '在售商品', value: 2 },
      { label: '卖出', value: 1 },
    ])
  })
})
