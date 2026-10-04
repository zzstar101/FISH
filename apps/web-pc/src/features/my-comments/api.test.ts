import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fetchMyComments, myCommentsPath } from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const listingId = 'lst_01jc000000e00800000000000k'
const commentId = 'cmt_01jc000000e00800000000000k'
const reviewId = 'rvw_01jc000000e00800000000004t'
const transactionId = 'txn_01jc000000e00800000000000k'

function listingCardFixture() {
  return {
    id: listingId,
    title: '高等数学上册',
    priceCents: 2000,
    category: 'BOOKS',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    // 想要数（已建会话的买家数）：卡片契约的必填字段，夹具给 0。
    wants: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    moderationStatus: null,
  }
}

function transactionDtoFixture() {
  return {
    id: transactionId,
    conversationId: 'cnv_01jc000000e00800000000000k',
    listingId,
    buyerId: 'usr_01jc000000e00800000000000b',
    sellerId: 'usr_01jc000000e00800000000000a',
    role: 'seller',
    listing: {
      id: listingId,
      title: '高等数学上册',
      priceCents: 2000,
      status: 'SOLD',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    amountCents: 1800,
    status: 'COMPLETED',
    buyerConfirmedAt: '2026-02-01T00:00:00.000Z',
    sellerConfirmedAt: '2026-02-01T00:00:00.000Z',
    completedAt: '2026-02-01T00:00:00.000Z',
    cancelledAt: null,
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  }
}

describe('myCommentsPath', () => {
  test('恒带 kind 与 limit，cursor 缺省不带', () => {
    expect(myCommentsPath({ limit: 20, kind: 'comment' })).toBe(
      '/me/comments?kind=comment&limit=20',
    )
    expect(myCommentsPath({ limit: 20, kind: 'review' })).toBe('/me/comments?kind=review&limit=20')
  })

  test('翻页时把上一页的 nextCursor 原样带上', () => {
    expect(myCommentsPath({ limit: 20, kind: 'all', cursor: 'abc+/=' })).toBe(
      '/me/comments?kind=all&limit=20&cursor=abc%2B%2F%3D',
    )
  })
})

describe('fetchMyComments', () => {
  test('GET /me/comments 并用契约收口判别联合响应', async () => {
    const calls: Array<{ url: string }> = []
    // Bun 的 `fetch` 类型带 `preconnect` 等静态属性，`mock()` 造不出，按仓内惯例收口。
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).href
      calls.push({ url })
      return Response.json({
        items: [
          {
            comment: {
              id: commentId,
              listingId,
              parentId: null,
              content: '还在吗？想收',
              createdAt: '2026-03-01T00:00:00.000Z',
            },
            listing: listingCardFixture(),
          },
          {
            review: {
              id: reviewId,
              transactionId,
              rating: 'POSITIVE',
              body: '卖家很爽快',
              images: [],
              createdAt: '2026-03-02T00:00:00.000Z',
            },
            transaction: transactionDtoFixture(),
          },
        ],
        nextCursor: null,
        total: 2,
      })
    }) as unknown as typeof fetch

    const response = await fetchMyComments({ limit: 20, kind: 'all' })
    expect(calls[0]?.url).toBe('/api/me/comments?kind=all&limit=20')
    expect(response.total).toBe(2)
    expect(response.nextCursor).toBeNull()
    expect(response.items).toHaveLength(2)
    const [commentRow, reviewRow] = response.items
    expect(commentRow && 'comment' in commentRow ? commentRow.comment.id : null).toBe(commentId)
    expect(reviewRow && 'review' in reviewRow ? reviewRow.review.rating : null).toBe('POSITIVE')
  })
})
