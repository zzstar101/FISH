import { describe, expect, test } from 'bun:test'
import type { ChatModerationQueueItem } from '@fish/contracts/moderation/chat-schema'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatModerationItemCard } from './chat-moderation-page'

function item(overrides: Partial<ChatModerationQueueItem>): ChatModerationQueueItem {
  return {
    id: 'cmr_00000000-0000-4000-8000-000000000001',
    messageId: 'msg_00000000-0000-4000-8000-000000000002',
    conversationId: 'cnv_00000000-0000-4000-8000-000000000003',
    sender: { id: 'usr_00000000-0000-4000-8000-000000000004', nickname: '小明' },
    kind: 'TEXT',
    decision: 'REVIEW',
    suggestion: 'Review',
    provider: 'LOCAL',
    policyVersion: '2026-11-20-v4',
    score: null,
    matchedRules: ['EXTERNAL_CONTACT'],
    matchedTermsMasked: ['加*信'],
    content: '加微信聊',
    mimeType: null,
    sizeBytes: null,
    hasMedia: false,
    version: 0,
    createdAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  }
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

describe('ChatModerationItemCard（聊天待审队列）', () => {
  test('文字待审展示命中词与正文', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModerationItemCard, { item: item({}), onSelect: () => {} }),
    )
    const text = textOf(html)
    expect(text).toContain('小明')
    expect(text).toContain('加微信聊')
    expect(text).toContain('加*信')
    expect(text).toContain('文字')
  })

  test('图片待审走管理员鉴权快照路径，不直接暴露对象存储', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModerationItemCard, {
        item: item({
          kind: 'IMAGE',
          content: null,
          mimeType: 'image/webp',
          sizeBytes: 2048,
          hasMedia: true,
        }),
        onSelect: () => {},
      }),
    )
    expect(html).toContain(
      '/api/admin/chat-moderation/cmr_00000000-0000-4000-8000-000000000001/media',
    )
  })
})
