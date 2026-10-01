import { z } from 'zod'
import { ListingCardSchema } from '../listings/schema'

/**
 * Favorite Domain Contract（Issue #190）。前端与 API 只依赖本目录的字段定义。
 *
 * 表结构由 #287 落地（`packages/db/src/schema/favorites.ts`），本域**不新增任何表/列**：
 * `(user_id, listing_id)` 唯一约束保证幂等，`(user_id, created_at, id)` 是列表的稳定游标顺序。
 *
 * ## 有效 / 失效沿用商品状态，不新增「是否失效」字段
 *
 * 收藏行**不随商品状态变化而消失**：商品下架（`OFFLINE`）或售出（`SOLD`）之后，
 * 收藏仍在列表里，客户端读 `listing.status` 自己决定怎么展示。多给一个 `available: boolean`
 * 就是把 `status` 的结论再抄一遍 —— 两个字段迟早会不一致，而真正要区分的
 * 「下架」与「已售出」本来就只能由 `status` 表达。
 *
 * 唯一会消失的情形是商品被**物理删除**：Owner 2026-09-28 拍板「不过审商品被物理删除时，
 * 它的收藏一并清除」，已在 `listings/store.ts` 的 `deleteListingAtomic` 落地。
 * 因此列表里不存在指向已删除商品的孤儿行，本域不需要软删 / 快照字段。
 *
 * ## 公开投影
 *
 * 收藏者是**买家视角**：内嵌卡片走 `ListingCardSchema` 的公开形状，
 * `moderationStatus` / `governanceDelisted` 恒为 `null`（那两个字段只在卖家本人视角有值，
 * 连自己收藏自己的商品也不例外 —— 这里回答的是「我收藏的这件东西长什么样」，
 * 不是「我卖的东西审核到哪一步了」）。
 */

/** 收藏列表的一行：公开商品卡片 + 我收藏它的时间。 */
export const FavoriteItemSchema = z.object({
  listing: ListingCardSchema,
  /** 我收藏它的时间（`favorites.created_at`）；列表按它倒序。 */
  favoritedAt: z.iso.datetime(),
})

export type FavoriteItem = z.infer<typeof FavoriteItemSchema>

/**
 * `GET /me/favorites` 的查询参数。
 *
 * 只接受 `limit` / `cursor`：用户 id 由登录态决定，端上无法指定别人的收藏夹，
 * 所以是 `strictObject` 而不是「多传就忽略」—— 多传未知参数报 422，把越权尝试暴露出来。
 * `limit` 边界与公开 Feed / 关注列表逐字相同：默认 20、上限 50。
 */
export const MyFavoritesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 不透明字符串：服务端对 `(created_at, 商品 id)` 编码，前端禁止解析或构造，只原样回传。 */
  cursor: z.string().min(1).optional(),
})

export type MyFavoritesQuery = z.infer<typeof MyFavoritesQuerySchema>

/**
 * 收藏列表响应。
 *
 * `total` 是**全量**计数（服务端 COUNT，与列表同一份关系数据），不是这一页的长度：
 * 分页列表拿不出全量计数，旁路再发一个 count 请求又会让两个数字有机会不一致。
 * `nextCursor !== null` 即还有下一页（与 feed 同语义）。
 */
export const MyFavoritesResponseSchema = z.object({
  items: z.array(FavoriteItemSchema),
  nextCursor: z.string().nullable(),
  /** 我收藏的总件数（全量，不是这一页）。 */
  total: z.number().int().nonnegative(),
})

export type MyFavoritesResponse = z.infer<typeof MyFavoritesResponseSchema>

/**
 * 收藏关系状态（`GET /listings/:listingId/favorite` 与两个写接口的响应共用）。
 *
 * 写接口回状态而不是 204：端上成功以服务端为准，不必本地翻转再自己猜结果。
 * 取消收藏后恒为 `{ favorited: false }`。
 */
export const FavoriteStateSchema = z.object({
  favorited: z.boolean(),
})

export type FavoriteState = z.infer<typeof FavoriteStateSchema>

/**
 * 本 domain 的错误码。其余复用 system 的 `VALIDATION_FAILED`（422）与
 * auth 的 `UNAUTHENTICATED`（401）。
 */
export const FavoriteErrorCodeSchema = z.enum([
  /**
   * 404：商品不存在、**或**对当前用户不可见、**或**已不在售。
   *
   * 三种原因合并成同码同文案，与 `listings` 域的 `LISTING_NOT_FOUND`
   * （「商品不存在或不可见」）同一取舍：这条路径任何登录用户都能稳定触发，
   * 区分「格式错」「不存在」「已下架」等于给出一份商品 id 空间的探针。
   */
  'LISTING_NOT_FOUND',
])

export type FavoriteErrorCode = z.infer<typeof FavoriteErrorCodeSchema>
