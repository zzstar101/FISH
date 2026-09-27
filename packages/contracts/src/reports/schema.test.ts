import { expect, test } from 'bun:test'
import { ReportSchema, ReportTargetSummarySchema } from './schema'

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
