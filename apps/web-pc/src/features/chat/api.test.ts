import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  conversationListPath,
  describeSendFailure,
  isConversationNotFound,
  messageListPath,
} from './api'

describe('chat api paths', () => {
  test('conversation list always sends the contract limit and optional cursor', () => {
    expect(conversationListPath()).toBe('/conversations?limit=50')
    expect(conversationListPath('abc+/=')).toBe('/conversations?limit=50&cursor=abc%2B%2F%3D')
  })

  test('message list always sends the contract limit and optional before cursor', () => {
    expect(messageListPath('conversation-1')).toBe(
      '/conversations/conversation-1/messages?limit=100',
    )
    expect(messageListPath('conversation-1', 'message-1')).toBe(
      '/conversations/conversation-1/messages?limit=100&before=message-1',
    )
  })
})

describe('chat error helpers', () => {
  test('detects the unified conversation-not-found error', () => {
    expect(isConversationNotFound(new ApiError('CONVERSATION_NOT_FOUND', 404, '会话不存在'))).toBe(
      true,
    )
    expect(isConversationNotFound(new ApiError('INTERNAL_ERROR', 500, '请求失败'))).toBe(false)
    expect(isConversationNotFound(new Error('network'))).toBe(false)
  })

  test('describes idempotency reuse without pretending success', () => {
    expect(
      describeSendFailure(new ApiError('IDEMPOTENCY_KEY_REUSED', 409, '同一个 clientRequestId')),
    ).toBe('该次发送已用于其它内容')
    expect(describeSendFailure(new ApiError('CONVERSATION_NOT_FOUND', 404, '会话不存在'))).toBe(
      '会话不存在或不可访问',
    )
    expect(describeSendFailure(new Error('network'))).toBe('发送失败，请重试')
  })
})
