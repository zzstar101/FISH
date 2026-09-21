import {
  type ListingCard,
  ListingCardSchema,
  type ListingModerationStatus,
} from '@fish/contracts/listings/schema'
import type { MediaStorage } from '../uploads/storage'

/**
 * `listings` 行 → 契约卡片。放在这里而不是 `service.ts` 内部，是因为 #8 的 `/matches`
 * 也要给同一张卡片（匹配结果里的商品与 feed / 详情里的必须是同一个形状）。
 *
 * 参数类型写成结构类型而不是 `ListingRow`：调用方只要 SELECT 出这些列就能用，
 * 不需要为了映射去多查 `description` / `seller_id` 之类的字段。
 */
export type ListingCardSource = {
  id: string
  title: string
  priceCents: number
  category: ListingCard['category']
  condition: ListingCard['condition']
  status: ListingCard['status']
  urgent: boolean
  negotiable: boolean
  free: boolean
  createdAt: Date
}

/**
 * 决策 C（Issue #6）：读响应校验失败**不 500**，记日志后跳过该条——一条脏数据不该让整个列表打不开。
 * 返回 `null` 的调用方负责跳过（feed 少一条、匹配少一条）。
 *
 * `storage` 只取 `publicUrl`：「公开 URL 怎么拼」只允许有一个实现（#6 契约 §7.8）。
 *
 * `moderationStatus` 由调用方按**视角**决定：只有卖家本人视角才传真实值，公开 Feed / 匹配 /
 * 他人主页一律省略（→ `null`）。审核态不是买家该看到的信息（#74）。
 */
export function toListingCard(
  listing: ListingCardSource,
  coverObjectKey: string | null,
  storage: Pick<MediaStorage, 'publicUrl'>,
  moderationStatus: ListingModerationStatus | null = null,
): ListingCard | null {
  const card = {
    id: listing.id,
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
    moderationStatus,
  }

  const parsed = ListingCardSchema.safeParse(card)
  if (!parsed.success) {
    console.error('[listings] 跳过无法映射为契约的卡片', listing.id, parsed.error.message)
    return null
  }
  return parsed.data
}
