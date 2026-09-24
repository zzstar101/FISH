/**
 * 愿望域契约 → 页面视图的投影。
 *
 * 与 `features/listing/adapt.ts` 同一取舍：页面（`pages/wish`、`pages/wish-publish`）
 * 读的是 `MockWish` / `MockWishPoolItem` 的字段集合（#138 已验收，不再改版），
 * 所以这里做一次显式投影 —— 契约给得了的用真值，给不了的显式留空：
 *
 * - `timeLabel`：由契约的 `createdAt` 现算相对时间；
 * - `userId`：许愿页 / 发布页拿到的都是本人的愿望，用不到所有者 id → 空串。
 */
import type { WishDto, WishPoolItem } from '@fish/contracts/wishes/schema'
import type { MockWish, MockWishPoolItem } from '@/mock/types'

/** 相对时间文案（列表行口径：「N 分钟前 / N 小时前 / N 天前」） */
export function relativeLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const hours = Math.max(0, (now - at) / 3600000)
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function toMockWish(wish: WishDto): MockWish {
  return {
    id: wish.id,
    // 契约不返回「所有者是不是我」之外的用途；这几页全是本人的愿望
    userId: '',
    keyword: wish.keyword,
    category: wish.category,
    budgetMinCents: wish.budgetMinCents,
    budgetMaxCents: wish.budgetMaxCents,
    description: wish.description,
    acceptSimilar: wish.acceptSimilar,
    status: wish.status,
    matchCount: wish.matchCount,
    createdAt: wish.createdAt,
    // 相对时间由契约的 createdAt 现算
    timeLabel: relativeLabel(wish.createdAt),
  }
}

export function toMockWishPoolItem(item: WishPoolItem): MockWishPoolItem {
  return {
    keyword: item.keyword,
    category: item.category,
    wantCount: item.wantCount,
    medianBudgetCents: item.medianBudgetCents,
  }
}
