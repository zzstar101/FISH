import { describe, expect, test } from 'bun:test'
import { createLocalContentModerationProvider } from '../moderation/providers/local'
import { createProfileModerationPolicy } from './moderation-policy'

const policy = createProfileModerationPolicy(createLocalContentModerationProvider())

/*
 * #694 M5：昵称 / 签名必须作为**两个不同字段**送审。local provider 用
 * `Object.fromEntries(fields.map(...))` 收字段，同名字段会互相覆盖（剩下那个等于没审），
 * 所以这里断言的是 provider 真正收到的字段名，而不是策略自己的内部结构。
 */
describe('profile moderation policy（#694 M5）', () => {
  test('昵称与签名分别以 nickname / signature 两个字段送审', async () => {
    const result = await policy.moderateProfile({ nickname: '小明', signature: '面交优先' })

    expect(result.decision).toBe('ALLOW')
    expect(result.provider).toBe('LOCAL')
    expect(result.matchedRules).toEqual([])
    // 没有 BLOCK 命中就没有「被禁字段」。
    expect(result.blockedFields).toEqual([])
  })

  test('命中外链规则：REVIEW + matchedRules 摊平（供人工队列判断）', async () => {
    const result = await policy.moderateProfile({ signature: '加微信 abc12345 详聊' })

    expect(result.decision).toBe('REVIEW')
    expect(result.suggestion).toBe('Review')
    expect(result.matchedRules).toContain('PUBLIC_EXTERNAL_CONTACT')
    // 只触发 REVIEW 的字段不能进 blockedFields：service 只按它拼 422 的字段级 details。
    expect(result.blockedFields).toEqual([])
  })

  test('命中违禁内容：BLOCK 且只把真正违规的字段报成 blockedFields', async () => {
    const result = await policy.moderateProfile({ nickname: '正常昵称', signature: '出售毒品' })

    expect(result.decision).toBe('BLOCK')
    expect(result.suggestion).toBe('Block')
    expect(result.blockedFields).toEqual(['signature'])
  })
})
