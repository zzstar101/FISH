import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createPresenceRegistry } from '../presence/presence'
import type { MediaStorage } from '../uploads/storage'
import { ConversationServiceError, createConversationService } from './service'

const neverBlocked = { existsBlockBetween: async () => false }

import type { ConversationDetailRow, ConversationStore, ListingBrief } from './store'

const buyer = '01930000-0000-7000-8000-0000000000a1'
const seller = '01930000-0000-7000-8000-0000000000a2'
const listingA = '01930000-0000-7000-8000-0000000000b1'
const conversationA = '01930000-0000-7000-8000-0000000000c1'

const storage: MediaStorage = {
  presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
  stat: async () => null,
  publicUrl: (key) => `https://cdn.test/${key}`,
}

/**
 * 在线态读模型（#359 第五点）。用真登记表（没人 touch 过 → 全员离线）当默认，
 * 这样 DTO 里的 `counterpartPresence` 是一个确定的「离线 / 从未活动」形状；
 * 需要断言「在线」的用例自己注入一个固定的 reader。
 */
const presence = createPresenceRegistry()

function detailRow(overrides: Partial<ConversationDetailRow> = {}): ConversationDetailRow {
  return {
    conversation: {
      id: conversationA,
      listing_id: listingA,
      buyer_id: buyer,
      seller_id: seller,
      buyer_last_read_at: null,
      seller_last_read_at: null,
      last_message_at: '2026-09-12T10:00:00.123456Z',
      created_at: '2026-09-12T09:00:00.000000Z',
      updated_at: '2026-09-12T09:00:00.000000Z',
    },
    listing: { id: listingA, title: 'K380', priceCents: 16000, status: 'ACTIVE', sellerId: seller },
    counterpart: { id: seller, nickname: '卖家', avatarUrl: null },
    unreadCount: 2,
    coverObjectKey: null,
    lastMessage: {
      type: 'TEXT',
      content: '在吗',
      senderId: seller,
      createdAt: '2026-09-12T10:00:00.123456Z',
    },
    lastMessageAtCursor: '2026-09-12T10:00:00.123456Z',
    ...overrides,
  }
}

class MemoryConversationStore implements ConversationStore {
  listings = new Map<string, ListingBrief>([[listingA, { id: listingA, sellerId: seller }]])
  details = new Map<string, ConversationDetailRow>()

  async findListingBrief(listingId: string) {
    return this.listings.get(listingId) ?? null
  }

  async listChatWatchers() {
    return { rows: [], total: 0 }
  }

  async insertIfAbsent(listingId: string, buyerId: string, sellerId: string) {
    const existing = [...this.details.values()].find(
      (row) => row.conversation.listing_id === listingId && row.conversation.buyer_id === buyerId,
    )
    if (existing) return null
    const id = `01930000-0000-7000-8000-${String(this.details.size + 1).padStart(12, '0')}`
    this.details.set(
      id,
      detailRow({
        conversation: {
          ...detailRow().conversation,
          id,
          listing_id: listingId,
          buyer_id: buyerId,
          seller_id: sellerId,
        },
      }),
    )
    const created = this.details.get(id)
    if (!created) throw new Error('unreachable')
    return created.conversation
  }

  async findIdByListingAndBuyer(listingId: string, buyerId: string) {
    return (
      [...this.details.values()].find(
        (row) => row.conversation.listing_id === listingId && row.conversation.buyer_id === buyerId,
      )?.conversation.id ?? null
    )
  }

  async findDetail(conversationId: string, viewerId: string) {
    const row = this.details.get(conversationId)
    if (!row) return null
    if (row.conversation.buyer_id !== viewerId && row.conversation.seller_id !== viewerId) {
      return null
    }
    return row
  }

  async listForUser(
    viewerId: string,
    filter: { limit: number; cursor: { sortKey: string; id: string } | null },
  ) {
    const all = [...this.details.values()]
      .filter(
        (row) => row.conversation.buyer_id === viewerId || row.conversation.seller_id === viewerId,
      )
      .sort((a, b) => {
        const key = (r: ConversationDetailRow) => String(r.conversation.last_message_at)
        return key(b).localeCompare(key(a)) || b.conversation.id.localeCompare(a.conversation.id)
      })
    if (filter.cursor) {
      const cursorId = filter.cursor.id
      const index = all.findIndex((row) => row.conversation.id === cursorId)
      return index === -1 ? [] : all.slice(index + 1)
    }
    return all.slice(0, filter.limit + 1)
  }

  async coverObjectKeys(listingIds: string[]) {
    return new Map(listingIds.map((id) => [id, `covers/${id}.jpg`]))
  }

  async markRead(conversationId: string, viewerId: string) {
    const row = await this.findDetail(conversationId, viewerId)
    if (!row) return null
    row.unreadCount = 0
    // 与 SQL store 同语义（`UPDATE ... SET <viewer 侧> = now()`）：推进查看者一侧的
    // last_read_at。service 的 readAt 取的就是这个值，不推进的话推送断言无从谈起。
    const at = new Date().toISOString()
    if (row.conversation.buyer_id === viewerId) row.conversation.buyer_last_read_at = at
    else row.conversation.seller_last_read_at = at
    return row
  }

  async countUnread(viewerId: string) {
    return [...this.details.values()]
      .filter(
        (row) => row.conversation.buyer_id === viewerId || row.conversation.seller_id === viewerId,
      )
      .reduce((sum, row) => sum + row.unreadCount, 0)
  }

  /** #359 第五点：presence 广播范围。service 不消费它，这里只为满足接口（由 app.ts 用）。 */
  async listCounterpartUserIds(userId: string) {
    const ids = new Set<string>()
    for (const row of this.details.values()) {
      if (row.conversation.buyer_id === userId) ids.add(row.conversation.seller_id)
      if (row.conversation.seller_id === userId) ids.add(row.conversation.buyer_id)
    }
    return [...ids]
  }
}

describe('conversation service: createOrGetConversation', () => {
  test('creates a conversation and reports created=true', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const result = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(result.created).toBe(true)
    expect(result.conversation.role).toBe('buyer')
    expect(result.conversation.listing.coverUrl).toBe(`https://cdn.test/covers/${listingA}.jpg`)
  })

  /**
   * #359 第五点：会话 DTO 里的在线态取的是**对方**（这里 viewer = 买家，对方 = 卖家）的
   * 活动登记，且必须逐次读取（不是建会话那一刻的快照）——「对方刚下线」要能在下一次
   * 拉详情时如实体现在同一个 DTO 字段上。
   */
  test('counterpartPresence 取自对方的活动登记，且在每次读取时重算', async () => {
    const store = new MemoryConversationStore()
    const asked: string[] = []
    const service = createConversationService({
      blocks: neverBlocked,
      store,
      storage,
      presence: {
        presenceOf: (userId) => {
          asked.push(userId)
          return { online: true, lastActiveAt: null }
        },
      },
    })

    const created = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(created.conversation.counterpartPresence).toEqual({ online: true, lastActiveAt: null })
    // 问的是对方（卖家），不是查看者自己
    expect(asked).toEqual([seller])

    const detail = await service.getConversation(
      buyer,
      decodePublicId(PUBLIC_ID_PREFIX.conversation, created.conversation.id),
    )
    expect(detail.counterpartPresence).toEqual({ online: true, lastActiveAt: null })
    expect(asked).toEqual([seller, seller])
  })

  test('审核中的图（私有 listing-review-media 键）不作为会话封面签发直读 URL', async () => {
    const store = new MemoryConversationStore()
    const reviewKey = `listing-review-media/${encodePublicId(PUBLIC_ID_PREFIX.user, seller)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000d1')}.jpg`
    store.coverObjectKeys = async (listingIds) => new Map(listingIds.map((id) => [id, reviewKey]))
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })

    // #286 复审：任意登录用户只要能对一条 REVIEW 商品建会话，就会拿到无会话鉴权的直读 URL。
    const created = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(created.conversation.listing.coverUrl).toBeNull()
    const conversationId = decodePublicId(PUBLIC_ID_PREFIX.conversation, created.conversation.id)
    const detail = await service.getConversation(buyer, conversationId)
    expect(detail.listing.coverUrl).toBeNull()

    // 对照：公开前缀的封面照旧出图（不是把封面整体关掉）。
    store.coverObjectKeys = async (listingIds) =>
      new Map(listingIds.map((id) => [id, `covers/${id}.jpg`]))
    const after = await service.getConversation(buyer, conversationId)
    expect(after.listing.coverUrl).toBe(`https://cdn.test/covers/${listingA}.jpg`)
  })
  /*
   * #466 拉黑守卫（双向）：买家与卖家之间任一方向存在拉黑边，新建会话即被拦。
   * 中性码 CONVERSATION_UNAVAILABLE——不暴露「谁拉黑了谁」。
   */
  test('拉黑守卫：拉黑边存在 → 403 CONVERSATION_UNAVAILABLE（双方同码）', async () => {
    const service = createConversationService({
      blocks: { existsBlockBetween: async () => true },
      presence,
      store: new MemoryConversationStore(),
      storage,
    })
    await expect(
      service.createOrGetConversation(buyer, { listingId: listingA }),
    ).rejects.toMatchObject({ status: 403, code: 'CONVERSATION_UNAVAILABLE' })
  })

  test('守卫不误伤：无拉黑边时照常建会话', async () => {
    const service = createConversationService({
      blocks: neverBlocked,
      presence,
      store: new MemoryConversationStore(),
      storage,
    })
    const result = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(result.created).toBe(true)
  })

  test('reuses the existing conversation for the same (listing, buyer)', async () => {
    const service = createConversationService({
      blocks: neverBlocked,
      store: new MemoryConversationStore(),
      storage,
      presence,
    })
    const first = await service.createOrGetConversation(buyer, { listingId: listingA })
    const second = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(second.created).toBe(false)
    expect(second.conversation.id).toBe(first.conversation.id)
  })

  /*
   * 「查存在 → 建会话」不是原子的：#74 给商品加了物理删除，商品在这两步之间被删掉时，
   * `INSERT` 会撞 `conversations_listing_id_seller_id_fk`。那条路径的语义与「查不到」
   * 完全一样（商品不存在），所以必须是同一个 404 —— 不接住的话 23503 会走 `app.onError`
   * 变成 500，客户端只会说「服务器内部错误」。
   */
  test('商品在写入瞬间被删（外键冲突）→ 同一个 404，而不是 500', async () => {
    const store = new MemoryConversationStore()
    store.insertIfAbsent = async () => {
      // 真实驱动的形状：SQLSTATE 在 errno 上，Drizzle 再包一层 cause
      throw Object.assign(new Error('Failed query: insert into conversations …'), {
        query: 'insert into conversations …',
        params: [],
        cause: Object.assign(new Error('violates foreign key constraint'), { errno: '23503' }),
      })
    }
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })

    expect(service.createOrGetConversation(buyer, { listingId: listingA })).rejects.toMatchObject({
      code: 'LISTING_NOT_FOUND',
      status: 404,
    })
  })

  test('404 LISTING_NOT_FOUND for an unknown listing', async () => {
    const service = createConversationService({
      blocks: neverBlocked,
      store: new MemoryConversationStore(),
      storage,
      presence,
    })
    expect(
      service.createOrGetConversation(buyer, {
        listingId: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_FOUND', status: 404 })
  })

  test('409 CANNOT_CHAT_WITH_SELF when the caller is the seller', async () => {
    const service = createConversationService({
      blocks: neverBlocked,
      store: new MemoryConversationStore(),
      storage,
      presence,
    })
    expect(service.createOrGetConversation(seller, { listingId: listingA })).rejects.toMatchObject({
      code: 'CANNOT_CHAT_WITH_SELF',
      status: 409,
    })
  })
})

describe('conversation service: listConversations', () => {
  test('sellers see the same conversation with role=seller', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const created = await service.createOrGetConversation(buyer, { listingId: listingA })
    const listed = await service.listConversations(seller, { limit: 20 })
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.id).toBe(created.conversation.id)
    expect(listed.items[0]?.role).toBe('seller')
  })

  test('422 on an undecodable cursor', async () => {
    const service = createConversationService({
      blocks: neverBlocked,
      store: new MemoryConversationStore(),
      storage,
      presence,
    })
    expect(
      service.listConversations(buyer, { limit: 20, cursor: 'garbage!' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
  })

  test('pages using a cnv_ cursor while the store receives a UUID', async () => {
    const store = new MemoryConversationStore()
    const secondId = '01930000-0000-7000-8000-0000000000c2'
    store.details.set(conversationA, detailRow())
    store.details.set(
      secondId,
      detailRow({ conversation: { ...detailRow().conversation, id: secondId } }),
    )
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const first = await service.listConversations(buyer, { limit: 1 })
    expect(JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString()).id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.conversation, secondId),
    )
    const second = await service.listConversations(buyer, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationA),
    ])
  })

  test('nextCursor is null before the page overflows', async () => {
    const store = new MemoryConversationStore()
    await store.insertIfAbsent(listingA, buyer, seller)
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const listed = await service.listConversations(buyer, { limit: 20 })
    expect(listed.nextCursor).toBeNull()
  })
})

describe('conversation service: markRead', () => {
  test('resets unreadCount for the viewer', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const dto: ConversationDto = await service.markRead(
      buyer,
      decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id),
    )
    expect(dto.unreadCount).toBe(0)
  })

  test('pushes conversation.read with the reader id and the read time actually persisted', async () => {
    const store = new MemoryConversationStore()
    type ReadPush = {
      participants: { buyerId: string; sellerId: string }
      event: { conversationId: string; readerId: string; readAt: string }
    }
    const pushed: ReadPush[] = []
    const service = createConversationService({
      blocks: neverBlocked,
      store,
      storage,
      presence,
      onRead: (participants, event) => pushed.push({ participants, event }),
    })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const dto = await service.markRead(
      buyer,
      decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id),
    )

    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.participants).toEqual({ buyerId: buyer, sellerId: seller })
    expect(pushed[0]?.event.conversationId).toBe(
      decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id),
    )
    expect(pushed[0]?.event.readerId).toBe(buyer)
    // readAt 必须与落库那一侧完全一致：客户端按它比对「哪些消息已读」，
    // 服务端自己再取一次 now() 会漂在落库值之后，最近一条会被误判成未读。
    const persisted = store.details.get(
      decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id),
    )?.conversation.buyer_last_read_at
    if (typeof persisted !== 'string') throw new Error('buyer_last_read_at 应以 ISO 文本落库')
    expect(pushed[0]?.event.readAt).toBe(persisted)
    // 自己读的会话不会污染 DTO 里的「对方读位」
    expect(dto.counterpartLastReadAt).toBeNull()
  })

  test('counterpartLastReadAt is the other side, depending on who is viewing', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const row = store.details.get(decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id))
    if (!row) throw new Error('unreachable')
    row.conversation.buyer_last_read_at = '2026-09-12T10:00:00.000Z'
    row.conversation.seller_last_read_at = '2026-09-12T11:00:00.000Z'

    const internalId = decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id)
    expect((await service.getConversation(buyer, internalId)).counterpartLastReadAt).toBe(
      '2026-09-12T11:00:00.000Z',
    )
    expect((await service.getConversation(seller, internalId)).counterpartLastReadAt).toBe(
      '2026-09-12T10:00:00.000Z',
    )
  })

  test('404 for a non-participant, without broadcasting a read event', async () => {
    const store = new MemoryConversationStore()
    const pushed: unknown[] = []
    const service = createConversationService({
      blocks: neverBlocked,
      store,
      storage,
      presence,
      onRead: (_participants, event) => pushed.push(event),
    })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const outsider = '00000000-0000-4000-8000-0000000000a3'
    await expect(service.markRead(outsider, conversation.id)).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
    })
    // 非参与者不得推送：否则任何人都能靠猜会话 id 触发一次「已读」广播
    expect(pushed).toHaveLength(0)
  })
})

describe('conversation service: getUnreadCount', () => {
  test('returns the store aggregate for the viewer, not the first page', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({
      store,
      storage,
      presence,
      blocks: { existsBlockBetween: async () => false },
    })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const row = store.details.get(decodePublicId(PUBLIC_ID_PREFIX.conversation, conversation.id))
    if (!row) throw new Error('unreachable')
    row.unreadCount = 3

    expect(await service.getUnreadCount(buyer)).toEqual({ unreadCount: 3 })
    // 非参与者（不是任何会话的双方）不得把别人的未读算进来。
    expect(await service.getUnreadCount('00000000-0000-4000-8000-0000000000a3')).toEqual({
      unreadCount: 0,
    })
  })
})

describe('ConversationServiceError', () => {
  test('carries status and contract error code', () => {
    const error = new ConversationServiceError(404, 'CONVERSATION_NOT_FOUND', 'x')
    expect(error.status).toBe(404)
    expect(error.code).toBe('CONVERSATION_NOT_FOUND')
  })
})
