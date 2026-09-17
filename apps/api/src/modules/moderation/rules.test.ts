import { describe, expect, test } from 'bun:test'
import { moderateListingContent } from './rules'

describe('moderateListingContent', () => {
  test('allows ordinary listing content', () => {
    expect(
      moderateListingContent({ title: '罗技键盘', description: '成色很好，校内面交' }),
    ).toMatchObject({
      decision: 'ALLOW',
      reasonCode: null,
      matches: [],
    })
  })

  test('blocks prohibited content and masks matched terms', () => {
    const result = moderateListingContent({ title: '全新毒品', description: '请勿购买' })
    expect(result.decision).toBe('BLOCK')
    expect(result.matches[0]).toMatchObject({ field: 'title', ruleCode: 'PROHIBITED_CONTENT' })
    expect(result.matches[0]?.maskedTerm).not.toContain('毒品')
  })

  test('sends external-contact content to review', () => {
    expect(moderateListingContent({ title: '键盘', description: '加微信联系' })).toMatchObject({
      decision: 'REVIEW',
      reasonCode: 'CONTENT_REQUIRES_REVIEW',
    })
  })

  test('normalizes full-width and invisible characters', () => {
    expect(
      moderateListingContent({ title: '键盘', description: '加　微\u200b信联系' }).decision,
    ).toBe('REVIEW')
  })

  test('block takes precedence over review', () => {
    expect(moderateListingContent({ title: '毒品', description: '加微信' }).decision).toBe('BLOCK')
  })

  // 评审 major 3：在词表词之间插入分隔字符不应绕开匹配（`毒-品` / `加/微信` / `v.x`）。
  test('strips separators and punctuation before matching', () => {
    expect(moderateListingContent({ title: '毒-品', description: '详情' }).decision).toBe('BLOCK')
    expect(moderateListingContent({ title: '毒·品', description: '详情' }).decision).toBe('BLOCK')
    expect(moderateListingContent({ title: '键盘', description: '加/微_信' }).decision).toBe(
      'REVIEW',
    )
    expect(moderateListingContent({ title: '键盘', description: 'v.x 联系我' }).decision).toBe(
      'REVIEW',
    )
    expect(moderateListingContent({ title: '键盘', description: '加＋微信' }).decision).toBe(
      'REVIEW',
    )
  })

  // 反向保证：剥离标点不能把不相关的内容也归一成命中词 —— `vx` 只在真的出现时才触发。
  test('does not over-match after separator stripping', () => {
    expect(
      moderateListingContent({ title: '键盘 9.9 成新', description: 'A.B.C 型号' }).decision,
    ).toBe('ALLOW')
    // 只有字母/数字被保留，所以 `v x`（有空格分隔）会归一成 `vx` 而命中；
    // 这是可接受的假阳性方向（宁多审不漏审），但要确保普通型号不会命中。
    expect(moderateListingContent({ title: 'iPhone 15 Pro', description: '无划痕' }).decision).toBe(
      'ALLOW',
    )
  })
})
