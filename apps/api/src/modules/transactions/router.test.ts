import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Hono } from 'hono'
import { createTransactionsRouter } from './router'
import { type TransactionService, TransactionServiceError } from './service'

const dto: TransactionDto = {
  id: '00000000-0000-4000-8000-0000000000e1',
  conversationId: '00000000-0000-4000-8000-0000000000c1',
  listingId: '00000000-0000-4000-8000-0000000000b1',
  buyerId: 'user-1',
  sellerId: 'user-2',
  role: 'seller',
  listing: {
    id: '00000000-0000-4000-8000-0000000000b1',
    title: 'K380 键盘',
    priceCents: 16000,
    status: 'RESERVED',
    coverUrl: null,
  },
  counterpart: { id: 'user-1', nickname: '买家', avatarUrl: null },
  amountCents: 15000,
  status: 'PENDING_MEETUP',
  buyerConfirmedAt: null,
  sellerConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
}

const systemMessage: MessageDto = {
  id: '00000000-0000-4000-8000-0000000000d1',
  conversationId: '00000000-0000-4000-8000-0000000000c1',
  senderId: null,
  sender: null,
  type: 'SYSTEM',
  content: '{"type":"tx.proposal","amountCents":16000}',
  createdAt: '2026-09-12T10:00:00.000Z',
}

function buildApp(overrides: Partial<TransactionService> = {}) {
  const service: TransactionService = {
    propose: async () => systemMessage,
    reject: async () => systemMessage,
    accept: async () => dto,
    listTransactions: async () => ({ items: [dto], nextCursor: null }),
    getTransaction: async () => dto,
    confirm: async () => ({ ...dto, status: 'COMPLETED', completedAt: '2026-09-12T11:00:00.000Z' }),
    cancel: async () => ({ ...dto, status: 'CANCELLED', cancelledAt: '2026-09-12T11:00:00.000Z' }),
    issueMeetupToken: async () => ({
      transactionId: dto.id,
      code: '482913',
      qrPayload: `fish://meetup/redeem?tx=${dto.id}&t=abc_DEF-123`,
      expiresAt: '2026-09-12T10:05:00.000Z',
    }),
    getMeetupTokenStatus: async () => ({
      transactionId: dto.id,
      status: 'ISSUED' as const,
      expiresAt: '2026-09-12T10:05:00.000Z',
      consumedAt: null,
      consumedBy: null,
    }),
    redeemMeetupToken: async () => ({
      transactionId: dto.id,
      verified: true as const,
      verifiedBy: 'user-1',
      verifiedAt: '2026-09-12T10:01:00.000Z',
      nextAction: 'CONFIRM_DELIVERY' as const,
    }),
    verifyMeetupCode: async () => ({
      transactionId: dto.id,
      verified: true as const,
      verifiedBy: 'user-1',
      verifiedAt: '2026-09-12T10:01:00.000Z',
      nextAction: 'CONFIRM_DELIVERY' as const,
    }),
    ...overrides,
  }
  const root = new Hono<{ Variables: { userId: string } }>()
  root.use('/transactions/*', async (c, next) => {
    c.set('userId', 'user-1')
    await next()
  })
  root.route(
    '/transactions',
    createTransactionsRouter({
      service,
      requireAuth: async (_c, next) => {
        await next()
      },
    }),
  )
  return root
}

describe('transactions router', () => {
  test('POST /proposals returns 201 with the SYSTEM message row', async () => {
    const response = await buildApp().request('/transactions/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: '00000000-0000-4000-8000-0000000000c1',
        amountCents: 16000,
      }),
    })
    expect(response.status).toBe(201)
  })

  test('POST /proposals with missing amountCents → 422 envelope with details', async () => {
    const response = await buildApp().request('/transactions/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: '00000000-0000-4000-8000-0000000000c1' }),
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; details?: unknown[] } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details).toBeDefined()
  })

  test('POST / (accept) returns 201 with the created transaction', async () => {
    const response = await buildApp().request('/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: '00000000-0000-4000-8000-0000000000c1',
        amountCents: 15000,
      }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(dto)
  })

  test('POST / (accept) maps 409 LISTING_NOT_ACTIVE from the service', async () => {
    const app = buildApp({
      accept: async () => {
        throw new TransactionServiceError(409, 'LISTING_NOT_ACTIVE', '商品当前不可交易')
      },
    })
    const response = await app.request('/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: '00000000-0000-4000-8000-0000000000c1',
        amountCents: 15000,
      }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'LISTING_NOT_ACTIVE', message: '商品当前不可交易' },
    })
  })

  test('POST /:id/confirm returns the completed dto', async () => {
    const response = await buildApp().request(
      '/transactions/00000000-0000-4000-8000-0000000000e1/confirm',
      { method: 'POST' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as TransactionDto
    expect(body.status).toBe('COMPLETED')
  })

  test('GET /:id maps 404 TRANSACTION_NOT_FOUND from the service', async () => {
    const app = buildApp({
      getTransaction: async () => {
        throw new TransactionServiceError(404, 'TRANSACTION_NOT_FOUND', '交易不存在')
      },
    })
    const response = await app.request('/transactions/00000000-0000-4000-8000-0000000000e1')
    expect(response.status).toBe(404)
  })

  test('POST /proposals/reject returns 200 with the SYSTEM message', async () => {
    const response = await buildApp().request('/transactions/proposals/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: '00000000-0000-4000-8000-0000000000c1' }),
    })
    expect(response.status).toBe(200)
  })

  test('POST /:id/cancel returns the cancelled dto; service 409 mapping works', async () => {
    const ok = await buildApp().request(
      '/transactions/00000000-0000-4000-8000-0000000000e1/cancel',
      { method: 'POST' },
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as TransactionDto
    expect(body.status).toBe('CANCELLED')

    const app = buildApp({
      cancel: async () => {
        throw new TransactionServiceError(409, 'TRANSACTION_NOT_IN_PENDING', '已完成的交易不可取消')
      },
    })
    const conflict = await app.request(
      '/transactions/00000000-0000-4000-8000-0000000000e1/cancel',
      { method: 'POST' },
    )
    expect(conflict.status).toBe(409)
    const conflictBody = (await conflict.json()) as { error: { code: string; message: string } }
    expect(conflictBody.error).toEqual({
      code: 'TRANSACTION_NOT_IN_PENDING',
      message: '已完成的交易不可取消',
    })
  })

  test('malformed :id does not reach the store (404, not 500)', async () => {
    const app = buildApp({
      getTransaction: async () => {
        throw new Error('store must not be reached with a non-uuid id')
      },
    })
    const response = await app.request('/transactions/not-a-uuid')
    expect(response.status).toBe(404)
    const notFoundBody = (await response.json()) as { error: { code: string; message: string } }
    expect(notFoundBody.error).toEqual({ code: 'TRANSACTION_NOT_FOUND', message: '交易不存在' })
  })

  test('GET / rejects an unknown status filter with 422', async () => {
    const response = await buildApp().request('/transactions?status=REQUESTED')
    expect(response.status).toBe(422)
  })
})

describe('meetup token router (#70)', () => {
  const txId = dto.id

  test('POST /:id/meetup-token → 201 with plaintext code + qrPayload', async () => {
    const response = await buildApp().request(`/transactions/${txId}/meetup-token`, {
      method: 'POST',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { code: string; qrPayload: string }
    expect(body.code).toMatch(/^\d{6}$/)
    expect(body.qrPayload).toContain('fish://meetup/redeem')
  })

  test('GET /:id/meetup-token → 200 status（无明文）', async () => {
    const response = await buildApp().request(`/transactions/${txId}/meetup-token`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string }
    expect(body.status).toBe('ISSUED')
    expect((body as unknown as { code?: string }).code).toBeUndefined()
  })

  test('POST /:id/meetup-token/redeem → 200 verification; 空 body → 422', async () => {
    const ok = await buildApp().request(`/transactions/${txId}/meetup-token/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qrToken: 'abc_DEF-123' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ verified: true, nextAction: 'CONFIRM_DELIVERY' })

    const bad = await buildApp().request(`/transactions/${txId}/meetup-token/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(bad.status).toBe(422)
  })

  test('POST /:id/meetup-token/verify-code → 200；非 6 位码 → 422', async () => {
    const ok = await buildApp().request(`/transactions/${txId}/meetup-token/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '482913' }),
    })
    expect(ok.status).toBe(200)

    const bad = await buildApp().request(`/transactions/${txId}/meetup-token/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '48291a' }),
    })
    expect(bad.status).toBe(422)
  })

  test('service 的 429 / 409 信封原样透传', async () => {
    const locked = buildApp({
      verifyMeetupCode: () => {
        throw new TransactionServiceError(429, 'MEETUP_TOKEN_LOCKED', '错误次数过多，请稍后再试')
      },
    })
    const response = await locked.request(`/transactions/${txId}/meetup-token/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '482913' }),
    })
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { code: 'MEETUP_TOKEN_LOCKED', message: '错误次数过多，请稍后再试' },
    })
  })

  test('畸形 :id 不进 service（404）', async () => {
    const response = await buildApp().request('/transactions/not-a-uuid/meetup-token', {
      method: 'POST',
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'TRANSACTION_NOT_FOUND', message: '交易不存在' },
    })
  })
})
