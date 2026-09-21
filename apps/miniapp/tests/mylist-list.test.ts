import { describe, expect, test } from 'bun:test'
import {
  countBySegment,
  emptyText,
  isEditable,
  lockedHint,
  segmentLabel,
  segmentOf,
} from '../src/pages/mylist/list'

/**
 * 「我的发布」分档判定（#74 / #89 mylist 行真实接线）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 */

type Card = Parameters<typeof segmentOf>[0]

const card = (over: Partial<Card> = {}): Card => ({
  status: 'ACTIVE',
  moderationStatus: 'APPROVED',
  ...over,
})

describe('segmentOf —— 审核态优先于 status', () => {
  test('REVIEW / BLOCKED 一律进「审核中」，即使 status 也是 OFFLINE', () => {
    // 只看 status 会把「等你改内容」和「你自己下架的」混成一段（#74 要修的表现）
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: 'REVIEW' }))).toBe('review')
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: 'BLOCKED' }))).toBe('review')
  })

  test('已过审的商品按 status 分档', () => {
    expect(segmentOf(card())).toBe('sale')
    expect(segmentOf(card({ status: 'RESERVED' }))).toBe('reserved')
    expect(segmentOf(card({ status: 'SOLD' }))).toBe('sold')
    expect(segmentOf(card({ status: 'OFFLINE' }))).toBe('off')
  })

  test('公开/他人视角 moderationStatus 为 null 时按 status 分档，不误判成审核中', () => {
    expect(segmentOf(card({ moderationStatus: null }))).toBe('sale')
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: null }))).toBe('off')
  })
})

describe('countBySegment —— 分段计数', () => {
  test('每个卡片只计入一段，含审核中', () => {
    const counts = countBySegment([
      card(),
      card({ status: 'RESERVED' }),
      card({ status: 'OFFLINE', moderationStatus: 'REVIEW' }),
      card({ status: 'OFFLINE', moderationStatus: 'BLOCKED' }),
      card({ status: 'OFFLINE' }),
    ])
    expect(counts).toEqual({ sale: 1, reserved: 1, sold: 0, review: 2, off: 1 })
  })
})

describe('segmentLabel —— 审核中段里两种状态文案不同', () => {
  test('REVIEW 说「审核中」，BLOCKED 说「未通过审核」', () => {
    expect(segmentLabel(card({ moderationStatus: 'REVIEW' }), 'review')).toBe('审核中')
    expect(segmentLabel(card({ moderationStatus: 'BLOCKED' }), 'review')).toBe('未通过审核')
  })

  test('其余分段用固定文案', () => {
    expect(segmentLabel(card(), 'sale')).toBe('在售')
    expect(segmentLabel(card(), 'reserved')).toBe('已预订')
    expect(segmentLabel(card(), 'sold')).toBe('已售出')
    expect(segmentLabel(card(), 'off')).toBe('已下架')
  })
})

describe('isEditable —— 只有交易锁定的两段不可编辑', () => {
  test('在售 / 已下架 / 审核中可编辑；已预订 / 已售出被交易锁定', () => {
    expect(isEditable('sale')).toBe(true)
    expect(isEditable('off')).toBe(true)
    // 服务端允许 PATCH 审核中的商品并重新审核：这是改掉被拦内容的唯一路径
    expect(isEditable('review')).toBe(true)
    expect(isEditable('reserved')).toBe(false)
    expect(isEditable('sold')).toBe(false)
  })

  test('只有被交易锁定的两段给锁定说明，审核中不给', () => {
    expect(lockedHint('reserved')).not.toBe('')
    expect(lockedHint('sold')).not.toBe('')
    expect(lockedHint('review')).toBe('')
  })
})

describe('emptyText —— 空态说明该段会出现什么', () => {
  test('审核中与已下架各说各的，不复用通用那句', () => {
    expect(emptyText('review')).not.toBe(emptyText('sale'))
    expect(emptyText('off')).not.toBe(emptyText('sale'))
  })
})
