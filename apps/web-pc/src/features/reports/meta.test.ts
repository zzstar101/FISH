import { describe, expect, test } from 'bun:test'
import {
  LISTING_REPORT_REASONS as CONTRACT_LISTING_REASONS,
  USER_REPORT_REASONS as CONTRACT_USER_REASONS,
  ReportCreateInputSchema,
} from '@fish/contracts/reports/schema'
import { LISTING_REASON_OPTIONS, reasonLabel, reasonsOf, USER_REASON_OPTIONS } from './meta'

const LISTING_ID = 'lst_01jc000000e00800000000000t'
const USER_ID = 'usr_01jc000000e00800000000000a'

describe('report reason options', () => {
  test('mirrors the contract enums in the contract’s own order', () => {
    expect(LISTING_REASON_OPTIONS.map((option) => option.key)).toEqual([
      ...CONTRACT_LISTING_REASONS,
    ])
    expect(USER_REASON_OPTIONS.map((option) => option.key)).toEqual([...CONTRACT_USER_REASONS])
  })

  /**
   * 两套枚举是**不同**的子集（商品没有「骚扰」、用户没有「违禁品」），
   * 弹窗若把两边混用，提交时会被服务端的 `superRefine` 拒掉。
   */
  test('商品与用户的原因子集互不相同', () => {
    const listing = new Set(LISTING_REASON_OPTIONS.map((option) => option.key))
    expect(listing.has('HARASSMENT')).toBe(false)
    expect(listing.has('PROHIBITED')).toBe(true)
    const user = new Set(USER_REASON_OPTIONS.map((option) => option.key))
    expect(user.has('PROHIBITED')).toBe(false)
    expect(user.has('HARASSMENT')).toBe(true)
  })

  test('every option the dialog offers is accepted by the create contract', () => {
    for (const option of LISTING_REASON_OPTIONS) {
      expect(
        ReportCreateInputSchema.safeParse({
          targetType: 'LISTING',
          targetId: LISTING_ID,
          reason: option.key,
        }).success,
      ).toBe(true)
    }
    for (const option of USER_REASON_OPTIONS) {
      expect(
        ReportCreateInputSchema.safeParse({
          targetType: 'USER',
          targetId: USER_ID,
          reason: option.key,
        }).success,
      ).toBe(true)
    }
  })

  test('dispatch and label lookup follow the target type', () => {
    expect(reasonsOf('LISTING')).toBe(LISTING_REASON_OPTIONS)
    expect(reasonsOf('USER')).toBe(USER_REASON_OPTIONS)
    expect(reasonLabel('LISTING', 'PROHIBITED')).toBe('违禁品或禁售物')
    // 枚举演进后短暂错位时回退成 key，不渲染成空白。
    expect(reasonLabel('USER', 'SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
})
