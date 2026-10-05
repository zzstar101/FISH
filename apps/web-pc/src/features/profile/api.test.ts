import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  acceptTransaction,
  deleteListing,
  fetchMeetupTokenStatus,
  fetchTransaction,
  issueMeetupToken,
  listingActionError,
  listingDeleteError,
  myListingsPath,
  profileUpdateErrorView,
  proposalDecisionError,
  redeemMeetupToken,
  rejectProposal,
  reviewSubmitError,
  transactionActionError,
  transactionsPath,
  updateListing,
  verifyMeetupCode,
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
        // 想要数（已建会话的买家数）：卡片契约的必填字段，夹具给 0。
        wants: 0,
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

  test('listing delete sends DELETE /listings/:id and tolerates the 204', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      // 删除成功是 204 无响应体：解析路径必须容得下空 body。
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await expect(deleteListing(LISTING_ID)).resolves.toBeUndefined()

    expect(calls).toEqual([{ url: `/api/listings/${LISTING_ID}`, method: 'DELETE' }])
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

  test('delete failures surface the server wording and never claim success', () => {
    // 文案一律用服务端原文（验收标准要求 403 / 404 / 409 都透传），端上不改写
    expect(
      listingDeleteError(
        new ApiError('LISTING_NOT_DELETABLE', 409, '只有未通过审核且没有交易记录的商品可以删除'),
      ),
    ).toEqual({ message: '只有未通过审核且没有交易记录的商品可以删除', refresh: true })

    expect(
      listingDeleteError(new ApiError('NOT_LISTING_OWNER', 403, '只能操作自己的商品')),
    ).toEqual({ message: '只能操作自己的商品', refresh: true })

    expect(
      listingDeleteError(new ApiError('LISTING_NOT_FOUND', 404, '商品不存在或不可见')),
    ).toEqual({ message: '商品不存在或不可见', refresh: true })

    // 其它 ApiError 同样透传，但不强制刷新（例如 401 交给全局登录收口）
    expect(listingDeleteError(new ApiError('UNAUTHENTICATED', 401, '未登录'))).toEqual({
      message: '未登录',
      refresh: false,
    })

    expect(listingDeleteError(new Error('network'))).toEqual({
      message: '删除失败，请稍后重试',
      refresh: false,
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

  test('signature validation details map to the signature field (#445)', () => {
    const view = profileUpdateErrorView(
      new ApiError('VALIDATION_FAILED', 422, '请求参数不合法', [
        { field: 'signature', message: '个性签名最多 200 字' },
      ]),
    )
    expect(view.fields.signature).toBe('个性签名最多 200 字')
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
        // #359 3c 起契约必填：SYSTEM 消息既不可撤回也不带引用。
        recalledAt: null,
        replyTo: null,
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

describe('meetup credential api', () => {
  const TX = 'txn_01jc000000e00800000000004t'

  function recordCalls(response: () => Response) {
    const calls: Array<{ url: string; method: string; body: string | null }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      return response()
    }) as unknown as typeof fetch
    return calls
  }

  test('issuing a code is a POST to the token endpoint', async () => {
    const calls = recordCalls(() =>
      Response.json(
        { transactionId: TX, code: '123456', qrPayload: 'fish://meetup/redeem?tx=x&t=y' },
        { status: 201 },
      ),
    )
    const token = await issueMeetupToken(TX)
    expect(calls).toEqual([
      { url: `/api/transactions/${TX}/meetup-token`, method: 'POST', body: null },
    ])
    expect(token.code).toBe('123456')
  })

  test('reading the status is a GET on the same path', async () => {
    const calls = recordCalls(() =>
      Response.json({ transactionId: TX, status: 'ISSUED', consumedAt: null, consumedBy: null }),
    )
    const status = await fetchMeetupTokenStatus(TX)
    expect(calls).toEqual([
      { url: `/api/transactions/${TX}/meetup-token`, method: 'GET', body: null },
    ])
    expect(status.status).toBe('ISSUED')
  })

  test('redeeming sends the qr token, and the manual path sends the 6-digit code', async () => {
    const verification = () =>
      Response.json({
        transactionId: TX,
        verified: true,
        verifiedBy: 'usr_01jc000000e00800000000000b',
        verifiedAt: '2026-01-02T00:00:00.000Z',
        nextAction: 'CONFIRM_DELIVERY',
      })

    const redeemCalls = recordCalls(verification)
    await redeemMeetupToken(TX, 'qr-token-value')
    expect(redeemCalls).toEqual([
      {
        url: `/api/transactions/${TX}/meetup-token/redeem`,
        method: 'POST',
        body: JSON.stringify({ qrToken: 'qr-token-value' }),
      },
    ])

    const codeCalls = recordCalls(verification)
    await verifyMeetupCode(TX, '123456')
    expect(codeCalls).toEqual([
      {
        url: `/api/transactions/${TX}/meetup-token/verify-code`,
        method: 'POST',
        body: JSON.stringify({ code: '123456' }),
      },
    ])
  })
})

describe('reviewSubmitError (#445)', () => {
  test('409 已评过 → alreadyReviewed，容器据此关弹窗并重读评价边', () => {
    expect(reviewSubmitError(new ApiError('TRANSACTION_REVIEW_EXISTS', 409, '已评价过'))).toEqual({
      message: '你已评价过这笔交易',
      alreadyReviewed: true,
      refresh: false,
    })
  })

  test('终态漂移透传服务端文案并要求刷新订单', () => {
    const view = reviewSubmitError(new ApiError('TRANSACTION_NOT_COMPLETED', 409, '交易还没完成'))
    expect(view.message).toBe('交易还没完成')
    expect(view.refresh).toBe(true)
    expect(view.alreadyReviewed).toBe(false)
  })

  test('评语敏感词拦截只透传，不刷新也不当已评', () => {
    const view = reviewSubmitError(new ApiError('REVIEW_CONTENT_BLOCKED', 422, '评语包含违规内容'))
    expect(view.message).toBe('评语包含违规内容')
    expect(view.refresh).toBe(false)
    expect(view.alreadyReviewed).toBe(false)
  })

  test('非 ApiError 走兜底文案', () => {
    expect(reviewSubmitError(new Error('boom'))).toEqual({
      message: '评价失败，请稍后重试',
      alreadyReviewed: false,
      refresh: false,
    })
  })
})
