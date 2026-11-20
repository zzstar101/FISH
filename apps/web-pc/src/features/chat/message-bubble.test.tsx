import { describe, expect, test } from 'bun:test'
import type { MediaMessageDto, MessageDto, MessageVisibility } from '@fish/contracts/chat/schema'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MediaBubble, MessageBubble, PendingMessageBubble } from './message-bubble'
import { createOutboxMessage, type OutboxTextMessage } from './outbox'

const CONVERSATION_ID = 'cnv_01jc000000e00800000000001a'
const ME = 'usr_01jc000000e00800000000000a'

function message(visibility: MessageVisibility, content = '要不要一起吃个饭'): MessageDto {
  return {
    id: 'msg_01jc000000e00800000000001v',
    conversationId: CONVERSATION_ID,
    senderId: ME,
    sender: { id: ME, nickname: '阿岚', avatarUrl: null },
    type: 'TEXT',
    content,
    recalledAt: null,
    replyTo: null,
    visibility,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function media(visibility: MessageVisibility): MediaMessageDto {
  return {
    id: 'msg_01jc000000e00800000000001w',
    conversationId: CONVERSATION_ID,
    senderId: ME,
    kind: 'IMAGE',
    mediaId: 'med_01jc000000e00800000000002a',
    url: '/api/conversations/x/media/y',
    mimeType: 'image/png',
    sizeBytes: 1_024,
    width: 800,
    height: 600,
    durationMs: null,
    recalledAt: null,
    replyTo: null,
    visibility,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function renderText(visibility: MessageVisibility, isMine: boolean): string {
  return renderToStaticMarkup(
    createElement(MessageBubble, {
      message: message(visibility),
      isMine,
      isRead: false,
      canRecall: false,
      onRecall: () => undefined,
    }),
  )
}

function pending(overrides: Partial<OutboxTextMessage> = {}): OutboxTextMessage {
  return {
    ...createOutboxMessage('内容被拦住了'),
    status: 'failed',
    error: '消息包含不适合发送的内容，请修改后重新发送',
    errorCode: 'MESSAGE_CONTENT_BLOCKED',
    ...overrides,
  }
}

function renderPending(item: OutboxTextMessage): string {
  return renderToStaticMarkup(
    createElement(PendingMessageBubble, {
      item,
      onRetry: () => undefined,
      onDismiss: () => undefined,
    }),
  )
}

describe('审核态气泡（#694 M4）', () => {
  test('发送者的待审消息带「审核中」，正文仍在', () => {
    const html = renderText('PENDING_REVIEW', true)
    expect(html).toContain('审核中')
    expect(html).toContain('要不要一起吃个饭')
    // 待审还没投递，不能装作已读。
    expect(html).not.toContain('已读')
  })

  test('发送者看到的被拒消息是稳定状态：正文 +「未通过审核」', () => {
    const html = renderText('REJECTED', true)
    expect(html).toContain('未通过审核')
    expect(html).toContain('要不要一起吃个饭')
  })

  test('已投递的消息不显示审核标签', () => {
    const html = renderText('DELIVERED', true)
    expect(html).not.toContain('审核中')
    expect(html).not.toContain('未通过审核')
  })

  test('接收者视角的待审 / 被拒内容不渲染正文（服务端过滤的兜底）', () => {
    for (const visibility of ['PENDING_REVIEW', 'REJECTED'] as const) {
      const html = renderText(visibility, false)
      expect(html).toContain('该消息暂不可见')
      expect(html).not.toContain('要不要一起吃个饭')
    }
  })

  test('媒体同理：接收者看不到待审图片的地址', () => {
    const html = renderToStaticMarkup(
      createElement(MediaBubble, {
        media: media('PENDING_REVIEW'),
        isMine: false,
        isRead: false,
        canRecall: false,
        onRecall: () => undefined,
      }),
    )
    expect(html).toContain('该消息暂不可见')
    expect(html).not.toContain('/api/conversations/x/media/y')
  })
})

describe('发送失败尾部（#694 M4）', () => {
  test('BLOCK 只给「修改后重发」的文案，不给必然再失败的重试按钮', () => {
    const html = renderPending(pending())
    expect(html).toContain('修改后重新发送')
    expect(html).not.toContain('重试')
    // 移除本地失败记录仍然可用。
    expect(html).toContain('移除')
  })

  test('503 可原样重试', () => {
    const html = renderPending(
      pending({
        error: '内容审核暂不可用，请稍后重试',
        errorCode: 'CONTENT_MODERATION_UNAVAILABLE',
      }),
    )
    expect(html).toContain('稍后重试')
    // 文案本身含「重试」二字，必须断言的是**按钮**（图标后的按钮文字收尾）
    expect(html).toContain('重试</button>')
  })

  test('429 冷却期内显示倒计时，且不放出重试按钮', () => {
    const html = renderPending(
      pending({
        error: '发送太频繁，请稍后重试',
        errorCode: 'MESSAGE_RATE_LIMITED',
        retryAfterAt: Date.now() + 30_000,
      }),
    )
    expect(html).toMatch(/冷却中 · \d+ 秒后可重试/)
    expect(html).not.toContain('重试</button>')
  })

  test('冷却结束后恢复重试入口', () => {
    const html = renderPending(
      pending({
        error: '发送太频繁，请稍后重试',
        errorCode: 'MESSAGE_RATE_LIMITED',
        retryAfterAt: Date.now() - 1_000,
      }),
    )
    expect(html).toContain('重试</button>')
    expect(html).not.toContain('冷却中')
  })
})
