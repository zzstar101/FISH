import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ConversationServiceError } from './service'
import { createChatWatchersRouter } from './watchers-router'
import type { ChatWatchersService } from './watchers-service'

const listing = '01990000-0000-7000-8000-0000000000b1'

function appFor(service: ChatWatchersService) {
  const app = new Hono<{ Variables: { userId: string } }>()
  app.route(
    '/',
    createChatWatchersRouter({
      service,
      requireAuth: async (c, next) => {
        if (!c.req.header('authorization'))
          return c.json({ error: { code: 'UNAUTHENTICATED', message: '请登录' } }, 401)
        c.set('userId', '01990000-0000-7000-8000-0000000000a2')
        await next()
      },
    }),
  )
  return app
}

test('匿名 401、路径非法 404、查询超限 422；非法请求不触发服务', async () => {
  let calls = 0
  const app = appFor({
    list: async () => {
      calls++
      return { items: [], total: 0, nextCursor: null }
    },
  })
  expect((await app.request(`/listings/${listing}/watchers`)).status).toBe(401)
  expect(
    (await app.request('/listings/not-a-uuid/watchers', { headers: { authorization: 'ok' } }))
      .status,
  ).toBe(404)
  expect(
    (
      await app.request(`/listings/${listing}/watchers?limit=51`, {
        headers: { authorization: 'ok' },
      })
    ).status,
  ).toBe(422)
  expect(calls).toBe(0)
})

test('卖家拿到同源分页结果，非卖家 403', async () => {
  let seen: unknown
  const app = appFor({
    list: async (userId, listingId, query) => {
      seen = { userId, listingId, query }
      return { items: [], total: 4, nextCursor: null }
    },
  })
  const response = await app.request(`/listings/${listing}/watchers?limit=2`, {
    headers: { authorization: 'ok' },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [], total: 4, nextCursor: null })
  expect(seen).toEqual({
    userId: '01990000-0000-7000-8000-0000000000a2',
    listingId: listing,
    query: { limit: 2 },
  })
  const forbidden = appFor({
    list: async () => {
      throw new ConversationServiceError(403, 'NOT_LISTING_OWNER', '无权查看')
    },
  })
  expect(
    (await forbidden.request(`/listings/${listing}/watchers`, { headers: { authorization: 'ok' } }))
      .status,
  ).toBe(403)
})
