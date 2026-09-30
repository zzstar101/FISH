import { describe, expect, test } from 'bun:test'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  MEMORY_BUYER_ID as buyer,
  MEMORY_CONVERSATION_ID as conversationA,
  MemoryMessageStore,
  MEMORY_OUTSIDER_ID as outsider,
  MEMORY_SELLER_ID as seller,
} from './memory-store.fixture'
import { createMessageService, MessageServiceError } from './service'

describe('message service: listMessages', () => {
  test('returns ascending messages with sender info', async () => {
    const store = new MemoryMessageStore()
    const first = await store.insertText(conversationA, buyer, '在吗')
    const second = await store.insertText(conversationA, seller, '在的')
    const service = createMessageService({ store })
    const result = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(result.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.message, first.id),
      encodePublicId(PUBLIC_ID_PREFIX.message, second.id),
    ])
    expect(result.items[0]?.sender?.nickname).toBe('买家')
    expect(result.nextCursor).toBeNull()
  })

  test('404 CONVERSATION_NOT_FOUND for a non-participant (不泄漏存在性)', async () => {
    const service = createMessageService({ store: new MemoryMessageStore() })
    expect(service.listMessages(outsider, conversationA, { limit: 30 })).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
    })
  })

  test('422 on a cursor that does not belong to the conversation', async () => {
    const store = new MemoryMessageStore()
    await store.insertText(conversationA, buyer, '在吗')
    const service = createMessageService({ store })
    expect(
      service.listMessages(buyer, conversationA, {
        limit: 30,
        before: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
  })

  test('cursor pagination walks backwards through history', async () => {
    const store = new MemoryMessageStore()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await store.insertText(conversationA, buyer, `m${i}`)).id)
    const service = createMessageService({ store })
    const [first, second, third] = ids
    if (!first || !second || !third) throw new Error('unreachable')

    const page1 = await service.listMessages(buyer, conversationA, { limit: 2 })
    expect(page1.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.message, second),
      encodePublicId(PUBLIC_ID_PREFIX.message, third),
    ])
    expect(page1.nextCursor).toBe(encodePublicId(PUBLIC_ID_PREFIX.message, second))

    const page2 = await service.listMessages(buyer, conversationA, { limit: 2, before: second })
    expect(page2.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.message, first),
    ])
    expect(page2.nextCursor).toBeNull()
  })
})

describe('message service: sendTextMessage', () => {
  test('persists a TEXT message from the sender', async () => {
    const service = createMessageService({ store: new MemoryMessageStore() })
    const dto = await service.sendTextMessage(buyer, conversationA, { content: '  还在吗  ' })
    expect(dto.type).toBe('TEXT')
    expect(dto.content).toBe('还在吗')
    expect(dto.sender?.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, buyer))
  })

  test('404 for a non-participant sender', async () => {
    const service = createMessageService({ store: new MemoryMessageStore() })
    expect(
      service.sendTextMessage(outsider, conversationA, { content: 'hello' }),
    ).rejects.toBeInstanceOf(MessageServiceError)
  })

  /*
   * 会话随商品物理删除（#74 的删除路径连带清 `conversations` 与其消息），所以
   * 「读会话 → 写消息」之间会话消失是可达的：`messages.conversation_id` 的外键会拒绝。
   * 语义与「会话不存在」一致 —— 必须是 404，不能让 23503 走 `app.onError` 变 500。
   */
  test('会话在写入瞬间被删（外键冲突）→ 404 CONVERSATION_NOT_FOUND，而不是 500', async () => {
    const store = new MemoryMessageStore()
    store.insertText = async () => {
      throw Object.assign(new Error('Failed query: insert into messages …'), {
        query: 'insert into messages …',
        params: [],
        cause: Object.assign(new Error('violates foreign key constraint'), { errno: '23503' }),
      })
    }
    const service = createMessageService({ store })

    expect(
      service.sendTextMessage(buyer, conversationA, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })

  test('replays the stored message for a retried clientRequestId（同键同内容）', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f1'
    const first = await service.sendTextMessage(buyer, conversationA, {
      content: '还在吗',
      clientRequestId,
    })
    const retry = await service.sendTextMessage(buyer, conversationA, {
      content: '还在吗',
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(store.messages).toHaveLength(1)
  })

  test('重试内容仅差首尾空白：判为同一请求并重放（而不是 409）', async () => {
    // 指纹与落库都用 trim 后的正文，所以 'A ' 与 'A' 是**同一个**请求。若指纹改成对
    // 未 trim 的内容取哈希，这里会撞成 409 —— 这条用例专门把两种情况区分开。
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f3'
    const first = await service.sendTextMessage(buyer, conversationA, {
      content: 'A ',
      clientRequestId,
    })
    const retry = await service.sendTextMessage(buyer, conversationA, {
      content: 'A',
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(retry.content).toBe('A')
    expect(store.messages).toHaveLength(1)
  })

  test('同一 clientRequestId 携带不同内容 → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f2'
    await service.sendTextMessage(buyer, conversationA, { content: 'A', clientRequestId })
    expect(
      service.sendTextMessage(buyer, conversationA, { content: 'B', clientRequestId }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(store.messages).toHaveLength(1)
  })
})

describe('message service: 引用（#359 3c）', () => {
  test('引用一条 TEXT：新消息带 replyTo 投射（id / senderId / 摘要）', async () => {
    const store = new MemoryMessageStore()
    const target = await store.insertText(conversationA, seller, '还在的，随时可看')
    const service = createMessageService({ store })
    const dto = await service.sendTextMessage(buyer, conversationA, {
      content: '那我晚点来',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
    })
    expect(dto.replyTo).toEqual({
      id: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
      senderId: encodePublicId(PUBLIC_ID_PREFIX.user, seller),
      excerpt: '还在的，随时可看',
    })
  })

  test('摘要超长截断到 120 字并带省略号（契约 excerpt 上限）', async () => {
    const store = new MemoryMessageStore()
    const long = 'a'.repeat(200)
    const target = await store.insertText(conversationA, buyer, long)
    const service = createMessageService({ store })
    const dto = await service.sendTextMessage(seller, conversationA, {
      content: '收到',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
    })
    expect(dto.replyTo?.excerpt).toBe(`${'a'.repeat(119)}…`)
  })

  test('引用媒体消息：摘要用方括号占位（不泄漏正文）', async () => {
    const store = new MemoryMessageStore()
    // 媒体行另有 media_objects 关联（不在 messages.content 里），fixture 直接塞一行同型数据。
    const mediaId = '01930000-0000-7000-8000-0000000000c9'
    store.messages.push({
      id: mediaId,
      conversation_id: conversationA,
      sender_id: seller,
      type: 'MEDIA',
      content: '',
      created_at: new Date('2026-09-12T10:00:00.500000Z'),
    })
    const service = createMessageService({ store })
    const dto = await service.sendTextMessage(buyer, conversationA, {
      content: '这张图还在吗',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, mediaId),
    })
    expect(dto.replyTo?.excerpt).toBe('[媒体]')
  })

  test('历史消息批量带引用投射；无引用的行 replyTo 为 null', async () => {
    const store = new MemoryMessageStore()
    const target = await store.insertText(conversationA, seller, '在的')
    const service = createMessageService({ store })
    await service.sendTextMessage(buyer, conversationA, {
      content: '好',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
    })
    const page = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(page.items[0]?.replyTo).toBeNull()
    expect(page.items[1]?.replyTo?.excerpt).toBe('在的')
  })

  test('不可引用的目标统一 422 MESSAGE_REPLY_INVALID：不存在 / SYSTEM / 已撤回', async () => {
    const store = new MemoryMessageStore()
    const system = await store.insertSystem(conversationA, '{"type":"tx.proposal"}')
    const recalled = await store.insertText(conversationA, buyer, '口误')
    recalled.recalled_at = new Date('2026-09-12T10:00:09.000000Z')
    const service = createMessageService({ store })
    const missing = encodePublicId(PUBLIC_ID_PREFIX.message, '01930000-0000-7000-8000-0000000000ee')
    for (const id of [
      missing,
      encodePublicId(PUBLIC_ID_PREFIX.message, system.id),
      encodePublicId(PUBLIC_ID_PREFIX.message, recalled.id),
    ]) {
      expect(
        service.sendTextMessage(buyer, conversationA, {
          content: 'x',
          replyToId: id,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'MESSAGE_REPLY_INVALID' })
    }
    expect(store.messages).toHaveLength(2)
  })
})

describe('message service: 撤回（#359 3c）', () => {
  /** `recallMessage` 的入参是内部 uuid（router 负责从公开 id 解出，与 listMessages 同口径）。 */
  const internalIdOf = (publicId: string): string =>
    decodePublicId(PUBLIC_ID_PREFIX.message, publicId)

  test('发送者本人在窗口内撤回：recalledAt 落库、正文清空、历史不再下发原文', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const sent = await service.sendTextMessage(buyer, conversationA, {
      content: '发错了',
    })
    expect(sent.recalledAt).toBeNull()
    await service.recallMessage(buyer, conversationA, internalIdOf(sent.id))
    const page = await service.listMessages(buyer, conversationA, { limit: 30 })
    const row = page.items.find((item) => item.id === sent.id)
    expect(row?.recalledAt).not.toBeNull()
    expect(row?.content).toBe('')
  })

  test('重复撤回幂等（撤回时刻不被刷新）', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const sent = await service.sendTextMessage(buyer, conversationA, { content: 'x' })
    await service.recallMessage(buyer, conversationA, internalIdOf(sent.id))
    const first = store.messages[0]?.recalled_at
    store.recallNow = new Date('2026-09-12T10:00:20.000000Z')
    await service.recallMessage(buyer, conversationA, internalIdOf(sent.id))
    expect(store.messages[0]?.recalled_at).toEqual(first)
  })

  test('非发送者撤回 → 403 MESSAGE_RECALL_FORBIDDEN', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const sent = await service.sendTextMessage(buyer, conversationA, { content: 'x' })
    expect(
      service.recallMessage(seller, conversationA, internalIdOf(sent.id)),
    ).rejects.toMatchObject({
      status: 403,
      code: 'MESSAGE_RECALL_FORBIDDEN',
    })
  })

  test('超出窗口 → 409 MESSAGE_RECALL_WINDOW_EXCEEDED', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const sent = await service.sendTextMessage(buyer, conversationA, { content: 'x' })
    // fixture 的 created_at 是「第 seq 秒」，把「现在」推到 120s 窗口之外。
    store.recallNow = new Date('2026-09-12T10:05:00.000000Z')
    expect(
      service.recallMessage(buyer, conversationA, internalIdOf(sent.id)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'MESSAGE_RECALL_WINDOW_EXCEEDED',
    })
  })

  test('跨会话 / 不存在的消息 → 404 MESSAGE_NOT_FOUND（不泄漏存在性）', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    await service.sendTextMessage(buyer, conversationA, { content: 'x' })
    const missing = '01930000-0000-7000-8000-0000000000ef'
    expect(service.recallMessage(buyer, conversationA, missing)).rejects.toMatchObject({
      status: 404,
      code: 'MESSAGE_NOT_FOUND',
    })
  })

  test('撤回成功后回调 onMessageRecalled（推送契约字段）', async () => {
    const store = new MemoryMessageStore()
    const events: Array<Record<string, string>> = []
    const service = createMessageService({
      store,
      onMessageRecalled: (_participants, event) =>
        events.push(event as unknown as Record<string, string>),
    })
    const sent = await service.sendTextMessage(buyer, conversationA, { content: 'x' })
    await service.recallMessage(buyer, conversationA, internalIdOf(sent.id))
    expect(events).toHaveLength(1)
    expect(events[0]?.messageId).toBe(sent.id)
    expect(events[0]?.recalledBy).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, buyer))
  })
})

describe('message service: 幂等重放先于引用校验（#365 审查）', () => {
  const internalIdOf = (publicId: string): string =>
    decodePublicId(PUBLIC_ID_PREFIX.message, publicId)

  test('重试时被引用那条已撤回：重放既有消息，而不是 422', async () => {
    const store = new MemoryMessageStore()
    const target = await store.insertText(conversationA, seller, '在的')
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000fa'
    const first = await service.sendTextMessage(buyer, conversationA, {
      content: '收到',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
      clientRequestId,
    })
    // 重试之前被引用那条被撤回了：消息其实早就发出去了，重试必须重放它。
    target.recalled_at = new Date('2026-09-12T10:00:09.000000Z')
    const retry = await service.sendTextMessage(buyer, conversationA, {
      content: '收到',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(store.messages).toHaveLength(2)
    // 摘引取自那条既有行的 reply_to_id，此刻已被撤回 → 与历史同口径
    expect(retry.replyTo?.excerpt).toBe('[消息已撤回]')
  })

  test('重放仍守 409：同键不同内容不会被快速路径放行', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000fb'
    await service.sendTextMessage(buyer, conversationA, { content: 'A', clientRequestId })
    expect(
      service.sendTextMessage(buyer, conversationA, { content: 'B', clientRequestId }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  test('重放不带引用：既有行没有引用就不给投射（不按本次请求凭空补一条）', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const target = await store.insertText(conversationA, seller, '在的')
    const clientRequestId = '01990000-0000-7000-8000-0000000000fc'
    const first = await service.sendTextMessage(buyer, conversationA, {
      content: '收到',
      clientRequestId,
    })
    // 用同一个键 + 同一正文，但改成带引用重试 —— 指纹不含引用，判为同一次请求
    const retry = await service.sendTextMessage(buyer, conversationA, {
      content: '收到',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(retry.replyTo).toBeNull()
    expect(internalIdOf(retry.id)).toBe(internalIdOf(first.id))
  })
})
