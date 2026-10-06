import { describe, expect, test } from 'bun:test'
import type { DisputeResolution, DisputeStatus, DisputeType } from '@fish/contracts/disputes/schema'
import {
  createIdempotencyKey,
  disputeResolutionMeta,
  disputeStatusMeta,
  disputeTypeLabel,
  evidenceTypeLabel,
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

describe('争议元数据的未知枚举回退（#465 审查 (c)-②）', () => {
  test('未知状态/结论/类型一律显示「未知」，不回退成某个真实状态', () => {
    // 契约是 z.enum，未知值只可能来自契约漂移（服务端比前端新）。若回退到 PENDING，
    // 处理人会把一条已了结的争议当成「待处理」照常操作 —— 宁可少说也不误导。
    expect(disputeStatusMeta('BOGUS' as DisputeStatus)).toEqual({
      label: '未知',
      variant: 'secondary',
    })
    expect(disputeResolutionMeta('BOGUS' as DisputeResolution)).toEqual({
      label: '未知',
      variant: 'secondary',
    })
    expect(disputeTypeLabel('BOGUS' as DisputeType)).toBe('未知')
  })

  test('契约内的取值照旧', () => {
    expect(disputeStatusMeta('PENDING')).toEqual({ label: '待处理', variant: 'warn' })
    expect(disputeStatusMeta('WITHDRAWN')).toEqual({ label: '已撤回', variant: 'secondary' })
    expect(disputeResolutionMeta('UPHELD')).toEqual({ label: '反馈成立', variant: 'success' })
    expect(disputeTypeLabel('ITEM_MISMATCH')).toBe('商品与描述不符')
  })
})

describe('evidenceTypeLabel（#465 审查 Primitive Obsession：键取自契约枚举）', () => {
  test('契约里的四种消息类型都有文案', () => {
    expect(evidenceTypeLabel('LISTING')).toBe('商品引用')
    expect(evidenceTypeLabel('MEDIA')).toBe('图片/语音')
    expect(evidenceTypeLabel('SYSTEM')).toBe('系统消息')
    expect(evidenceTypeLabel('TEXT')).toBe('文字')
  })

  test('契约漂移的取值照实显示原文，不编一个中文', () => {
    const drifted = 'AUDIO' as Parameters<typeof evidenceTypeLabel>[0]
    expect(evidenceTypeLabel(drifted)).toBe('AUDIO')
  })
})
