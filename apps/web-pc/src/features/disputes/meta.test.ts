import { describe, expect, test } from 'bun:test'
import {
  DisputeCreateInputSchema,
  DisputeResolutionSchema,
  DisputeStatusSchema,
  DisputeTypeSchema,
} from '@fish/contracts/disputes/schema'
import {
  DISPUTE_RESOLUTION_META,
  DISPUTE_STATUS_META,
  DISPUTE_TYPE_OPTIONS,
  disputeResolutionLabel,
  disputeTypeLabel,
} from './meta'

const TRANSACTION_ID = 'txn_01jc000000e00800000000000a'

describe('dispute type options', () => {
  test('mirrors the contract enum in the contract own order', () => {
    expect(DISPUTE_TYPE_OPTIONS.map((option) => option.key)).toEqual([...DisputeTypeSchema.options])
  })

  test('every type the dialog offers passes the create contract', () => {
    for (const option of DISPUTE_TYPE_OPTIONS) {
      const parsed = DisputeCreateInputSchema.safeParse({
        transactionId: TRANSACTION_ID,
        type: option.key,
        detailText: '补充说明',
      })
      expect(parsed.success).toBe(true)
    }
  })

  test('labels / hints are non-empty and lookup returns the same copy', () => {
    for (const option of DISPUTE_TYPE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.hint.length).toBeGreaterThan(0)
      expect(disputeTypeLabel(option.key)).toBe(option.label)
    }
    expect(disputeTypeLabel('OTHER')).toBe('其他')
  })

  test('OTHER 缺说明被契约拒绝（端上按钮禁用同一条规则）', () => {
    expect(
      DisputeCreateInputSchema.safeParse({ transactionId: TRANSACTION_ID, type: 'OTHER' }).success,
    ).toBe(false)
    expect(
      DisputeCreateInputSchema.safeParse({
        transactionId: TRANSACTION_ID,
        type: 'ITEM_MISMATCH',
      }).success,
    ).toBe(true)
  })
})

describe('status / resolution meta', () => {
  test('covers every contract status and resolution in contract order', () => {
    expect(Object.keys(DISPUTE_STATUS_META)).toEqual([...DisputeStatusSchema.options])
    expect(Object.keys(DISPUTE_RESOLUTION_META)).toEqual([...DisputeResolutionSchema.options])
  })

  test('status labels', () => {
    expect(DISPUTE_STATUS_META.PENDING.label).toBe('处理中')
    expect(DISPUTE_STATUS_META.RESOLVED.label).toBe('已处理')
    expect(DISPUTE_STATUS_META.WITHDRAWN.label).toBe('已撤回')
  })

  test('resolution labels include INCONCLUSIVE; pending has none', () => {
    expect(disputeResolutionLabel('UPHELD')).toBe('反馈成立')
    expect(disputeResolutionLabel('DISMISSED')).toBe('反馈不成立')
    expect(disputeResolutionLabel('INCONCLUSIVE')).toBe('无法认定')
    expect(disputeResolutionLabel(null)).toBeNull()
  })

  test('resolution descriptions are perspective-neutral (respondent reads them too)', () => {
    for (const status of DisputeResolutionSchema.options) {
      expect(DISPUTE_RESOLUTION_META[status].description).not.toContain('你')
    }
  })
})
