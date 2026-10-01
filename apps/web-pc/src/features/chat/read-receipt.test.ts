import { describe, expect, test } from 'bun:test'
import { INITIAL_READ_RECEIPT_STATE, onIncomingMessage, resolveReadReceipt } from './read-receipt'

describe('chat read receipt policy', () => {
  test('可见时收到对方消息立即标已读', () => {
    const result = onIncomingMessage('visible')

    expect(result.markRead).toBe(true)
    expect(result.state).toEqual(INITIAL_READ_RECEIPT_STATE)
  })

  test('隐藏时收到对方消息不标已读，并记账等待回到前台', () => {
    const result = onIncomingMessage('hidden')

    expect(result.markRead).toBe(false)
    expect(result.state.unreadWhileHidden).toBe(true)
  })

  test('回到可见时补标隐藏期间收到的消息', () => {
    const hidden = onIncomingMessage('hidden')
    const result = resolveReadReceipt(hidden.state, 'visible', false)

    expect(result.markRead).toBe(true)
    expect(result.state).toEqual(INITIAL_READ_RECEIPT_STATE)
  })

  test('仍然隐藏时即使已有未读也不标已读', () => {
    const result = resolveReadReceipt(INITIAL_READ_RECEIPT_STATE, 'hidden', true)

    expect(result.markRead).toBe(false)
    expect(result.state.unreadWhileHidden).toBe(true)
  })

  test('可见但没有未读时不发标已读请求', () => {
    const result = resolveReadReceipt(INITIAL_READ_RECEIPT_STATE, 'visible', false)

    expect(result.markRead).toBe(false)
  })
})
