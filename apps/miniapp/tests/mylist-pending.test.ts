import { describe, expect, test } from 'bun:test'
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import { lastTxSignalOf, loadPendingIndex } from '../src/pages/mylist/pending'

/**
 * 「我的发布 · 待确认」的推导：谁在等我点头。
 *
 * 这条链路唯一的依据是**卖家侧会话里最后一个交易事件**：买家点「我想要」只写一条
 * `tx.proposal` SYSTEM 消息、不动商品状态，所以商品读模型里看不出「有人在等」。
 * 这里锁三件事：
 *
 * 1. 只看卖家视角、只看自己名下的商品；
 * 2. 「最后一个交易事件」不是「最后一条消息」—— 买家提案后卖家先回了句话，
 *    申请仍在等点头，这时不能判成「没有提案」；
 * 3. 推导不完整 / 读不到时 `complete` / `failed` 必须如实置位 —— 页面靠它收起
 *    分段计数，否则「有买家在等的商品被算进在售」会被当成事实显示出来。
 */

const LISTING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_LISTING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function conversation(over: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'c1',
    listingId: LISTING,
    role: 'seller',
    listing: {
      id: LISTING,
      title: '罗技 M590',
      priceCents: 6900,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'u-buyer', nickname: '林知遥', avatarUrl: null },
    unreadCount: 0,
    counterpartLastReadAt: null,
    lastMessage: null,
    lastMessageAt: '2026-09-24T08:00:00.000Z',
    createdAt: '2026-09-24T08:00:00.000Z',
    ...over,
  }
}

function systemMessage(content: string, createdAt = '2026-09-24T08:00:00.000Z'): MessageDto {
  return {
    id: `m-${createdAt}-${content.length}`,
    conversationId: 'c1',
    senderId: null,
    sender: null,
    type: 'SYSTEM',
    content,
    createdAt,
  }
}

function textMessage(content: string, createdAt = '2026-09-24T08:30:00.000Z'): MessageDto {
  return {
    id: `t-${createdAt}`,
    conversationId: 'c1',
    senderId: 'u-buyer',
    sender: { id: 'u-buyer', nickname: '林知遥', avatarUrl: null },
    type: 'TEXT',
    content,
    createdAt,
  }
}

const proposal = JSON.stringify({ type: 'tx.proposal', amountCents: 6000 })

/** 一页读完的会话列表 + 一个按会话 id 给消息页的假实现 */
const pages =
  (items: ConversationDto[], nextCursor: string | null = null) =>
  () =>
    Promise.resolve({ items, nextCursor })

describe('lastTxSignalOf —— 取最后一个交易事件，不是最后一条消息', () => {
  test('提案之后卖家回了句话：申请仍在等，依然取到 tx.proposal', () => {
    const signal = lastTxSignalOf([systemMessage(proposal), textMessage('包邮吗？')])
    expect(signal?.event).toEqual({ type: 'tx.proposal', amountCents: 6000 })
    // 时间基准是**提案那条**消息（「等了多久」从买家点想要算起，不是从最后一条消息算）
    expect(signal?.createdAt).toBe('2026-09-24T08:00:00.000Z')
  })

  test('提案之后卖家拒绝了：最后一个事件是 tx.rejected，不再是待确认', () => {
    const signal = lastTxSignalOf([
      systemMessage(proposal),
      systemMessage(JSON.stringify({ type: 'tx.rejected' }), '2026-09-24T09:00:00.000Z'),
    ])
    expect(signal?.event.type).toBe('tx.rejected')
  })

  test('非 JSON 的系统消息（认证通知）与普通文本都被忽略', () => {
    expect(lastTxSignalOf([systemMessage('你的学号认证已通过'), textMessage('在吗')])).toBeNull()
  })
})

describe('loadPendingIndex —— 卖家侧会话', () => {
  test('买家视角的会话与别人商品的会话都不进索引', async () => {
    const index = await loadPendingIndex(
      new Set([LISTING]),
      pages([
        conversation({ id: 'c-buyer-role', role: 'buyer', lastMessage: null }),
        conversation({
          id: 'c-other',
          listingId: OTHER_LISTING,
          lastMessage: {
            type: 'SYSTEM',
            content: proposal,
            senderId: null,
            createdAt: '2026-09-24T08:00:00.000Z',
          },
        }),
      ]),
      () => Promise.reject(new Error('不该被调用')),
    )
    expect(index.proposals.size).toBe(0)
    expect(index.conversationIds.size).toBe(0)
    expect(index.complete).toBe(true)
    expect(index.failed).toBe(false)
  })

  test('最后一条就是 tx.proposal：直接得出提案，不额外拉消息页', async () => {
    let messageCalls = 0
    const index = await loadPendingIndex(
      new Set([LISTING]),
      pages([
        conversation({
          lastMessage: {
            type: 'SYSTEM',
            content: proposal,
            senderId: null,
            createdAt: '2026-09-24T08:00:00.000Z',
          },
        }),
      ]),
      () => {
        messageCalls += 1
        return Promise.resolve({ items: [], nextCursor: null })
      },
    )
    expect(messageCalls).toBe(0)
    expect(index.proposals.get(LISTING)).toEqual({
      conversationId: 'c1',
      buyerName: '林知遥',
      amountCents: 6000,
      createdAt: '2026-09-24T08:00:00.000Z',
    })
  })

  test('最后一条是普通文本：拉消息页找最后一个交易事件（提案仍在等）', async () => {
    let fetched: string | null = null
    const index = await loadPendingIndex(
      new Set([LISTING]),
      pages([
        conversation({
          lastMessage: {
            type: 'TEXT',
            content: '包邮吗？',
            senderId: 'u-buyer',
            createdAt: '2026-09-24T08:30:00.000Z',
          },
        }),
      ]),
      (conversationId) => {
        fetched = conversationId
        return Promise.resolve({
          items: [systemMessage(proposal), textMessage('包邮吗？')],
          nextCursor: null,
        })
      },
    )
    expect(fetched).toBe('c1')
    expect(index.proposals.get(LISTING)?.amountCents).toBe(6000)
  })

  test('最后一条是**非交易** SYSTEM 消息：同样要拉消息页，不能就此断定「没人等」', async () => {
    /*
     * seed 里就有这种消息（`packages/db/src/seed.ts` 的「买家发起了交易确认。」），
     * 真实链路也会有别的 SYSTEM 文案。它上面可能压着一条更早的 `tx.proposal` ——
     * 若把它当成「没有提案」，卖家就看不到有人在等，也拿不到同意 / 拒绝。
     * 与 TEXT 同一条路：交给消息页去判。
     */
    let fetched = 0
    const index = await loadPendingIndex(
      new Set([LISTING]),
      pages([
        conversation({
          lastMessage: {
            type: 'SYSTEM',
            content: '买家发起了交易确认。',
            senderId: null,
            createdAt: '2026-09-24T08:30:00.000Z',
          },
        }),
      ]),
      () => {
        fetched += 1
        return Promise.resolve({ items: [systemMessage(proposal)], nextCursor: null })
      },
    )
    expect(fetched).toBe(1)
    expect(index.proposals.get(LISTING)?.amountCents).toBe(6000)
  })

  test('上限管的是消息页请求数，不是会话条数：短路命中的会话再多也不算不完整', async () => {
    /*
     * 15 条会话（> MAX_PROPOSAL_SCANS = 12）全都以 `tx.rejected` 结尾 —— 命中 lastMessage
     * 短路，一次消息页都不用拉，推导是完整的。若按会话条数判上限，这里会错报
     * `complete: false`，页面上整排分段计数与「已经到底了」会因此消失。
     */
    let messageCalls = 0
    const many = Array.from({ length: 15 }, (_, i) =>
      conversation({
        id: `c${i}`,
        listingId: `listing-${i}`,
        lastMessage: {
          type: 'SYSTEM',
          content: JSON.stringify({ type: 'tx.rejected' }),
          senderId: null,
          createdAt: '2026-09-24T08:00:00.000Z',
        },
      }),
    )
    const index = await loadPendingIndex(new Set(many.map((c) => c.listingId)), pages(many), () => {
      messageCalls += 1
      return Promise.resolve({ items: [], nextCursor: null })
    })
    expect(messageCalls).toBe(0)
    expect(index.complete).toBe(true)
  })

  test('需要拉消息页的会话超过上限：那才是真的不完整', async () => {
    // 15 条会话最后一条都是普通文本 → 每条都要拉消息页，第 13 条起放弃 → 不完整
    let messageCalls = 0
    const many = Array.from({ length: 15 }, (_, i) =>
      conversation({
        id: `c${i}`,
        listingId: `listing-${i}`,
        lastMessage: {
          type: 'TEXT',
          content: '在吗',
          senderId: 'u-buyer',
          createdAt: '2026-09-24T08:30:00.000Z',
        },
      }),
    )
    const index = await loadPendingIndex(new Set(many.map((c) => c.listingId)), pages(many), () => {
      messageCalls += 1
      return Promise.resolve({ items: [], nextCursor: null })
    })
    expect(messageCalls).toBe(12)
    expect(index.complete).toBe(false)
  })

  test('最后一个交易事件是已接受：这条会话不算待确认，但仍记下会话 id', async () => {
    const index = await loadPendingIndex(
      new Set([LISTING]),
      pages([
        conversation({
          lastMessage: {
            type: 'SYSTEM',
            content: JSON.stringify({
              type: 'tx.accepted',
              transactionId: 't1',
              amountCents: 6000,
            }),
            senderId: null,
            createdAt: '2026-09-24T08:00:00.000Z',
          },
        }),
      ]),
      () => Promise.reject(new Error('不该被调用')),
    )
    expect(index.proposals.size).toBe(0)
    expect(index.conversationIds.get(LISTING)).toBe('c1')
  })

  test('会话列表拉不到：failed 为 true、complete 为 false，且不抛错', async () => {
    const index = await loadPendingIndex(
      new Set([LISTING]),
      () => Promise.reject(new Error('网络炸了')),
      () => Promise.reject(new Error('不该被调用')),
    )
    expect(index.failed).toBe(true)
    expect(index.complete).toBe(false)
    expect(index.proposals.size).toBe(0)
  })

  test('单条会话的消息读不到：complete 置 false（不把「读不到」当「没有申请」）', async () => {
    const index = await loadPendingIndex(
      new Set([LISTING]),
      pages([
        conversation({
          lastMessage: {
            type: 'TEXT',
            content: '在吗',
            senderId: 'u-buyer',
            createdAt: '2026-09-24T08:30:00.000Z',
          },
        }),
      ]),
      () => Promise.reject(new Error('这条会话挂了')),
    )
    expect(index.complete).toBe(false)
    expect(index.failed).toBe(false)
  })

  test('翻到页数上限还没见底：complete 置 false', async () => {
    // 每页都回同一个游标 → 服务端在重复给同一页，必须停下并自报不完整
    const index = await loadPendingIndex(
      new Set([LISTING]),
      () => Promise.resolve({ items: [], nextCursor: 'same' }),
      () => Promise.reject(new Error('不该被调用')),
    )
    expect(index.complete).toBe(false)
  })
})
