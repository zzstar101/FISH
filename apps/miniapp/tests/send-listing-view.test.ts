import { describe, expect, test } from 'bun:test'
import {
  sendFailureText,
  sendKeyFor,
  shouldDropSendKey,
} from '../src/pkg-trade/pages/send-listing/view'

/**
 * #359 3a 审查回合：这两件事决定「幂等键重试不重复落库；同键不同商品 → 409」这条验收
 * 到底成不成立，所以必须有用例锁住（页面组件本身没有渲染测试基建）。
 */
describe('发送商品选择页的幂等键', () => {
  test('同一件商品的重试复用同一个键，换商品才是新键', () => {
    const keys = new Map<string, string>()
    let generated = 0
    const make = () => {
      generated += 1
      return `key-${generated}`
    }

    const first = sendKeyFor(keys, 'lst_a', make)
    const retry = sendKeyFor(keys, 'lst_a', make)
    const other = sendKeyFor(keys, 'lst_b', make)

    // 复用 → 服务端命中同键重放既有那条，而不是落第二条卡片
    expect(retry).toBe(first)
    expect(other).not.toBe(first)
    // 复用不该重新生成（生成器只在首次调用一次）
    expect(generated).toBe(2)
  })

  test('成功丢弃键之后，下一次发送是一枚新键', () => {
    const keys = new Map<string, string>()
    const first = sendKeyFor(keys, 'lst_a', () => 'key-1')
    expect(first).toBe('key-1')
    keys.delete('lst_a')
    expect(sendKeyFor(keys, 'lst_a', () => 'key-2')).toBe('key-2')
  })
})

describe('发送失败文案分档', () => {
  test('四类服务端结论各有说法，不一律「请重试」', () => {
    expect(sendFailureText('LISTING_NOT_FOUND')).toBe('商品已下架或已售出')
    expect(sendFailureText('CONVERSATION_NOT_FOUND')).toBe('会话不存在或已结束')
    expect(sendFailureText('IDEMPOTENCY_KEY_REUSED')).toBe('发送内容有变化，请重新发送')
    expect(sendFailureText('VALIDATION_FAILED')).toBe('发送失败，请重试')
    expect(sendFailureText(null)).toBe('发送失败，请重试')
  })

  test('只有「同键换了内容」才作废键，否则重试会一直撞 409', () => {
    expect(shouldDropSendKey('IDEMPOTENCY_KEY_REUSED')).toBe(true)
    expect(shouldDropSendKey('LISTING_NOT_FOUND')).toBe(false)
    expect(shouldDropSendKey('CONVERSATION_NOT_FOUND')).toBe(false)
    expect(shouldDropSendKey(null)).toBe(false)
  })
})
