import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  acceptTransaction,
  fetchTransaction,
  listingActionError,
  myListingsPath,
  profileUpdateErrorView,
  proposalDecisionError,
  rejectProposal,
  transactionActionError,
  transactionsPath,
  updateListing,
} from './api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const CONVERSATION_ID = 'cnv_01jc000000e00800000000001a'
const LISTING_ID = 'lst_01jc000000e00800000000000t'

function transactionFixture() {
  return {
    id: 'txn_01jc000000e00800000000004t',
    conversationId: CONVERSATION_ID,
    listingId: LISTING_ID,
    buyerId: 'usr_01jc000000e00800000000000b',
    sellerId: 'usr_01jc000000e00800000000000a',
    role: 'seller',
    listing: {
      id: LISTING_ID,
      title: '九成新自行车',
      priceCents: 12000,
      status: 'RESERVED',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    amountCents: 11000,
    status: 'PENDING_MEETUP',
    buyerConfirmedAt: null,
    sellerConfirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('profile api paths', () => {
  test('my listings always scope by seller and keep optional filters opaque', () => {
    expect(myListingsPath('seller-1')).toBe('/listings?sellerId=seller-1&limit=50')
    expect(myListingsPath('seller-1', 'OFFLINE')).toBe(
      '/listings?sellerId=seller-1&limit=50&status=OFFLINE',
    )
    expect(myListingsPath('seller-1', 'ALL', 'abc+/=')).toBe(
      '/listings?sellerId=seller-1&limit=50&cursor=abc%2B%2F%3D',
    )
  })

  test('listing edit sends PATCH /listings/:id', async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      return Response.json({
        id: 'lst_01jc000000e00800000000000t',
        title: '新标题',
        description: '新描述',
        priceCents: 1234,
        category: 'BOOKS',
        condition: 'LIKE_NEW',
        status: 'ACTIVE',
        urgent: false,
        negotiable: false,
        free: false,
        coverUrl: null,
        createdAt: '2026-09-27T00:00:00.000Z',
        updatedAt: '2026-09-27T00:00:00.000Z',
        moderationStatus: 'APPROVED',
        images: [],
        seller: {
          id: 'usr_01jc000000e00800000000000a',
          nickname: '卖家',
          avatarUrl: null,
          authStatus: 'UNVERIFIED',
        },
        isOwner: true,
      })
    }) as unknown as typeof fetch

    await updateListing('lst_01jc000000e00800000000000t', {
      title: '新标题',
      description: '新描述',
      priceCents: 1234,
    })

    expect(calls).toEqual([
      {
        url: '/api/listings/lst_01jc000000e00800000000000t',
        method: 'PATCH',
        body: JSON.stringify({ title: '新标题', description: '新描述', priceCents: 1234 }),
      },
    ])
  })

  test('transaction list sends role and status only when selected', () => {
    expect(transactionsPath({ role: 'buyer' })).toBe('/transactions?limit=50&role=buyer')
    expect(transactionsPath({ role: 'seller', status: 'PENDING_MEETUP' })).toBe(
      '/transactions?limit=50&role=seller&status=PENDING_MEETUP',
    )
    expect(transactionsPath({ role: 'seller', status: 'ALL', cursor: 'next' })).toBe(
      '/transactions?limit=50&role=seller&cursor=next',
    )
  })
})

describe('profile api errors', () => {
  test('transaction 404 becomes a readable empty state', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'TRANSACTION_NOT_FOUND', message: '交易不存在或无权访问' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch

    await expect(fetchTransaction('tx-1')).resolves.toBeNull()
  })

  test('listing and transaction state races require a refresh', () => {
    expect(listingActionError(new ApiError('LISTING_NOT_EDITABLE', 409, '状态变化'))).toEqual({
      message: '商品状态已变化，正在刷新最新状态',
      refresh: true,
    })
    expect(
      transactionActionError(new ApiError('TRANSACTION_NOT_IN_PENDING', 409, '状态变化')),
    ).toEqual({
      message: '订单状态已变化，正在刷新最新状态',
      refresh: true,
    })
  })

  test('profile validation details map to the visible fields', () => {
    const view = profileUpdateErrorView(
      new ApiError('VALIDATION_FAILED', 422, '请求参数不合法', [
        { field: 'nickname', message: '昵称过长' },
        { field: 'objectKey', message: '头像对象无效' },
      ]),
    )
    expect(view.message).toBe('请求参数不合法')
    expect(view.fields).toEqual({ nickname: '昵称过长', avatarObjectKey: '头像对象无效' })
  })
})

describe('proposal decisions', () => {
  test('accept posts the conversation and the amount carried by the proposal', async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      return Response.json(transactionFixture(), { status: 201 })
    }) as unknown as typeof fetch

    const transaction = await acceptTransaction(CONVERSATION_ID, 11000)

    // 提案不落库，服务端无处可读金额，所以接受请求必须由端上重传
    expect(calls).toEqual([
      {
        url: '/api/transactions',
        method: 'POST',
        body: JSON.stringify({ conversationId: CONVERSATION_ID, amountCents: 11000 }),
      },
    ])
    expect(transaction.id).toBe('txn_01jc000000e00800000000004t')
  })

  test('reject posts only the conversation and returns the system message', async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      return Response.json({
        id: 'msg_01jc000000e00800000000001t',
        conversationId: CONVERSATION_ID,
        senderId: null,
        sender: null,
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.rejected' }),
        createdAt: '2026-01-02T00:00:00.000Z',
      })
    }) as unknown as typeof fetch

    const message = await rejectProposal(CONVERSATION_ID)

    expect(calls).toEqual([
      {
        url: '/api/transactions/proposals/reject',
        method: 'POST',
        body: JSON.stringify({ conversationId: CONVERSATION_ID }),
      },
    ])
    expect(message.type).toBe('SYSTEM')
  })

  test('never reads LISTING_NOT_ACTIVE as "the decision failed"', () => {
    // 契约明确该码在重试场景下也可能意味着交易已创建：只能刷新后由服务端状态定论
    const view = proposalDecisionError(new ApiError('LISTING_NOT_ACTIVE', 409, '商品非在售'))
    expect(view.refresh).toBe(true)
    expect(view.message).not.toContain('失败')
  })

  test('maps the remaining decision errors', () => {
    expect(proposalDecisionError(new ApiError('NOT_CONVERSATION_SELLER', 403, '不是卖家'))).toEqual(
      {
        message: '只有卖家可以处理这笔申请',
        refresh: false,
      },
    )
    expect(proposalDecisionError(new Error('network'))).toEqual({
      message: '操作失败，请重试',
      refresh: false,
    })
  })
})
