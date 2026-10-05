import { describe, expect, test } from 'bun:test'
import {
  createIdempotencyKey,
  formatAdminDateTime,
  formatLatency,
  formatRate,
  validateReason,
} from './admin-view'

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
