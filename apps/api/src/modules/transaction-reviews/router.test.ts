import { describe, expect, test } from 'bun:test'
import { errorBody } from '@fish/contracts/system/error'
import type { TransactionReviewResponse } from '@fish/contracts/transaction-reviews/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { Hono, type MiddlewareHandler } from 'hono'
import { createTransactionReviewsRouter } from './router'
import { type TransactionReviewService, TransactionReviewServiceError } from './service'

const TXN_ID = encodePublicId(PUBLIC_ID_PREFIX.transaction, '01930000-0000-7000-8000-0000000000a1')
const REVIEW_ID = encodePublicId(PUBLIC_ID_PREFIX.review, '01930000-0000-7000-8000-0000000000b1')
const USER_ID = '01930000-0000-7000-8000-00000000000b'

const review: TransactionReviewResponse = {
  id: REVIEW_ID,
  transactionId: TXN_ID,
  rating: 'POSITIVE',
  body: '很好相处，准时面交',
  images: [],
  createdAt: '2026-10-01T12:00:00.000Z',
}

function fakeService(overrides: Partial<Record<string, unknown>> = {}): TransactionReviewService {
  return {
    getMyReview: async () => review,
    createReview: async () => review,
    deleteMyReview: async () => ({ deleted: 1 }),
    listReviewsOf: async () => ({ items: [{ review, authorRole: 'buyer' }] }),
    listMine: async () => ({ items: [], nextCursor: null, total: 0 }),
    listMineRows: async () => ({ rows: [], total: 0 }),
    media: {
      presign: async () => ({
        uploadUrl: 'https://upload.example/put',
        objectKey:
          'transaction-review-media/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000c.png',
        headers: {},
        expiresAt: '2026-10-01T12:10:00.000Z',
      }),
      confirm: async () => ({
        objectKey: 'reviews/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000c.png',
        url: 'https://cdn.example/reviews/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000c.png',
      }),
    },
    ...overrides,
  } as unknown as TransactionReviewService
}

/** 治理守卫桩：本域测试不关心封禁语义（真实接线在 app.ts，用 restrictionGuard）。 */
const noopGuard: { write: MiddlewareHandler } = {
  write: async (_c, next) => {
    await next()
  },
}

/**
 * 测试用的父 app 模拟 `app.ts` 的接线：本域没有匿名路径，两条路径都挂登录守卫
 * （守卫只负责把可信 userId 写进 context / 拒绝匿名）。
 */
function buildApp(options: { service: TransactionReviewService; authed?: boolean }) {
  const root = new Hono()
  const authed = options.authed ?? true
  const requireAuth: MiddlewareHandler<{ Variables: { userId: string } }> = async (c, next) => {
    if (!authed) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', USER_ID)
    await next()
  }
  root.use('/transactions/:transactionId/review', requireAuth)
  root.use('/transactions/:transactionId/reviews', requireAuth)
  root.route(
    '/',
    createTransactionReviewsRouter({
      service: options.service,
      getUserId: (c) => c.get('userId'),
      guard: noopGuard,
    }),
  )
  return root
}

describe('transaction-reviews router — 鉴权与路径参数', () => {
  test('全部端点要求登录（本域没有匿名路径）', async () => {
    const app = buildApp({ service: fakeService(), authed: false })
    for (const init of [undefined, { method: 'POST' }, { method: 'DELETE' }]) {
      const res = await app.request(`/transactions/${TXN_ID}/review`, init)
      expect(res.status).toBe(401)
    }
    expect((await app.request(`/transactions/${TXN_ID}/reviews`)).status).toBe(401)
  })

  test('非法 transaction id 与不存在同码 404（不给 id 空间探针）', async () => {
    let reachedService = false
    const service = fakeService({
      getMyReview: () => {
        reachedService = true
        return Promise.resolve(review)
      },
    })
    const app = buildApp({ service })
    for (const bad of ['not-an-id', 'usr_01930000-0000-7000-8000-00000000000b']) {
      expect((await app.request(`/transactions/${bad}/review`)).status).toBe(404)
    }
    expect(reachedService).toBe(false)
  })

  test('GET 边返回我的评价', async () => {
    const app = buildApp({ service: fakeService() })
    const res = await app.request(`/transactions/${TXN_ID}/review`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(review)
  })
})

describe('transaction-reviews router — 创建与校验', () => {
  test('POST 创建成功回 201', async () => {
    const app = buildApp({ service: fakeService() })
    const res = await app.request(`/transactions/${TXN_ID}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 'POSITIVE', body: '很愉快' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(review)
  })

  test('空体 / 非法 rating / 超长 body → 422 VALIDATION_FAILED', async () => {
    const app = buildApp({ service: fakeService() })
    const cases: RequestInit[] = [
      { method: 'POST' },
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 'EXCELLENT' }),
      },
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 'POSITIVE', body: 'x'.repeat(201) }),
      },
    ]
    for (const init of cases) {
      const res = await app.request(`/transactions/${TXN_ID}/review`, init)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    }
  })

  test('service 业务异常 → 契约错误信封 + 对应状态码', async () => {
    const service = fakeService({
      createReview: () => {
        throw new TransactionReviewServiceError(409, 'TRANSACTION_NOT_COMPLETED', '业务失败')
      },
    }) as TransactionReviewService
    const app = buildApp({ service })
    const res = await app.request(`/transactions/${TXN_ID}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 'NEGATIVE' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'TRANSACTION_NOT_COMPLETED',
    )
  })
})

describe('transaction-reviews router — 两方评价', () => {
  test('GET /transactions/:id/reviews 返回带 authorRole 的列表', async () => {
    const app = buildApp({ service: fakeService() })
    const res = await app.request(`/transactions/${TXN_ID}/reviews`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { authorRole: string }[] }
    expect(body.items[0]?.authorRole).toBe('buyer')
  })
})
