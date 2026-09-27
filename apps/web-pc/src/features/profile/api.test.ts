import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  fetchTransaction,
  listingActionError,
  myListingsPath,
  profileUpdateErrorView,
  transactionActionError,
  transactionsPath,
  updateListing,
} from './api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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
        id: '01930000-0000-7000-8000-000000000001',
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
          id: '01930000-0000-7000-8000-00000000000a',
          nickname: '卖家',
          avatarUrl: null,
          authStatus: 'UNVERIFIED',
        },
        isOwner: true,
      })
    }) as unknown as typeof fetch

    await updateListing('01930000-0000-7000-8000-000000000001', {
      title: '新标题',
      description: '新描述',
      priceCents: 1234,
    })

    expect(calls).toEqual([
      {
        url: '/api/listings/01930000-0000-7000-8000-000000000001',
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
