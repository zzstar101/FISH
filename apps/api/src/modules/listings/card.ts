import {
  type ListingCard,
  ListingCardSchema,
  type ListingModerationStatus,
} from '@fish/contracts/listings/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'
import type { MediaStorage } from '../uploads/storage'

/**
 * 卖家公开投影的**源列**（#191）：调用方只要 SELECT 出这四列就能用。
 * 对外形状（公开 id、头像 URL 降级）由 `toListingCard` 统一负责，别处不得各写一份。
 */
export type ListingCardSeller = {
  id: string
  nickname: string
  avatarUrl: string | null
  authStatus: 'UNVERIFIED' | 'VERIFIED'
}

/**
 * `listings` 行 → 契约卡片。放在这里而不是 `service.ts` 内部，是因为 #8 的 `/matches`
 * 也要给同一张卡片（匹配结果里的商品与 feed / 详情里的必须是同一个形状）。
 *
 * 参数类型写成结构类型而不是 `ListingRow`：调用方只要 SELECT 出这些列就能用，
 * 不需要为了映射去多查 `description` / `seller_id` 之类的字段。
 */
export type ListingCardSource = {
  id: string
  listingNo: bigint
  title: string
  priceCents: number
  category: ListingCard['category']
  condition: ListingCard['condition']
  status: ListingCard['status']
  urgent: boolean
  negotiable: boolean
  free: boolean
  createdAt: Date
  /**
   * 卖家公开子集（#191）：经 join（feed / 匹配 / 他人主页在售）或本人行（个人中心）同源带出，
   * **不逐卡补查**。契约 `seller` 是 optional 只为老客户端 mock 记录——API 卡片恒带
   * （`users` 无注销类列，`seller_id` 外键保证行存在），见契约注释。
   */
  seller: ListingCardSeller
  /**
   * 「想要数」= 与该商品已建立会话的买家数（口径见契约 `ListingCardSchema.wants` 与
   * `docs/design/issue-74-watchers-definition.md`）。
   *
   * 与 `seller` 同一取舍：由各读路径的**主查询**带出来（`@fish/db/listing-wants` 的
   * `listingWantsCount`），不在映射层补查 —— 否则一页 50 张卡就是 50 次往返。
   * 因此本字段是**必填**：`0` 与「没查」在这里是两种不同的事实，让后者编译期就过不去。
   */
  wants: number
}
/**
 * 决策 C（Issue #6）：读响应校验失败**不 500**，记日志后跳过该条——一条脏数据不该让整个列表打不开。
 * 返回 `null` 的调用方负责跳过（feed 少一条、匹配少一条）。
 *
 * `storage` 只取 `publicUrl`：「公开 URL 怎么拼」只允许有一个实现（#6 契约 §7.8）。
 *
 * `moderationStatus` / `governanceDelisted` / `moderationReason` 都由调用方按**视角**决定：
 * 只有卖家本人视角才传真实值，公开 Feed / 匹配 / 他人主页一律省略（→ `null`）。
 * 审核态、治理下架与未通过原因都不是买家该看到的信息（#74 / #73 / Owner 2026-09-28 的
 * 「不过审要点明原因」）。三者的区别见契约 `ListingCardSchema` 上各自的注释。
 */
export function toListingCard(
  listing: ListingCardSource,
  coverObjectKey: string | null,
  storage: Pick<MediaStorage, 'publicUrl'>,
  moderationStatus: ListingModerationStatus | null = null,
  governanceDelisted: boolean | null = null,
  moderationReason: string | null = null,
): ListingCard | null {
  const card = {
    id: encodePublicId(PUBLIC_ID_PREFIX.listing, listing.id),
    listingNo: listing.listingNo.toString(),
    title: listing.title,
    priceCents: listing.priceCents,
    category: listing.category,
    condition: listing.condition,
    status: listing.status,
    urgent: listing.urgent,
    negotiable: listing.negotiable,
    free: listing.free,
    coverUrl: coverObjectKey ? storage.publicUrl(coverObjectKey) : null,
    createdAt: listing.createdAt.toISOString(),
    wants: listing.wants,
    // 卖家公开子集（#191）：与详情的 `toSeller` 同一口径——公开 id 前缀 usr_、
    // 头像经 `publicAvatarUrl`（库里的历史脏值降级 null，不让一个脏头像打挂整页）。
    seller: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, listing.seller.id),
      nickname: listing.seller.nickname,
      avatarUrl: publicAvatarUrl(listing.seller.avatarUrl),
      authStatus: listing.seller.authStatus,
    },
    moderationStatus,
    governanceDelisted,
    moderationReason,
  }

  const parsed = ListingCardSchema.safeParse(card)
  if (!parsed.success) {
    console.error('[listings] 跳过无法映射为契约的卡片', listing.id, parsed.error.message)
    return null
  }
  return parsed.data
}
