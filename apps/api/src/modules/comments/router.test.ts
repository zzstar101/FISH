import { describe, expect, test } from 'bun:test'
import type { CommentDto, CommentListQuery } from '@fish/contracts/comments/schema'
import { errorBody } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { allowRestrictionGuard } from '../governance/testing'
import { createCommentsRouter } from './router'
import { type CommentService, CommentServiceError } from './service'

const LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-000000000011')
const COMMENT_ID = encodePublicId(PUBLIC_ID_PREFIX.comment, '01930000-0000-7000-8000-000000000021')
const AUTHOR_ID = '01930000-0000-7000-8000-00000000000b'

const dto: CommentDto = {
  id: COMMENT_ID,
  listingId: LISTING_ID,
  author: {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, AUTHOR_ID),
    nickname: '林一',
    avatarUrl: null,
  },
  content: '还在吗？',
  createdAt: '2026-09-12T03:40:10.000Z',
  isSeller: false,
  replies: [],
}

function fakeService(overrides: Partial<CommentService> = {}): CommentService {
  return {
    listComments: async () => ({ items: [dto], nextCursor: null }),
    createComment: async () => dto,
    createReply: async () => dto,
    ...overrides,
  }
}

/**
 * 测试用的父 app 模拟 `app.ts` 的接线：只在写路由上挂登录守卫，读路由不挂
 * （读匿名可用、写必须登录，与 listings 同一分界）。
 */
function buildApp(options: { service: CommentService; authed?: boolean; userId?: string }) {
  const authed = options.authed ?? true
  const root = new Hono()

  const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (!authed) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', options.userId ?? AUTHOR_ID)
    await next()
  }

  root.route(
    '/',
    createCommentsRouter({ service: options.service, requireAuth, guard: allowRestrictionGuard }),
  )
  return root
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('comments router — 读接口匿名可用', () => {
  test('GET /listings/:id/comments works without a session', async () => {
    const app = buildApp({ service: fakeService(), authed: false })
    const res = await app.request(`/listings/${LISTING_ID}/comments`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [dto], nextCursor: null })
  })

  test('passes the parsed query (limit default + cursor) to the service', async () => {
    let seen: CommentListQuery | undefined
    const app = buildApp({
      authed: false,
      service: fakeService({
        listComments: async (_id, query) => {
          seen = query
          return { items: [], nextCursor: null }
        },
      }),
    })

    await app.request(`/listings/${LISTING_ID}/comments?limit=5&cursor=abc`)
    expect(seen).toEqual({ limit: 5, cursor: 'abc' })
  })

  test('422s an invalid query instead of passing it to the service', async () => {
    let called = false
    const app = buildApp({
      authed: false,
      service: fakeService({
        listComments: async () => {
          called = true
          return { items: [], nextCursor: null }
        },
      }),
    })

    const res = await app.request(`/listings/${LISTING_ID}/comments?limit=999`)
    expect(res.status).toBe(422)
    expect(called).toBe(false)
  })

  test('maps a service VALIDATION_FAILED with details onto the envelope', async () => {
    const app = buildApp({
      authed: false,
      service: fakeService({
        listComments: async () => {
          throw new CommentServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
            { field: 'cursor', message: 'cursor 无效' },
          ])
        },
      }),
    })

    const res = await app.request(`/listings/${LISTING_ID}/comments?cursor=forged`)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: [{ field: 'cursor', message: 'cursor 无效' }],
      },
    })
  })

  test('404s a non-uuid listing id before it can reach SQL', async () => {
    const app = buildApp({ service: fakeService(), authed: false })
    const res = await app.request('/listings/not-a-uuid/comments')

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('LISTING_NOT_FOUND')
  })
})

describe('comments router — 写接口要求登录', () => {
  test('POST a comment without a session is 401', async () => {
    const app = buildApp({ service: fakeService(), authed: false })
    const res = await app.request(`/listings/${LISTING_ID}/comments`, json({ content: '还在吗' }))

    expect(res.status).toBe(401)
  })

  test('POST a valid comment returns 201 with the created dto', async () => {
    const app = buildApp({ service: fakeService() })
    const res = await app.request(`/listings/${LISTING_ID}/comments`, json({ content: '还在吗' }))

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(dto)
  })

  test('422s an empty or over-long body', async () => {
    const app = buildApp({ service: fakeService() })
    const empty = await app.request(`/listings/${LISTING_ID}/comments`, json({ content: '  ' }))
    expect(empty.status).toBe(422)

    const long = await app.request(
      `/listings/${LISTING_ID}/comments`,
      json({ content: '字'.repeat(201) }),
    )
    expect(long.status).toBe(422)
  })

  test('POST /comments/:id/replies maps a service error onto the contract envelope', async () => {
    const app = buildApp({
      service: fakeService({
        createReply: async () => {
          throw new CommentServiceError(404, 'COMMENT_NOT_FOUND', '留言不存在')
        },
      }),
    })
    const res = await app.request(`/comments/${COMMENT_ID}/replies`, json({ content: '还在吗' }))

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('COMMENT_NOT_FOUND')
  })

  test('POST /comments/:id/replies 404s a non-uuid comment id', async () => {
    const app = buildApp({ service: fakeService() })
    const res = await app.request('/comments/nope/replies', json({ content: '还在吗' }))

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('COMMENT_NOT_FOUND')
  })
})
