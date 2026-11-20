import { describe, expect, test } from 'bun:test'
import { newId } from '@fish/db/ids'
import {
  type ChatModerationDelivery,
  ChatModerationServiceError,
  createChatModerationService,
} from './chat-service'
import type {
  ChatModerationDecisionResult,
  ChatModerationMessageRow,
  ChatModerationStore,
} from './chat-store'

/*
 * #694 M4 投递侧：人工放行是「一次」事件。
 *
 * 消息行与审核记录在 store.decide 的同一事务里改 visibility，service 只负责在
 * `applied && ALLOW` 时把已提交的行推给双方一次 —— 同结论重复提交（replayed）**不能**
 * 再推一次，否则接收者会收到重复的 `message.new`，未读也可能被重复计一脚。
 * REJECTED（人工拒绝）同理：只改可见性，不投递。
 */

// 公开 id 编码只认 UUIDv7（`packages/shared/src/public-id.ts`），测试里不能手搓 v4。
const conversationId = newId()
const messageId = newId()
const recordId = newId()
const buyerId = newId()
const sellerId = newId()
const senderId = sellerId
const mediaId = newId()
const actorUserId = newId()

function messageRow(overrides: Partial<ChatModerationMessageRow> = {}): ChatModerationMessageRow {
  return {
    id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    type: 'TEXT',
    content: '周末有空吗',
    reply_to_id: null,
    recalled_at: null,
    created_at: new Date('2026-11-20T10:00:00Z'),
    sender_nickname: '卖家',
    sender_avatar_url: null,
    visibility: 'DELIVERED',
    media: null,
    ...overrides,
  }
}

type AppliedResult = Extract<ChatModerationDecisionResult, { outcome: 'applied' | 'replayed' }>

function applied(
  visibility: 'DELIVERED' | 'REJECTED',
  row: ChatModerationMessageRow = messageRow({ visibility }),
): AppliedResult {
  return {
    outcome: 'applied',
    recordId,
    messageId,
    conversationId,
    buyerId,
    sellerId,
    visibility,
    message: row,
  }
}

/** 只实现 decide 的假 store；list/findMedia 用不到，给会炸的桩防止误用。 */
function fakeStore(results: ChatModerationDecisionResult[]): ChatModerationStore {
  const queue = [...results]
  return {
    listPending: () => {
      throw new Error('unexpected listPending')
    },
    decide: async () => {
      const next = queue.shift()
      if (!next) throw new Error('unexpected decide')
      return next
    },
    findMediaSnapshot: () => {
      throw new Error('unexpected findMediaSnapshot')
    },
  }
}

function build(results: ChatModerationDecisionResult[]) {
  const deliveries: ChatModerationDelivery[] = []
  const service = createChatModerationService({
    store: fakeStore(results),
    mediaUrl: (convPublicId, mediaPublicId) =>
      `/api/conversations/${convPublicId}/media/${mediaPublicId}`,
    onDelivered: (delivery) => deliveries.push(delivery),
  })
  return { service, deliveries }
}

const decision = { decision: 'ALLOW' as const, reason: '人工复核通过', version: 1 }

describe('聊天待审投递（#694 M4）', () => {
  test('机器 REVIEW 的消息人工放行后只投递一次', async () => {
    const replay: ChatModerationDecisionResult = {
      ...applied('DELIVERED'),
      outcome: 'replayed',
    }
    const { service, deliveries } = build([applied('DELIVERED'), replay])

    const first = await service.decide(recordId, decision, actorUserId)
    expect(first.replayed).toBe(false)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ kind: 'message', buyerId, sellerId })
    const delivered = deliveries[0]
    if (delivered?.kind !== 'message') throw new Error('unreachable')
    expect(delivered.message.content).toBe('周末有空吗')
    expect(delivered.message.visibility).toBe('DELIVERED')

    // 同结论重复提交：接口照常回 200，但**不再投递** —— 接收者那条只出现一次。
    const second = await service.decide(recordId, decision, actorUserId)
    expect(second.replayed).toBe(true)
    expect(deliveries).toHaveLength(1)
  })

  test('人工拒绝不投递（被拒行对发送者的可读性由 store 用例覆盖）', async () => {
    const { service, deliveries } = build([applied('REJECTED')])

    const result = await service.decide(
      recordId,
      { decision: 'BLOCK', reason: '含外部联系方式', version: 1 },
      actorUserId,
    )
    expect(result.decision).toBe('BLOCK')
    expect(deliveries).toHaveLength(0)
  })

  test('放行的图片走 media 投递，URL 指向鉴权代理端点而不是对象存储', async () => {
    const mediaMessage = messageRow({
      type: 'MEDIA',
      content: '',
      media: {
        id: mediaId,
        kind: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: 2_048,
        width: 800,
        height: 600,
        durationMs: null,
      },
    })
    const { service, deliveries } = build([applied('DELIVERED', mediaMessage)])

    await service.decide(recordId, decision, actorUserId)

    expect(deliveries).toHaveLength(1)
    const delivered = deliveries[0]
    if (delivered?.kind !== 'media') throw new Error('unreachable')
    expect(delivered.media.kind).toBe('IMAGE')
    expect(delivered.media.visibility).toBe('DELIVERED')
    // 公开 id 带前缀（`cnv_` / `med_`），不是裸 uuid，更不是对象存储地址。
    expect(delivered.media.url).toMatch(/^\/api\/conversations\/cnv_[^/]+\/media\/med_[^/]+$/)
  })

  test('记录不存在 404、版本过期 409', async () => {
    const notFound = build([{ outcome: 'not-found' }]).service
    await expect(notFound.decide(recordId, decision, actorUserId)).rejects.toMatchObject({
      code: 'CHAT_MODERATION_NOT_FOUND',
      status: 404,
    })

    const conflict = build([{ outcome: 'conflict' }]).service
    await expect(conflict.decide(recordId, decision, actorUserId)).rejects.toBeInstanceOf(
      ChatModerationServiceError,
    )
  })
})
