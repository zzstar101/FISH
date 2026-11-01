import { describe, expect, test } from 'bun:test'
import {
  SUBSCRIBE_MESSAGE_GRANT_LIMIT,
  SubscribeMessageErrorCodeSchema,
  subscribeMessageConfigSchema,
  subscribeMessageGrantReportSchema,
  subscribeMessageGrantStatusSchema,
  subscribeMessageGrantsResponseSchema,
  subscribeMessageKindSchema,
} from './schema'

/**
 * 契约层的三条端上语义（#462）：模板可空、未知授权状态当拒绝、上报最多三项。
 *
 * 这些断言的价值在于"端上与服务端不必各自再判一遍"：未知状态被 `catch` 收敛成
 * `reject`（不是 422），配置里的 `null` 是合法值（不是漏字段）。
 */
describe('subscribeMessageKindSchema', () => {
  test('只认首批三个 kind（MATCH 与反馈回复不在首批）', () => {
    expect(subscribeMessageKindSchema.options).toEqual(['CHAT', 'TX', 'REVIEW'])
    expect(subscribeMessageKindSchema.safeParse('MATCH').success).toBe(false)
  })
})

describe('subscribeMessageConfigSchema', () => {
  test('三个 kind 都在，且模板 ID 可以为 null（未开通）', () => {
    expect(
      subscribeMessageConfigSchema.parse({
        templates: { CHAT: 'tmpl_a', TX: null, REVIEW: 'tmpl_c' },
      }),
    ).toEqual({ templates: { CHAT: 'tmpl_a', TX: null, REVIEW: 'tmpl_c' } })
  })

  test('缺 kind 或空串不合法（空串会让微信侧 47003）', () => {
    expect(subscribeMessageConfigSchema.safeParse({ templates: { CHAT: null } }).success).toBe(
      false,
    )
    expect(
      subscribeMessageConfigSchema.safeParse({
        templates: { CHAT: '', TX: null, REVIEW: null },
      }).success,
    ).toBe(false)
  })
})

describe('subscribeMessageGrantStatusSchema', () => {
  test('四个已知值原样保留', () => {
    for (const status of ['accept', 'reject', 'ban', 'filter'] as const) {
      expect(subscribeMessageGrantStatusSchema.parse(status)).toBe(status)
    }
  })

  test('未知值收敛成 reject 而不是抛错（新增状态码不该让上报整体 422）', () => {
    expect(subscribeMessageGrantStatusSchema.parse('something-new')).toBe('reject')
    expect(subscribeMessageGrantStatusSchema.parse(42)).toBe('reject')
  })
})

describe('subscribeMessageGrantReportSchema', () => {
  test('1..3 项接受（首批正好三个模板）', () => {
    expect(
      subscribeMessageGrantReportSchema.parse({ grants: [{ kind: 'CHAT', status: 'accept' }] }),
    ).toEqual({ grants: [{ kind: 'CHAT', status: 'accept' }] })

    const three = ['CHAT', 'TX', 'REVIEW'].map((kind) => ({ kind, status: 'accept' }))
    expect(subscribeMessageGrantReportSchema.safeParse({ grants: three }).success).toBe(true)
  })

  test('空数组与超过三项都拒绝', () => {
    expect(subscribeMessageGrantReportSchema.safeParse({ grants: [] }).success).toBe(false)
    const four = ['CHAT', 'TX', 'REVIEW', 'CHAT'].map((kind) => ({ kind, status: 'accept' }))
    expect(subscribeMessageGrantReportSchema.safeParse({ grants: four }).success).toBe(false)
  })

  test('多余字段 / 未知 kind 拒绝（strictObject）', () => {
    expect(
      subscribeMessageGrantReportSchema.safeParse({
        grants: [{ kind: 'CHAT', status: 'accept', extra: 1 }],
      }).success,
    ).toBe(false)
    expect(
      subscribeMessageGrantReportSchema.safeParse({
        grants: [{ kind: 'MATCH', status: 'accept' }],
      }).success,
    ).toBe(false)
  })
})

describe('subscribeMessageGrantsResponseSchema', () => {
  test('剩余次数必须是非负整数（0 合法，负数不合法）', () => {
    expect(
      subscribeMessageGrantsResponseSchema.parse({ remaining: { CHAT: 0, TX: 1, REVIEW: 50 } }),
    ).toEqual({ remaining: { CHAT: 0, TX: 1, REVIEW: 50 } })

    expect(
      subscribeMessageGrantsResponseSchema.safeParse({
        remaining: { CHAT: -1, TX: 0, REVIEW: 0 },
      }).success,
    ).toBe(false)
    expect(
      subscribeMessageGrantsResponseSchema.safeParse({
        remaining: { CHAT: 1.5, TX: 0, REVIEW: 0 },
      }).success,
    ).toBe(false)
  })

  test('上限常量是 50（DB 侧 CHECK 与它同值，改一处要改两处）', () => {
    expect(SUBSCRIBE_MESSAGE_GRANT_LIMIT).toBe(50)
  })
})

describe('SubscribeMessageErrorCodeSchema', () => {
  test('只新增一个错误码：能力未开通', () => {
    expect(SubscribeMessageErrorCodeSchema.options).toEqual(['SUBSCRIBE_MESSAGES_DISABLED'])
  })
})
