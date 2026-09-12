import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import type { MediaStorage } from '../uploads/storage'
import { ConversationServiceError, createConversationService } from './service'
import type { ConversationDetailRow, ConversationStore, ListingBrief } from './store'

const buyer = '00000000-0000-4000-8000-0000000000a1'
const seller = '00000000-0000-4000-8000-0000000000a2'
const listingA = '00000000-0000-4000-8000-0000000000b1'
const conversationA = '00000000-0000-4000-8000-0000000000c1'

const storage: MediaStorage = {
  presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
  stat: async () => null,
  publicUrl: (key) => `https://cdn.test/${key}`,
}

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

  async insertIfAbsent(listingId: string, buyerId: string, sellerId: string) {
    const existing = [...this.details.values()].find(
      (row) => row.conversation.listing_id === listingId && row.conversation.buyer_id === buyerId,
    )
    if (existing) return null
    const id = `00000000-0000-4000-8000-${String(this.details.size + 1).padStart(12, '0')}`
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
    return row
  }
}

describe('conversation service: createOrGetConversation', () => {
  test('creates a conversation and reports created=true', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({ store, storage })
    const result = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(result.created).toBe(true)
    expect(result.conversation.role).toBe('buyer')
    expect(result.conversation.listing.coverUrl).toBe(`https://cdn.test/covers/${listingA}.jpg`)
  })

  test('reuses the existing conversation for the same (listing, buyer)', async () => {
    const service = createConversationService({ store: new MemoryConversationStore(), storage })
    const first = await service.createOrGetConversation(buyer, { listingId: listingA })
    const second = await service.createOrGetConversation(buyer, { listingId: listingA })
    expect(second.created).toBe(false)
    expect(second.conversation.id).toBe(first.conversation.id)
  })

  test('404 LISTING_NOT_FOUND for an unknown listing', async () => {
    const service = createConversationService({ store: new MemoryConversationStore(), storage })
    expect(
      service.createOrGetConversation(buyer, {
        listingId: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_FOUND', status: 404 })
  })

  test('409 CANNOT_CHAT_WITH_SELF when the caller is the seller', async () => {
    const service = createConversationService({ store: new MemoryConversationStore(), storage })
    expect(service.createOrGetConversation(seller, { listingId: listingA })).rejects.toMatchObject({
      code: 'CANNOT_CHAT_WITH_SELF',
      status: 409,
    })
  })
})

describe('conversation service: listConversations', () => {
  test('sellers see the same conversation with role=seller', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({ store, storage })
    const created = await service.createOrGetConversation(buyer, { listingId: listingA })
    const listed = await service.listConversations(seller, { limit: 20 })
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.id).toBe(created.conversation.id)
    expect(listed.items[0]?.role).toBe('seller')
  })

  test('422 on an undecodable cursor', async () => {
    const service = createConversationService({ store: new MemoryConversationStore(), storage })
    expect(
      service.listConversations(buyer, { limit: 20, cursor: 'garbage!' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
  })

  test('nextCursor is null before the page overflows', async () => {
    const store = new MemoryConversationStore()
    await store.insertIfAbsent(listingA, buyer, seller)
    const service = createConversationService({ store, storage })
    const listed = await service.listConversations(buyer, { limit: 20 })
    expect(listed.nextCursor).toBeNull()
  })
})

describe('conversation service: markRead', () => {
  test('resets unreadCount for the viewer', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({ store, storage })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const dto: ConversationDto = await service.markRead(buyer, conversation.id)
    expect(dto.unreadCount).toBe(0)
  })

  test('404 for a non-participant', async () => {
    const store = new MemoryConversationStore()
    const service = createConversationService({ store, storage })
    const { conversation } = await service.createOrGetConversation(buyer, { listingId: listingA })
    const outsider = '00000000-0000-4000-8000-0000000000a3'
    expect(service.markRead(outsider, conversation.id)).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
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
