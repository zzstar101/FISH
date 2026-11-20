import { describe, expect, test } from 'bun:test'
import { createChatModerationPolicy } from './chat'
import type { ContentModerationProvider, TextModerationResult } from './providers/types'

/**
 * 聊天策略只做一件事：把「一条消息」翻译成 provider 的一次文本审核，并把结论摊平成
 * 可审计的一行。测试钉住送审字段、dataId 形状与结论映射，避免退化成「未审核即通过」。
 */
describe('chat moderation policy（#694 M1）', () => {
  test('用 content 字段送审、dataId 每次随机、结论与审计信息原样带回', async () => {
    const inputs: Array<{ dataId: string; fields: Array<{ field: string; value: string }> }> = []
    const provider: ContentModerationProvider = {
      transport: 'tencent',
      moderateImage: async () => {
        throw new Error('not used')
      },
      moderateText: async (input) => {
        inputs.push(input)
        return {
          provider: 'TENCENT_TMS',
          transport: 'tencent',
          dataId: input.dataId,
          policyVersion: 'chat-biz',
          decision: 'REVIEW',
          suggestion: 'Review',
          fields: [
            {
              field: 'content',
              decision: 'REVIEW',
              suggestion: 'Review',
              label: '引流',
              subLabel: 'EXTERNAL_CONTACT',
              score: 80,
              requestId: 'req-1',
              maskedTerms: ['加*信'],
            },
            {
              field: 'content',
              decision: 'REVIEW',
              suggestion: 'Review',
              label: null,
              subLabel: 'EXTERNAL_CONTACT',
              score: null,
              requestId: null,
              maskedTerms: ['加*信'],
            },
          ],
        } satisfies TextModerationResult
      },
    }

    const policy = createChatModerationPolicy(provider)
    const first = await policy.moderateText({ content: '加微信聊' })
    await policy.moderateText({ content: '在吗' })

    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.fields).toEqual([{ field: 'content', value: '加微信聊' }])
    expect(inputs[0]?.dataId).toMatch(/^chat-[0-9a-f-]{36}$/)
    expect(inputs[0]?.dataId).not.toBe(inputs[1]?.dataId)
    expect(first).toEqual({
      decision: 'REVIEW',
      provider: 'TENCENT_TMS',
      transport: 'tencent',
      providerRequestId: 'req-1',
      policyVersion: 'chat-biz',
      suggestion: 'Review',
      label: '引流',
      subLabel: 'EXTERNAL_CONTACT',
      score: 80,
      matchedRules: ['EXTERNAL_CONTACT'],
      matchedTermsMasked: ['加*信'],
    })
  })

  test('provider 抛错时原样上抛（调用方必须 fail-closed，不得当成 ALLOW）', async () => {
    const failure = new Error('upstream timeout')
    const policy = createChatModerationPolicy({
      transport: 'tencent',
      moderateImage: async () => {
        throw new Error('not used')
      },
      moderateText: async () => {
        throw failure
      },
    })
    await expect(policy.moderateText({ content: '在吗' })).rejects.toBe(failure)
  })
})
