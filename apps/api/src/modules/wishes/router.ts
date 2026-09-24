import {
  wishCreateInputSchema,
  wishListQuerySchema,
  wishUpdateInputSchema,
} from '@fish/contracts/wishes/schema'
import { createDb, type Db } from '@fish/db/client'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { RestrictionGuard } from '../governance/guard'
import { createNoopWishMatchQueue, type WishMatchQueue } from './match-queue'
import { createWishService, type WishService, WishServiceError } from './service'
import { createSqlWishStore, type WishStore } from './store'

type WishesVariables = { userId: string }
type WishesContext = Context<{ Variables: WishesVariables }>
export type WishUserIdResolver = (context: WishesContext) => string | undefined
export type WishesRouterOptions = {
  store: WishStore
  /** 省略时用 no-op 队列；接线时传 createDbWishMatchQueue(db) 启用真实 MATCH_WISH 投递。 */
  matchQueue?: WishMatchQueue
  getUserId: WishUserIdResolver
  service?: WishService
  /** #73 治理守卫：写愿望前检查封禁 / 限制发布（愿望同样是发布行为）。 */
  guard: RestrictionGuard
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
  // 并发 PATCH 可能让组合后的预算区间违反 DB CHECK（SQLSTATE 23514）：数据由约束兜住，
  // 语义上是"与当前状态冲突"，应映射 409 而不是 500。
  if (isCheckViolation(error)) {
    return c.json(jsonError('愿望已被其他修改更新，请重试', 'CONFLICT'), 409)
  }
  console.error('[wishes] unhandled error', describeError(error))
  return c.json(jsonError('服务暂时不可用', 'INTERNAL_ERROR'), 500)
}

async function parseJson<T>(c: WishesContext, parse: (input: unknown) => T) {
  return parse(await c.req.json())
}

/** Postgres CHECK 约束违例（bun-sql 把 SQLSTATE 放在 errno 上）。 */
function isCheckViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errno' in error)) return false
  return (error as { errno?: unknown }).errno === '23514'
}

/** 只取错误首行：Drizzle 的 message 第二行是 SQL 实参（关键词、描述、用户 id），不能原样进日志。 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
}

/** 非法 uuid 直接 404，避免打到 PG 后抛驱动错误变成 500。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function parseWishId(raw: string): string | null {
  return UUID_PATTERN.test(raw) ? raw : null
}

/**
 * getUserId 必须从认证 middleware 写入的服务端可信 context 中读取，禁止直接信任请求头。
 * 当前由 Dev A 在 app.ts 接线时提供真实 resolver。
 */
export function createWishesRouter(options: WishesRouterOptions) {
  const matchQueue = options.matchQueue ?? createNoopWishMatchQueue()
  const service = options.service ?? createWishService({ store: options.store, matchQueue })
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

  app.post('/', options.guard.write, async (c) => {
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
      const id = parseWishId(c.req.param('id'))
      if (!id) return c.json(jsonError('愿望不存在', 'NOT_FOUND'), 404)
      return c.json(await service.getWish(c.get('userId'), id), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.patch('/:id', options.guard.write, async (c) => {
    try {
      const id = parseWishId(c.req.param('id'))
      if (!id) return c.json(jsonError('愿望不存在', 'NOT_FOUND'), 404)
      const input = await parseJson(c, (body) => wishUpdateInputSchema.parse(body))
      return c.json(await service.updateWish(c.get('userId'), id, input), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.post('/:id/close', options.guard.write, async (c) => {
    try {
      const id = parseWishId(c.req.param('id'))
      if (!id) return c.json(jsonError('愿望不存在', 'NOT_FOUND'), 404)
      return c.json(await service.closeWish(c.get('userId'), id), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  app.post('/:id/fulfill', options.guard.write, async (c) => {
    try {
      const id = parseWishId(c.req.param('id'))
      if (!id) return c.json(jsonError('愿望不存在', 'NOT_FOUND'), 404)
      return c.json(await service.fulfillWish(c.get('userId'), id), 200)
    } catch (error) {
      return serviceErrorResponse(c, error)
    }
  })

  return app
}

/** 供 Dev A 在 app.ts 中通过 app.route('/wishes', router) 接线（根级，见 WISH_ROUTES.base）。 */
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
