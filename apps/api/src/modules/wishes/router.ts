import {
  wishCreateInputSchema,
  wishListQuerySchema,
  wishUpdateInputSchema,
} from '@fish/contracts/wishes/schema'
import { createDb, type Db } from '@fish/db/client'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { WishMatchQueue } from './match-queue'
import { createWishService, type WishService, WishServiceError } from './service'
import { createSqlWishStore, type WishStore } from './store'

type WishesVariables = { userId: string }
type WishesContext = Context<{ Variables: WishesVariables }>
export type WishUserIdResolver = (context: WishesContext) => string | undefined
export type WishesRouterOptions = {
  store: WishStore
  matchQueue: WishMatchQueue
  getUserId: WishUserIdResolver
  service?: WishService
}

function jsonError(message: string, code = 'BAD_REQUEST') {
  return { error: { code, message } }
}

function serviceErrorResponse(c: WishesContext, error: unknown) {
  if (error instanceof WishServiceError) {
    const code =
      error.status === 403 ? 'FORBIDDEN' : error.status === 404 ? 'NOT_FOUND' : 'CONFLICT'
    switch (error.status) {
      case 403:
        return c.json(jsonError(error.message, code), 403)
      case 404:
        return c.json(jsonError(error.message, code), 404)
      case 409:
        return c.json(jsonError(error.message, code), 409)
      default:
        return c.json(jsonError(error.message, 'BAD_REQUEST'), 400)
    }
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return c.json(jsonError('请求参数无效', 'VALIDATION_ERROR'), 400)
  }
  if (error instanceof SyntaxError) return c.json(jsonError('请求体不是有效 JSON'), 400)
  console.error('[wishes] unhandled error', error)
  return c.json(jsonError('服务暂时不可用', 'INTERNAL_ERROR'), 500)
}

async function parseJson<T>(c: WishesContext, parse: (input: unknown) => T) {
  return parse(await c.req.json())
}

/**
 * getUserId 必须从认证 middleware 写入的服务端可信 context 中读取，禁止直接信任请求头。
 * 当前由 Dev A 在 app.ts 接线时提供真实 resolver。
 */
export function createWishesRouter(options: WishesRouterOptions) {
  const service =
    options.service ?? createWishService({ store: options.store, matchQueue: options.matchQueue })
  const app = new Hono<{ Variables: WishesVariables }>()

  app.use('*', async (c, next) => {
    const userId = options.getUserId(c)
    if (!userId) return c.json(jsonError('缺少登录身份', 'UNAUTHORIZED'), 401)
    c.set('userId', userId)
    await next()
  })

  app.get('/pool', async (c) => {
    try {
      return c.json(await service.getPool(), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.post('/', async (c) => {
    try {
      const input = await parseJson(c, (body) => wishCreateInputSchema.parse(body))
      return c.json(await service.createWish(c.get('userId'), input), 201)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.get('/', async (c) => {
    try {
      const query = wishListQuerySchema.parse(c.req.query())
      const result = await service.listWishes(c.get('userId'), query)
      return c.json({ ...result, page: query.page, pageSize: query.pageSize }, 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.get('/:id', async (c) => {
    try {
      return c.json(await service.getWish(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.patch('/:id', async (c) => {
    try {
      const input = await parseJson(c, (body) => wishUpdateInputSchema.parse(body))
      return c.json(await service.updateWish(c.get('userId'), c.req.param('id'), input), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.post('/:id/close', async (c) => {
    try {
      return c.json(await service.closeWish(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.post('/:id/fulfill', async (c) => {
    try {
      return c.json(await service.fulfillWish(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  return app
}

/** 供 Dev A 在 app.ts 中通过 app.route('/api/wishes', router) 接线。 */
export function createWishesRouterFromDb(db: Db, dependencies: Omit<WishesRouterOptions, 'store'>) {
  return createWishesRouter({ ...dependencies, store: createSqlWishStore(db) })
}

export type WishesRouter = ReturnType<typeof createWishesRouter>

export function createWishesRouterFromDatabaseUrl(
  databaseUrl: string,
  dependencies: Omit<WishesRouterOptions, 'store'>,
) {
  return createWishesRouterFromDb(createDb(databaseUrl), dependencies)
}
