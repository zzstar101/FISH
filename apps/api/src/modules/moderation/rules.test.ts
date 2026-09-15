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
})
