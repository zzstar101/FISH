import { FAVORITE_ROUTES } from '@fish/contracts/favorites/routes'
import { MyFavoritesQuerySchema } from '@fish/contracts/favorites/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { ListingIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { RecommendationDomainRecorder } from '../recommendation/domain-events'
import { type FavoriteService, FavoriteServiceError } from './service'

type FavoriteVariables = { userId: string }
type FavoriteContext = Context<{ Variables: FavoriteVariables }>

export type FavoriteUserIdResolver = (context: FavoriteContext) => string | undefined

export type FavoritesRouterOptions = {
  service: FavoriteService
  /**
   * 必须从认证 middleware 写入的**服务端可信 context** 读取当前用户 id，禁止信任请求头
   * （与 #7 / #23 / #188 同一约定）。接线时 `app.ts` 已对两条路径挂 `auth.requireAuth`；
   * 这里的兜底保证漏挂守卫时**失败关闭**（401），而不是把匿名请求当成本人。
   */
  getUserId: FavoriteUserIdResolver
  /**
   * 服务端确证行为的埋点口（#323 R4）：`FAVORITE` = +4 是权重表里最强的正信号，而这两个端点
   * 是它**唯一**的服务端真值来源 —— `POST /recommendations/events` 只认客户端上报，收藏断网
   * 重试就会整批丢。可选依赖：不传就完全不埋点（测试与不关心推荐的装配不必构造它）。
   *
   * 埋点是旁路：`RecommendationDomainRecorder.record` 内部已吞掉全部异常，`await` 它不会把
   * 已成功的收藏变成 500。
   */
  recorder?: RecommendationDomainRecorder
}

/**
 * 路径参数必须是规范的商品 Public ID。非法输入与不存在同码 404（`LISTING_NOT_FOUND`）：
 * 不给「格式错」与「不存在」留可区分的响应，否则这条登录可达的路径就成了一份商品 id 空间探针
 * （与 `listings/router.ts` 同一取舍）。
 */
function requireListingId(c: FavoriteContext): string | null {
  const parsed = ListingIdSchema.safeParse(c.req.param('listingId'))
  return parsed.success ? decodePublicId(PUBLIC_ID_PREFIX.listing, parsed.data) : null
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（与 #6 / #23 的 router 同构）。 */
function toErrorResponse(c: FavoriteContext, error: unknown): Response {
  if (error instanceof FavoriteServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

const listingNotFoundResponse = (c: FavoriteContext) =>
  c.json(errorBody('LISTING_NOT_FOUND', '商品不存在或不可见'), 404)

/**
 * 路由 pattern 从契约常量派生：把参数名当占位 id 传进去（禁止在别处硬编码路径）。
 * 挂载点是根路径 `/`（`app.ts`），两个 pattern 分别在 `/me/favorites` 与
 * `/listings/:listingId/favorite` 之下 —— 后者比 `listings` router 的 `/listings/:id`
 * 多一段，两者不会互相截胡。
 */
const MY_FAVORITES_PATH = FAVORITE_ROUTES.myFavorites
const RELATION_PATH = FAVORITE_ROUTES.favoriteRelation(':listingId')

export function createFavoritesRouter({ service, getUserId, recorder }: FavoritesRouterOptions) {
  const router = new Hono<{ Variables: FavoriteVariables }>()

  // 本域**没有匿名路径**：收藏是「我」与某件商品之间的关系，浏览者是谁决定了看得到哪一份数据。
  //
  // ⚠️ 中间件**必须逐路径挂，不能用 `router.use('*', …)`**：本 router 挂载在根路径 `/`
  // （两个端点分属 `/me/...` 与 `/listings/...`，没有共同前缀），而 Hono 的 `app.route('/',
  // sub)` 会把 sub 的 `use('*')` 提升成**父 app 的全局中间件** —— 结果是每个请求
  // （连 `/health` 也是）都先过一道 401。逐路径挂既保留了「漏挂守卫就失败关闭」的兜底，
  // 又不会越界。
  const requireViewer = async (c: FavoriteContext, next: () => Promise<void>) => {
    const userId = getUserId(c)
    // `UNAUTHENTICATED` 与 auth 的 requireAuth 同码：前端只有这一个「跳登录」信号。
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', userId)
    await next()
  }

  router.use(MY_FAVORITES_PATH, requireViewer)
  router.use(RELATION_PATH, requireViewer)

  router.get(MY_FAVORITES_PATH, async (c) => {
    const parsed = MyFavoritesQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.listMyFavorites(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get(RELATION_PATH, async (c) => {
    const listingId = requireListingId(c)
    if (listingId === null) return listingNotFoundResponse(c)

    try {
      return c.json(await service.getState(c.get('userId'), listingId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post(RELATION_PATH, async (c) => {
    const listingId = requireListingId(c)
    if (listingId === null) return listingNotFoundResponse(c)

    try {
      const state = await service.favorite(c.get('userId'), listingId)
      // 归因上下文（requestId / position / source）从推荐头里读，由 recorder 自己解析。
      // 重复收藏（本来就已收藏）也会记一条：`favorites` 的唯一索引让写入幂等，但接口没有把
      // "这次是否真的新建了关系"暴露出来，而收藏是用户主动动作、重复量有界，不值得为它把
      // 收藏 store 的返回类型改宽（§11 已知边界）。
      if (recorder) {
        await recorder.record(c, { viewerId: c.get('userId'), listingId, eventType: 'FAVORITE' })
      }
      return c.json(state, 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.delete(RELATION_PATH, async (c) => {
    const listingId = requireListingId(c)
    if (listingId === null) return listingNotFoundResponse(c)

    try {
      const state = await service.unfavorite(c.get('userId'), listingId)
      // `UNFAVORITE` 是负反馈特征（R4）的三个输入之一，且只能在"取消"这个动作上产生。
      if (recorder) {
        await recorder.record(c, { viewerId: c.get('userId'), listingId, eventType: 'UNFAVORITE' })
      }
      return c.json(state, 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type FavoritesRouter = ReturnType<typeof createFavoritesRouter>
