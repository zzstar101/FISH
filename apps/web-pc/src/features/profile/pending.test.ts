import { describe, expect, test } from 'bun:test'
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import type { ConversationId, ListingId, MessageId, UserId } from '@fish/contracts/system/public-id'
import { lastTxSignalOf, loadPendingIndex } from './pending'

/*
 * `loadPendingIndex` 是纯推导：入参是已经过 schema 的 DTO，内部只按字段取值。
 * id 仍用契约的 branded 前缀（`lst_` / `cnv_` / `usr_` / `msg_`）——类型本身就是
 * 对这些前缀的约束，绕开它只会让测试与实际调用面不一致。
 */
const OWN_LISTING: ListingId = 'lst_own'
const OTHER_LISTING: ListingId = 'lst_other'
const BUYER: UserId = 'usr_buyer'

type MessagePage = { items: MessageDto[]; nextCursor: string | null }
type ConversationPage = { items: ConversationDto[]; nextCursor: string | null }

function lastMessage(
  content: unknown,
  type: 'SYSTEM' | 'TEXT' = 'SYSTEM',
): ConversationDto['lastMessage'] {
  return {
    type,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    senderId: type === 'TEXT' ? BUYER : null,
    createdAt: '2026-01-02T00:00:00.000Z',
  }
}

function conversation(over: {
  id: ConversationId
  listingId?: ListingId
  role?: 'buyer' | 'seller'
  buyerName?: string
  lastMessage?: ConversationDto['lastMessage']
}): ConversationDto {
  const listingId = over.listingId ?? OWN_LISTING
  return {
    id: over.id,
    listingId,
    role: over.role ?? 'seller',
    listing: {
      id: listingId,
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: {
      id: BUYER,
      nickname: over.buyerName ?? '小林',
      avatarUrl: null,
    },
    unreadCount: 0,
    counterpartLastReadAt: null,
    // 在线态（#359 第五点）在契约里是必填兄弟字段：本用例不关心，给「离线」这一档。
    counterpartPresence: { online: false, lastActiveAt: null },
    lastMessage: over.lastMessage ?? lastMessage({ type: 'tx.proposal', amountCents: 11000 }),
    lastMessageAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

let messageSeq = 0

function systemMessage(
  conversationId: ConversationId,
  content: unknown,
  createdAt: string,
): MessageDto {
  messageSeq += 1
  const id: MessageId = `msg_${messageSeq}`
  return {
    id,
    conversationId,
    // SYSTEM 消息没有发送者：sender 与 senderId 同时为 null 才是契约允许的形状
    senderId: null,
    sender: null,
    type: 'SYSTEM',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    createdAt,
    // #359 3c 起契约必填：SYSTEM 消息既不可撤回也不带引用。
    recalledAt: null,
    replyTo: null,
  }
}

function singlePage(items: ConversationDto[]): () => Promise<ConversationPage> {
  return async () => ({ items, nextCursor: null })
}

function messagePages(
  byConversation: Record<string, MessageDto[]>,
): (id: ConversationId) => Promise<MessagePage> {
  return async (conversationId) => {
    const items = byConversation[conversationId]
    if (!items) throw new Error(`no such conversation ${conversationId}`)
    return { items, nextCursor: null }
  }
}

const OWN_LISTINGS = new Map<ListingId, ListingStatus>([[OWN_LISTING, 'ACTIVE']])

describe('lastTxSignalOf', () => {
  test('returns the last transaction event, not the last message', () => {
    const signal = lastTxSignalOf([
      systemMessage('cnv_1', { type: 'tx.proposal', amountCents: 900 }, '2026-01-02T00:00:00.000Z'),
      systemMessage('cnv_1', { type: 'tx.rejected' }, '2026-01-02T02:00:00.000Z'),
    ])
    expect(signal?.event.type).toBe('tx.rejected')
  })

  test('ignores non-transaction system text and malformed JSON', () => {
    expect(
      lastTxSignalOf([systemMessage('cnv_1', '你的校园认证已通过', '2026-01-02T00:00:00.000Z')]),
    ).toBeNull()
    expect(
      lastTxSignalOf([systemMessage('cnv_1', '{not json', '2026-01-02T00:00:00.000Z')]),
    ).toBeNull()
  })
})

describe('loadPendingIndex', () => {
  test('records a proposal straight from the conversation summary without reading messages', async () => {
    let messageRequests = 0
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      singlePage([conversation({ id: 'cnv_1', buyerName: '小林' })]),
      async () => {
        messageRequests += 1
        return { items: [], nextCursor: null }
      },
    )

    expect(index.failed).toBe(false)
    expect(index.complete).toBe(true)
    expect(messageRequests).toBe(0)
    expect(index.proposals.get(OWN_LISTING)).toEqual({
      conversationId: 'cnv_1',
      buyerName: '小林',
      amountCents: 11000,
      createdAt: '2026-01-02T00:00:00.000Z',
      listingStatus: 'ACTIVE',
    })
  })

  test('reads the message page when the last summary is not a transaction event', async () => {
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      singlePage([conversation({ id: 'cnv_1', lastMessage: lastMessage('在的', 'TEXT') })]),
      messagePages({
        cnv_1: [
          systemMessage(
            'cnv_1',
            { type: 'tx.proposal', amountCents: 9500 },
            '2026-01-02T00:30:00.000Z',
          ),
          systemMessage('cnv_1', { type: 'tx.rejected' }, '2026-01-02T03:00:00.000Z'),
        ],
      }),
    )
    // 最后一个交易事件是 tx.rejected：这件商品没有在等的提案
    expect(index.proposals.size).toBe(0)
    expect(index.complete).toBe(true)
  })

  test('ignores buyer-side conversations and listings that are not mine', async () => {
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      singlePage([
        conversation({ id: 'cnv_1', role: 'buyer' }),
        conversation({ id: 'cnv_2', listingId: OTHER_LISTING }),
      ]),
      messagePages({}),
    )
    expect(index.proposals.size).toBe(0)
    expect(index.failed).toBe(false)
  })

  test('a rejection in one conversation does not hide another buyer still waiting', async () => {
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      singlePage([
        conversation({
          id: 'cnv_new',
          lastMessage: lastMessage('在的', 'TEXT'),
          buyerName: '已谈崩的买家',
        }),
        conversation({ id: 'cnv_old', buyerName: '还在等的买家' }),
      ]),
      messagePages({
        // 最新那条会话以 tx.rejected 收尾，但另一条会话的 tx.proposal 仍在等卖家点头
        cnv_new: [systemMessage('cnv_new', { type: 'tx.rejected' }, '2026-01-02T04:00:00.000Z')],
      }),
    )
    expect(index.proposals.get(OWN_LISTING)).toEqual({
      conversationId: 'cnv_old',
      buyerName: '还在等的买家',
      amountCents: 11000,
      createdAt: '2026-01-02T00:00:00.000Z',
      listingStatus: 'ACTIVE',
    })
  })

  test('keeps an offline listing whose proposal can still be rejected, drops locked ones', async () => {
    /*
     * 服务端不对称：accept 要求商品是 ACTIVE（否则 409 LISTING_NOT_ACTIVE），
     * 而 reject 只校验「会话存在 + 调用者是卖家」，不看商品状态。
     * 所以已下架的商品要保留（卖家下架后仍能拒绝那条申请），
     * 而 RESERVED / SOLD（已被别人锁走或已售）一律排除。
     */
    const offline: ListingId = 'lst_offline'
    const reserved: ListingId = 'lst_reserved'
    const sold: ListingId = 'lst_sold'
    const listings = new Map<ListingId, ListingStatus>([
      [offline, 'OFFLINE'],
      [reserved, 'RESERVED'],
      [sold, 'SOLD'],
    ])

    const index = await loadPendingIndex(
      listings,
      singlePage([
        conversation({ id: 'cnv_offline', listingId: offline }),
        conversation({ id: 'cnv_reserved', listingId: reserved }),
        conversation({ id: 'cnv_sold', listingId: sold }),
      ]),
      messagePages({}),
    )

    expect([...index.proposals.keys()]).toEqual([offline])
    expect(index.proposals.get(offline)?.listingStatus).toBe('OFFLINE')
  })

  test('marks the derivation incomplete when the cursor stops advancing', async () => {
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      async () => ({ items: [conversation({ id: 'cnv_1' })], nextCursor: 'stuck' }),
      messagePages({}),
    )
    expect(index.complete).toBe(false)
    expect(index.failed).toBe(false)
  })

  test('never invents a proposal for a conversation whose messages cannot be read', async () => {
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      singlePage([conversation({ id: 'cnv_1', lastMessage: lastMessage('在的', 'TEXT') })]),
      async () => {
        throw new Error('network')
      },
    )
    expect(index.proposals.size).toBe(0)
    expect(index.complete).toBe(false)
    expect(index.failed).toBe(false)
  })

  test('reports a whole-round failure instead of pretending nothing is waiting', async () => {
    const index = await loadPendingIndex(
      OWN_LISTINGS,
      async () => {
        throw new Error('network')
      },
      messagePages({}),
    )
    expect(index.failed).toBe(true)
    expect(index.complete).toBe(false)
  })

  test('spends the scan budget on message-page requests, not on conversations', async () => {
    // 12 条靠会话摘要短路，第 13 条才需要拉消息页：预算按真实请求计，
    // 不该被零成本的短路会话挤掉（否则「已经到底了」会整排消失）。
    const shortCircuits = Array.from({ length: 12 }, (_, i) =>
      conversation({ id: `cnv_${i}`, listingId: `lst_${i}` }),
    )
    const needsScan = conversation({
      id: 'cnv_13',
      listingId: 'lst_13',
      lastMessage: lastMessage('在的', 'TEXT'),
    })
    const listings = new Map<ListingId, ListingStatus>([
      ...shortCircuits.map((item) => [item.listingId, 'ACTIVE'] as const),
      [needsScan.listingId, 'ACTIVE'] as const,
    ])

    let scans = 0
    const index = await loadPendingIndex(
      listings,
      singlePage([...shortCircuits, needsScan]),
      async (id) => {
        scans += 1
        return {
          items: [
            systemMessage(
              id,
              { type: 'tx.proposal', amountCents: 100 },
              '2026-01-02T05:00:00.000Z',
            ),
          ],
          nextCursor: null,
        }
      },
    )

    expect(scans).toBe(1)
    expect(index.complete).toBe(true)
    expect(index.proposals.get('lst_13')?.amountCents).toBe(100)
    expect(index.proposals.size).toBe(13)
  })
})
