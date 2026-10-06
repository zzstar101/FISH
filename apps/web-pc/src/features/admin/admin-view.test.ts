import { describe, expect, test } from 'bun:test'
import { AdminAuditActionSchema, AdminAuditTargetTypeSchema } from '@fish/contracts/admin/schema'
import {
  auditActionOptions,
  auditTargetTypeOptions,
  createIdempotencyKey,
  formatAdminDateTime,
  formatLatency,
  formatRate,
  validateReason,
} from './admin-view'

describe('审计筛选选项由契约枚举派生（#467 五审 P1）', () => {
  test('动作选项与契约枚举逐一对应（以前手写的数组漏了 3 个取值）', () => {
    const options = auditActionOptions()
    expect(options.map((option) => option.value)).toEqual([...AdminAuditActionSchema.options])
    // 每项都有中文文案：契约加了值而 AUDIT_ACTION_META 没补时这里会红（tsc 也会先报 TS2741）
    for (const option of options) expect(option.label).not.toBe(option.value)
  })

  test('目标类型选项与契约枚举逐一对应', () => {
    const options = auditTargetTypeOptions()
    expect(options.map((option) => option.value)).toEqual([...AdminAuditTargetTypeSchema.options])
    for (const option of options) expect(option.label).not.toBe(option.value)
  })
})

describe('validateReason（与治理/审核/举报三组写操作的 1–500 口径一致）', () => {
  test('空串与全空白拒绝', () => {
    expect(validateReason('')).not.toBeNull()
    expect(validateReason('   ')).not.toBeNull()
  })

  test('501 字拒绝、500 字通过', () => {
    expect(validateReason('a'.repeat(501))).not.toBeNull()
    expect(validateReason('a'.repeat(500))).toBeNull()
  })

  test('trim 后参与长度判断', () => {
    expect(validateReason('  下架  ')).toBeNull()
  })
})

describe('formatRate（契约：分母为 0 是 null 不是 0）', () => {
  test('null 渲染为 —，数值按百分比', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0)).toBe('0.0%')
    expect(formatRate(1.5)).toBe('150.0%')
  })

  test('延迟与时间格式化不抛错', () => {
    expect(formatLatency(null)).toBe('—')
    expect(formatLatency(12.6)).toBe('13ms')
    expect(formatAdminDateTime('2026-10-05T08:00:00.000Z')).toContain('2026')
  })
})

describe('createIdempotencyKey（同弹窗复用、跨弹窗不同的原料）', () => {
  test('非空且两次生成不同', () => {
    const first = createIdempotencyKey()
    const second = createIdempotencyKey()
    expect(first.length).toBeGreaterThan(0)
    expect(first).not.toBe(second)
  })
})
