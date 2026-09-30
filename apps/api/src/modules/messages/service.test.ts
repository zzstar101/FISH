import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MediaStorage } from '../uploads/storage'
import {
  MEMORY_BUYER_ID as buyer,
  MEMORY_CONVERSATION_ID as conversationA,
  MemoryMessageStore,
  MEMORY_OUTSIDER_ID as outsider,
  MEMORY_SELLER_ID as seller,
} from './memory-store.fixture'
import { createMessageService, MessageServiceError } from './service'

const storage: MediaStorage = {
  presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
  stat: async () => null,
  publicUrl: (key) => `https://cdn.test/${key}`,
}

describe('message service: listMessages', () => {
  test('returns ascending messages with sender info', async () => {
    const store = new MemoryMessageStore()
    const first = await store.insertText(conversationA, buyer, '在吗')
    const second = await store.insertText(conversationA, seller, '在的')
    const service = createMessageService({ store, storage })
    const result = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(result.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.message, first.id),
      encodePublicId(PUBLIC_ID_PREFIX.message, second.id),
    ])
    expect(result.items[0]?.sender?.nickname).toBe('买家')
    expect(result.nextCursor).toBeNull()
  })

  test('404 CONVERSATION_NOT_FOUND for a non-participant (不泄漏存在性)', async () => {
    const service = createMessageService({ store: new MemoryMessageStore(), storage })
    expect(service.listMessages(outsider, conversationA, { limit: 30 })).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
    })
  })

  test('422 on a cursor that does not belong to the conversation', async () => {
    const store = new MemoryMessageStore()
    await store.insertText(conversationA, buyer, '在吗')
    const service = createMessageService({ store, storage })
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
    const service = createMessageService({ store, storage })
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

  test('LISTING 消息带商品投射，TEXT 行恒 null（#359）', async () => {
    const store = new MemoryMessageStore()
    await store.insertText(conversationA, buyer, '在吗')
    const listingUuid = '01930000-0000-7000-8000-0000000000b1'
    const listingPublicId = encodePublicId(PUBLIC_ID_PREFIX.listing, listingUuid)
    store.listingBriefs.set(listingUuid, {
      id: listingUuid,
      title: '机械键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      coverObjectKey: 'listings/x/cover.jpg',
    })
    await store.insertListing(conversationA, seller, listingPublicId)

    const service = createMessageService({ store, storage })
    const result = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(result.items.map((item) => item.type)).toEqual(['TEXT', 'LISTING'])
    const [text, card] = result.items
    expect(text?.listing).toBeNull()
    expect(card?.listing).toMatchObject({
      id: listingPublicId,
      title: '机械键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: 'https://cdn.test/listings/x/cover.jpg',
    })
  })

  test('LISTING 引用的商品缺失时投射为 null，不影响整页返回（#359）', async () => {
    const store = new MemoryMessageStore()
    const dangling = encodePublicId(
      PUBLIC_ID_PREFIX.listing,
      '01930000-0000-7000-8000-0000000000b2',
    )
    await store.insertListing(conversationA, buyer, dangling)
    const service = createMessageService({ store, storage })
    const result = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(result.items[0]?.type).toBe('LISTING')
    expect(result.items[0]?.listing).toBeNull()
  })
})

describe('message service: sendTextMessage', () => {
  test('persists a TEXT message from the sender', async () => {
    const service = createMessageService({ store: new MemoryMessageStore(), storage })
    const dto = await service.sendTextMessage(buyer, conversationA, {
      type: 'TEXT',
      content: '  还在吗  ',
    })
    expect(dto.type).toBe('TEXT')
    expect(dto.content).toBe('还在吗')
    expect(dto.sender?.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, buyer))
  })

  test('404 for a non-participant sender', async () => {
    const service = createMessageService({ store: new MemoryMessageStore(), storage })
    expect(
      service.sendTextMessage(outsider, conversationA, { type: 'TEXT', content: 'hello' }),
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
    const service = createMessageService({ store, storage })

    expect(
      service.sendTextMessage(buyer, conversationA, { type: 'TEXT', content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })

  test('replays the stored message for a retried clientRequestId（同键同内容）', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store, storage })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f1'
    const first = await service.sendTextMessage(buyer, conversationA, {
      type: 'TEXT',
      content: '还在吗',
      clientRequestId,
    })
    const retry = await service.sendTextMessage(buyer, conversationA, {
      type: 'TEXT',
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
    const service = createMessageService({ store, storage })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f3'
    const first = await service.sendTextMessage(buyer, conversationA, {
      type: 'TEXT',
      content: 'A ',
      clientRequestId,
    })
    const retry = await service.sendTextMessage(buyer, conversationA, {
      type: 'TEXT',
      content: 'A',
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(retry.content).toBe('A')
    expect(store.messages).toHaveLength(1)
  })

  test('同一 clientRequestId 携带不同内容 → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store, storage })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f2'
    await service.sendTextMessage(buyer, conversationA, {
      type: 'TEXT',
      content: 'A',
      clientRequestId,
    })
    expect(
      service.sendTextMessage(buyer, conversationA, {
        type: 'TEXT',
        content: 'B',
        clientRequestId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(store.messages).toHaveLength(1)
  })
})

describe('message service: sendListingMessage（#359）', () => {
  const listingUuid = '01930000-0000-7000-8000-0000000000b1'
  const listingPublicId = encodePublicId(PUBLIC_ID_PREFIX.listing, listingUuid)

  const seedActiveListing = (store: MemoryMessageStore) => {
    store.listingBriefs.set(listingUuid, {
      id: listingUuid,
      title: '机械键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      coverObjectKey: 'listings/x/cover.jpg',
    })
  }

  test('参与者发送在售商品 → 201 卡片消息，content 存公开 id，投射完整', async () => {
    const store = new MemoryMessageStore()
    seedActiveListing(store)
    const service = createMessageService({ store, storage })
    const dto = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: listingPublicId,
    })
    expect(dto.type).toBe('LISTING')
    expect(dto.content).toBe(listingPublicId)
    expect(dto.listing).toMatchObject({
      id: listingPublicId,
      title: '机械键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: 'https://cdn.test/listings/x/cover.jpg',
    })
    expect(store.messages[0]?.sender_id).toBe(buyer)
  })

  test('非参与者 → 404 CONVERSATION_NOT_FOUND（不泄漏存在性）', async () => {
    const store = new MemoryMessageStore()
    seedActiveListing(store)
    const service = createMessageService({ store, storage })
    expect(
      service.sendListingMessage(outsider, conversationA, {
        type: 'LISTING',
        listingId: listingPublicId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })

  test('商品不存在 → 404 LISTING_NOT_FOUND', async () => {
    const service = createMessageService({ store: new MemoryMessageStore(), storage })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b3'),
      }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
  })

  test('商品非 ACTIVE（已售/下架）→ 404 LISTING_NOT_FOUND（不区分不可见原因）', async () => {
    const store = new MemoryMessageStore()
    store.listingBriefs.set(listingUuid, {
      id: listingUuid,
      title: '机械键盘',
      priceCents: 16000,
      status: 'SOLD',
      moderationStatus: 'APPROVED',
      coverObjectKey: null,
    })
    const service = createMessageService({ store, storage })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: listingPublicId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
    expect(store.messages).toHaveLength(0)
  })

  test('listingId 不是合法公开 id → 404 LISTING_NOT_FOUND（防伪造 uuid 500）', async () => {
    const service = createMessageService({ store: new MemoryMessageStore(), storage })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: 'not-a-listing-id' as `lst_${string}`,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
  })

  test('ACTIVE 但审核未过（REVIEW）→ 404：与选择页数据源（ACTIVE AND APPROVED）同口径', async () => {
    // 库里存在 status=ACTIVE 且 moderation_status=REVIEW 的行（历史/直写数据），
    // 只判 status 会把「选择页里根本不出现的商品」放进来——口径必须在发送侧自证。
    const store = new MemoryMessageStore()
    store.listingBriefs.set(listingUuid, {
      id: listingUuid,
      title: '机械键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      moderationStatus: 'REVIEW',
      coverObjectKey: null,
    })
    const service = createMessageService({ store, storage })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: listingPublicId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
    expect(store.messages).toHaveLength(0)
  })

  test('幂等键重试返回既有消息；同键换商品 → 409', async () => {
    const store = new MemoryMessageStore()
    seedActiveListing(store)
    const service = createMessageService({ store, storage })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f4'
    const first = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: listingPublicId,
      clientRequestId,
    })
    const retry = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: listingPublicId,
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(store.messages).toHaveLength(1)

    const otherUuid = '01930000-0000-7000-8000-0000000000b4'
    store.listingBriefs.set(otherUuid, {
      id: otherUuid,
      title: '另一件',
      priceCents: 1000,
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      coverObjectKey: null,
    })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, otherUuid),
        clientRequestId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  test('会话在写入瞬间被删（外键冲突）→ 404 CONVERSATION_NOT_FOUND', async () => {
    const store = new MemoryMessageStore()
    seedActiveListing(store)
    store.insertListing = async () => {
      throw Object.assign(new Error('Failed query: insert into messages …'), {
        query: 'insert into messages …',
        params: [],
        cause: Object.assign(new Error('violates foreign key constraint'), { errno: '23503' }),
      })
    }
    const service = createMessageService({ store, storage })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: listingPublicId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })
})
