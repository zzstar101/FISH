import { describe, expect, test } from 'bun:test'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
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

/** LISTING 消息引用的商品：公开 id ↔ 内部 uuid 用同一对常量，测试里保持可读。 */
const LISTING_ID = '01930000-0000-7000-8000-0000000000b1'
const LISTING_PUBLIC_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING_ID)
const OTHER_LISTING_ID = '01930000-0000-7000-8000-0000000000b2'
const OTHER_LISTING_PUBLIC_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, OTHER_LISTING_ID)

function listingBrief(
  overrides: Partial<{
    status: string
    moderationStatus: string | null
    coverObjectKey: string | null
  }> = {},
) {
  return {
    id: LISTING_ID,
    title: 'K380 键盘',
    priceCents: 16000,
    status: 'ACTIVE',
    moderationStatus: 'APPROVED',
    coverObjectKey: 'listings/covers/k380.webp',
    ...overrides,
  }
}

/** SQL store 的插入路径由 store 负责；service 测试只关心「注入了哪个商店 + storage」。 */
const neverBlocked = { existsBlockBetween: async () => false }
const serviceOf = (store: MemoryMessageStore) =>
  createMessageService({ store, storage, blocks: neverBlocked })

describe('message service: listMessages', () => {
  test('returns ascending messages with sender info', async () => {
    const store = new MemoryMessageStore()
    const first = await store.insertText(conversationA, buyer, '在吗')
    const second = await store.insertText(conversationA, seller, '在的')
    const service = serviceOf(store)
    const result = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(result.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.message, first.id),
      encodePublicId(PUBLIC_ID_PREFIX.message, second.id),
    ])
    expect(result.items[0]?.sender?.nickname).toBe('买家')
    expect(result.nextCursor).toBeNull()
  })

  test('404 CONVERSATION_NOT_FOUND for a non-participant (不泄漏存在性)', async () => {
    const service = serviceOf(new MemoryMessageStore())
    expect(service.listMessages(outsider, conversationA, { limit: 30 })).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
    })
  })

  test('422 on a cursor that does not belong to the conversation', async () => {
    const store = new MemoryMessageStore()
    await store.insertText(conversationA, buyer, '在吗')
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
    const service = serviceOf(new MemoryMessageStore())
    const dto = await service.sendTextMessage(buyer, conversationA, { content: '  还在吗  ' })
    expect(dto.type).toBe('TEXT')
    expect(dto.content).toBe('还在吗')
    expect(dto.sender?.id).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, buyer))
  })

  test('404 for a non-participant sender', async () => {
    const service = serviceOf(new MemoryMessageStore())
    expect(
      service.sendTextMessage(outsider, conversationA, { content: 'hello' }),
    ).rejects.toBeInstanceOf(MessageServiceError)
  })

  /*
   * #466 拉黑守卫：会话双方之间任一方向存在拉黑边，发送即被拦。中性码
   * CONVERSATION_UNAVAILABLE 对双方同码同文案——报错不区分「谁拉黑了谁」。
   */
  test('拉黑守卫：对方拉黑了我（反向边）→ 403 CONVERSATION_UNAVAILABLE', async () => {
    const service = createMessageService({
      store: new MemoryMessageStore(),
      storage,
      blocks: {
        existsBlockBetween: async (a, b) =>
          (a === seller && b === buyer) || (a === buyer && b === seller),
      },
    })
    await expect(
      service.sendTextMessage(buyer, conversationA, { content: 'hello' }),
    ).rejects.toMatchObject({ status: 403, code: 'CONVERSATION_UNAVAILABLE' })
  })

  test('拉黑守卫：我拉黑了对方（正向边）同样被拦（双向拦截）', async () => {
    const service = createMessageService({
      store: new MemoryMessageStore(),
      storage,
      blocks: {
        existsBlockBetween: async (a, b) =>
          (a === buyer && b === seller) || (a === seller && b === buyer),
      },
    })
    await expect(
      service.sendTextMessage(seller, conversationA, { content: 'hello' }),
    ).rejects.toMatchObject({ status: 403, code: 'CONVERSATION_UNAVAILABLE' })
  })

  test('守卫不误伤：无拉黑边时发送照常（neverBlocked 回归）', async () => {
    const dto = await serviceOf(new MemoryMessageStore()).sendTextMessage(buyer, conversationA, {
      content: 'hello',
    })
    expect(dto.type).toBe('TEXT')
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
    const service = serviceOf(store)

    expect(
      service.sendTextMessage(buyer, conversationA, { content: '还在吗' }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })

  test('replays the stored message for a retried clientRequestId（同键同内容）', async () => {
    const store = new MemoryMessageStore()
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
    const service = serviceOf(store)
    const clientRequestId = '01990000-0000-7000-8000-0000000000f2'
    await service.sendTextMessage(buyer, conversationA, { content: 'A', clientRequestId })
    expect(
      service.sendTextMessage(buyer, conversationA, { content: 'B', clientRequestId }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(store.messages).toHaveLength(1)
  })
})

describe('message service: sendListingMessage（#359 商品卡）', () => {
  test('落库 LISTING 消息：content 是商品公开 id，响应带富化后的 listing 投射', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    const dto = await serviceOf(store).sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
    })

    expect(dto.type).toBe('LISTING')
    expect(dto.content).toBe(LISTING_PUBLIC_ID)
    expect(dto.senderId).toBe(encodePublicId(PUBLIC_ID_PREFIX.user, buyer))
    expect(dto.listing).toEqual({
      id: LISTING_PUBLIC_ID,
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: 'https://cdn.test/listings/covers/k380.webp',
    })
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]?.type).toBe('LISTING')
  })

  /*
   * 审核私有键（`listing-review-media/`）不出直读 URL：与 conversations 的会话封面同口径
   * （#286 复审 blocker 1）。商品卡比会话头更容易被转发，这条不能只靠会话头那条用例兜。
   */
  test('审核中的封面（listing-review-media 键）不下发 coverUrl', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(
      LISTING_ID,
      listingBrief({
        coverObjectKey: `listing-review-media/${encodePublicId(
          PUBLIC_ID_PREFIX.user,
          seller,
        )}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000d1')}.jpg`,
      }),
    )
    const dto = await serviceOf(store).sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
    })
    expect(dto.listing?.coverUrl).toBeNull()
  })

  test('非参与者 → 404 CONVERSATION_NOT_FOUND', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    expect(
      serviceOf(store).sendListingMessage(outsider, conversationA, {
        type: 'LISTING',
        listingId: LISTING_PUBLIC_ID,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND' })
  })

  test('商品不存在 / 非在售 / 未过审 → 统一 404 LISTING_NOT_FOUND', async () => {
    const missing = new MemoryMessageStore()
    expect(
      serviceOf(missing).sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: LISTING_PUBLIC_ID,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })

    for (const overrides of [{ status: 'SOLD' }, { moderationStatus: 'BLOCKED' }]) {
      const store = new MemoryMessageStore()
      store.listings.set(LISTING_ID, listingBrief(overrides))
      expect(
        serviceOf(store).sendListingMessage(buyer, conversationA, {
          type: 'LISTING',
          listingId: LISTING_PUBLIC_ID,
        }),
      ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
      expect(store.messages).toHaveLength(0)
    }
  })

  test('幂等重试（同键同商品）返回同一条消息且只落一行', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    const clientRequestId = '01990000-0000-7000-8000-0000000000e1'
    const service = serviceOf(store)
    const first = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    const retry = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(store.messages).toHaveLength(1)
  })

  /*
   * 重放要**再推一次** message.new：首次推送可能在网络上丢了，而客户端是拿同一个幂等键重试的；
   * 重试若静默重放，对方只能靠重新拉历史才知道这条消息（与 sendTextMessage 的既有语义分叉）。
   */
  test('幂等重放也会推一次 message.new（与 TEXT 重放同语义）', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    const pushed: string[] = []
    const service = createMessageService({
      blocks: neverBlocked,
      store,
      storage,
      onMessageCreated: (_participants, message) => pushed.push(message.id),
    })
    const clientRequestId = '01990000-0000-7000-8000-0000000000e6'
    const first = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    const retry = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(pushed).toEqual([first.id, first.id])
  })

  test('同一 clientRequestId 换一个商品 → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    store.listings.set(OTHER_LISTING_ID, { ...listingBrief(), id: OTHER_LISTING_ID })
    const clientRequestId = '01990000-0000-7000-8000-0000000000e2'
    const service = serviceOf(store)
    await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: OTHER_LISTING_PUBLIC_ID,
        clientRequestId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(store.messages).toHaveLength(1)
  })

  /*
   * 幂等先于可见性：商品在「首发成功 → 重试」之间下架时，重试必须重放既有消息，
   * 不能因为商品此刻不可见就报 404 —— 那条消息其实已经落库了。
   */
  test('重试时商品已下架 → 仍重放既有消息（listing 反映此刻状态）', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    const clientRequestId = '01990000-0000-7000-8000-0000000000e3'
    const service = serviceOf(store)
    const first = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    store.listings.set(LISTING_ID, listingBrief({ status: 'SOLD' }))

    const retry = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(retry.listing?.status).toBe('SOLD')
    expect(store.messages).toHaveLength(1)
  })

  test('商品被物理删除后的重试：仍重放，listing 退化为 null', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    const clientRequestId = '01990000-0000-7000-8000-0000000000e4'
    const service = serviceOf(store)
    const first = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    store.listings.delete(LISTING_ID)

    const retry = await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(retry.listing).toBeNull()
  })

  // 同键换商品即使在「新商品不可见」时也必须是 409：幂等判定先于商品校验。
  test('同键换一个不可见的商品 → 409 而不是 404', async () => {
    const store = new MemoryMessageStore()
    store.listings.set(LISTING_ID, listingBrief())
    const clientRequestId = '01990000-0000-7000-8000-0000000000e5'
    const service = serviceOf(store)
    await service.sendListingMessage(buyer, conversationA, {
      type: 'LISTING',
      listingId: LISTING_PUBLIC_ID,
      clientRequestId,
    })
    expect(
      service.sendListingMessage(buyer, conversationA, {
        type: 'LISTING',
        listingId: OTHER_LISTING_PUBLIC_ID,
        clientRequestId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  test('历史页富化 LISTING 行；TEXT 行 listing 为 null；商品被删后退回 null', async () => {
    const store = new MemoryMessageStore()
    const deletedListingId = '01930000-0000-7000-8000-0000000000b3'
    const deletedPublicId = encodePublicId(PUBLIC_ID_PREFIX.listing, deletedListingId)
    store.listings.set(LISTING_ID, listingBrief())
    await store.insertText(conversationA, buyer, '在吗')
    await store.insertListing(conversationA, seller, LISTING_PUBLIC_ID)
    // 分享后商品被物理删除（#74 的删除路径连带清 listings）：历史消息仍在，投射为 null。
    await store.insertListing(conversationA, seller, deletedPublicId)

    const page = await serviceOf(store).listMessages(buyer, conversationA, { limit: 30 })
    expect(page.items.map((item) => item.type)).toEqual(['TEXT', 'LISTING', 'LISTING'])
    expect(page.items[0]?.listing).toBeNull()
    expect(page.items[1]?.listing).toMatchObject({
      id: LISTING_PUBLIC_ID,
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE',
    })
    expect(page.items[2]?.listing).toBeNull()
  })

  test('content 不是合法商品公开 id（脏数据）时该条 listing 为 null，不炸整页', async () => {
    const store = new MemoryMessageStore()
    await store.insertListing(conversationA, seller, 'lst_not-a-real-id')
    const page = await serviceOf(store).listMessages(buyer, conversationA, { limit: 30 })
    expect(page.items[0]?.listing).toBeNull()
  })
})

describe('message service: 引用（#359 3c）', () => {
  test('引用一条 TEXT：新消息带 replyTo 投射（id / senderId / 摘要）', async () => {
    const store = new MemoryMessageStore()
    const target = await store.insertText(conversationA, seller, '还在的，随时可看')
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
    const service = serviceOf(store)
    const dto = await service.sendTextMessage(buyer, conversationA, {
      content: '这张图还在吗',
      replyToId: encodePublicId(PUBLIC_ID_PREFIX.message, mediaId),
    })
    expect(dto.replyTo?.excerpt).toBe('[媒体]')
  })

  test('历史消息批量带引用投射；无引用的行 replyTo 为 null', async () => {
    const store = new MemoryMessageStore()
    const target = await store.insertText(conversationA, seller, '在的')
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
    const service = serviceOf(store)
    const sent = await service.sendTextMessage(buyer, conversationA, { content: 'x' })
    await service.recallMessage(buyer, conversationA, internalIdOf(sent.id))
    const first = store.messages[0]?.recalled_at
    store.recallNow = new Date('2026-09-12T10:00:20.000000Z')
    await service.recallMessage(buyer, conversationA, internalIdOf(sent.id))
    expect(store.messages[0]?.recalled_at).toEqual(first)
  })

  test('非发送者撤回 → 403 MESSAGE_RECALL_FORBIDDEN', async () => {
    const store = new MemoryMessageStore()
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
    const service = serviceOf(store)
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
      blocks: neverBlocked,
      store,
      storage,
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
    const service = serviceOf(store)
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
    const service = serviceOf(store)
    const clientRequestId = '01990000-0000-7000-8000-0000000000fb'
    await service.sendTextMessage(buyer, conversationA, { content: 'A', clientRequestId })
    expect(
      service.sendTextMessage(buyer, conversationA, { content: 'B', clientRequestId }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  test('重放不带引用：既有行没有引用就不给投射（不按本次请求凭空补一条）', async () => {
    const store = new MemoryMessageStore()
    const service = serviceOf(store)
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
