import { expect, test } from 'bun:test'
import { ReportCreateInputSchema, ReportSchema, ReportTargetSummarySchema } from './schema'

const listingReport = {
  id: 'rpt_01jc000000e00800000000000a',
  targetType: 'LISTING',
  targetId: 'lst_01jc000000e00800000000000k',
  reason: 'FRAUD',
  detailText: null,
  status: 'PENDING',
  createdAt: '2026-09-26T00:00:00.000Z',
  handledAt: null,
} as const

test('举报响应的资源类型必须与公开目标 ID 前缀一致', () => {
  expect(ReportSchema.safeParse(listingReport).success).toBe(true)
  expect(
    ReportSchema.safeParse({ ...listingReport, targetId: 'usr_01jc000000e00800000000000a' })
      .success,
  ).toBe(false)
  expect(
    ReportTargetSummarySchema.safeParse({
      targetType: 'LISTING',
      targetId: 'usr_01jc000000e00800000000000a',
      label: '目标',
      listingStatus: null,
      moderationStatus: null,
    }).success,
  ).toBe(false)
})

test('#694 M7：COMMENT / REVIEW / WISH 目标须匹配各自的公开 ID 前缀', () => {
  const suffix = '01jc000000e00800000000000a'
  const comment = { ...listingReport, targetType: 'COMMENT', targetId: `cmt_${suffix}` } as const
  const review = { ...listingReport, targetType: 'REVIEW', targetId: `rvw_${suffix}` } as const
  const wish = { ...listingReport, targetType: 'WISH', targetId: `wsh_${suffix}` } as const

  expect(ReportSchema.safeParse(comment).success).toBe(true)
  expect(ReportSchema.safeParse(review).success).toBe(true)
  expect(ReportSchema.safeParse(wish).success).toBe(true)

  expect(ReportSchema.safeParse({ ...comment, targetId: `rvw_${suffix}` }).success).toBe(false)
  expect(ReportSchema.safeParse({ ...review, targetId: `cmt_${suffix}` }).success).toBe(false)
  expect(ReportSchema.safeParse({ ...wish, targetId: `usr_${suffix}` }).success).toBe(false)
})

test('#694 M7：新目标复用 UGC 原因子集，不接受的组合给出目标名文案', () => {
  const comment = {
    targetType: 'COMMENT',
    targetId: 'cmt_01jc000000e00800000000000a',
    reason: 'SPAM',
  } as const
  expect(ReportCreateInputSchema.safeParse(comment).success).toBe(true)
  expect(
    ReportCreateInputSchema.safeParse({
      ...comment,
      targetType: 'WISH',
      targetId: 'wsh_01jc000000e00800000000000a',
    }).success,
  ).toBe(true)

  // FRAUD 只属于商品 / 用户 / 消息，不随 M7 扩散到留言。
  const rejected = ReportCreateInputSchema.safeParse({ ...comment, reason: 'FRAUD' })
  expect(rejected.success).toBe(false)
  expect(rejected.error?.issues[0]?.message).toContain('举报留言时不支持该原因')

  const wrongType = ReportCreateInputSchema.safeParse({
    ...comment,
    targetType: 'WISH',
    reason: 'SPAM',
  })
  expect(wrongType.success).toBe(false)
  expect(wrongType.error?.issues.map((issue) => issue.message).join()).toContain(
    '举报目标 ID 前缀不匹配',
  )
})
