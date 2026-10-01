/**
 * 收藏域 API（契约见 `@fish/contracts/favorites`，服务端 #190 / 契约随 #394 上线）。
 *
 * 约定与其余域模块一致：路径取自契约常量（不硬编码字符串），响应一律用契约 zod schema
 * 收口 —— 形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * ## 三条路径的语义差异（决定调用方怎么写错误分支）
 *
 * - `GET  /listings/:id/favorite`：读**我的**收藏态。要登录（未登录 401 `UNAUTHENTICATED`）；
 *   商品不存在 / 不可见 / 已不在售一律 404 `LISTING_NOT_FOUND`（三合一，见契约注释）。
 * - `POST /listings/:id/favorite`：收藏。**幂等**，回 `{favorited:true}`；
 *   商品必须 `ACTIVE` 且未被平台下架，否则 404 `LISTING_NOT_FOUND`。
 * - `DELETE /listings/:id/favorite`：取消。**无条件幂等** —— 不判商品状态、也不查它是否存在，
 *   所以失效条目也清得掉。同样回 `{favorited:false}`。
 *
 * 写接口回状态而不是 204：端上**以服务端返回为准**，不本地翻转再自己猜结果
 * （本地翻转在幂等写 + 并发下会显示成与库里相反的状态）。
 */
import { FAVORITE_ROUTES } from '@fish/contracts/favorites/routes'
import {
  type FavoriteState,
  FavoriteStateSchema,
  type MyFavoritesResponse,
  MyFavoritesResponseSchema,
} from '@fish/contracts/favorites/schema'
import { apiRequest } from '@/lib/request'

/**
 * 一页收藏的条数。契约 `MyFavoritesQuerySchema` 的上限是 50，
 * 这里取默认档 20 —— 收藏页是「翻着看」的列表，首屏 20 行足够，也少一次长图列表的渲染压力。
 */
const PAGE_SIZE = 20

/** 读某件商品的收藏态（要登录）。 */
export async function fetchFavoriteState(listingId: string): Promise<FavoriteState> {
  const payload = await apiRequest(FAVORITE_ROUTES.favoriteRelation(listingId))
  return FavoriteStateSchema.parse(payload)
}

/**
 * 收藏 / 取消收藏。`favorited` 是要写成的目标状态，不是切换 —— 幂等写不需要读-改-写，
 * 也就不存在两次点击交错时「点两下变成收藏」的经典竞态。
 */
export async function setFavorite(listingId: string, favorited: boolean): Promise<FavoriteState> {
  const payload = await apiRequest(FAVORITE_ROUTES.favoriteRelation(listingId), {
    method: favorited ? 'POST' : 'DELETE',
  })
  return FavoriteStateSchema.parse(payload)
}

/**
 * 拉一页我的收藏。
 *
 * `cursor` 是不透明串，只能原样回传上一页的 `nextCursor`（契约禁止前端解析或构造）；
 * 传 `undefined` 即从第一页开始。
 */
export async function fetchMyFavorites(cursor?: string): Promise<MyFavoritesResponse> {
  const payload = await apiRequest(FAVORITE_ROUTES.myFavorites, {
    query: { limit: PAGE_SIZE, cursor },
  })
  return MyFavoritesResponseSchema.parse(payload)
}
