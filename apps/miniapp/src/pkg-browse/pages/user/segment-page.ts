/**
 * 他人主页「在售 / 已售出」分段列表的**纯状态迁移**（#565，无 Taro、无请求：
 * `tests/user-list-end.test.ts` 直接 import）。
 *
 * 合并规则本身就是两个坑的答案，所以从页面里抽出来用纯函数钉住，页面里只剩「什么时候发请求」：
 *
 * - **同一条游标被并发打两次**（同一帧连点两次滚到底，或切段与滚底撞在同一帧）：抢输的那份
 *   响应仍会回来，必须按 `id` 去重，否则同一页会被追加两遍、列表里出现两张一模一样的卡。
 *   去重按商品主键而不是位置 —— 时间线可能因为别人刚上架而整体平移。
 * - **首屏覆盖 / 续页追尾**：`cursor === null` 是第一页，语义是覆盖；
 *   `cursor !== null` 是下一页，语义是追尾，不能把已展示的旧页吃掉。
 */
import type { MockListing } from '@/mock/types'

/**
 * 列表分段：取值域与契约 `PublicUserListingsQuerySchema.status` 逐字对齐。
 *
 * 两段都是同一个读端点 `GET /users/:userId/listings`，只差一个 `status` ——
 * 服务端对 OFFLINE / RESERVED 一律 422，所以这里也只有这两个值。
 */
export type Segment = 'ACTIVE' | 'SOLD'

/** 一段的列表数据 + 它自己的游标与加载态（两段各自独立：切回已拉过的段不再请求） */
export type SegmentPage = {
  items: MockListing[]
  /** 服务端游标：`null` 表示这一段已经没有下一页了（唯一权威信号，条数不参与判断） */
  nextCursor: string | null
  /** 是否已成功拉过第一页 —— 决定切过去时要不要发请求 */
  loaded: boolean
  loading: boolean
  failed: boolean
}

export const emptyPage = (): SegmentPage => ({
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  failed: false,
})

/**
 * 把一页响应合进某一段，返回新的条目与游标（`loaded` / `loading` / `failed` 由页面自己改）。
 *
 * 泛型只要求「有条目主键」，纯函数用例可以直接拿 `{ id }` 造样本，不必拼一份完整的
 * `MockListing`。
 */
export function mergeSegmentPage<T extends { id: string }>(
  prev: { items: T[] },
  page: { listings: T[]; nextCursor: string | null },
  cursor: string | null,
): { items: T[]; nextCursor: string | null } {
  if (cursor === null) return { items: page.listings, nextCursor: page.nextCursor }
  const seen = new Set(prev.items.map((item) => item.id))
  const incoming = page.listings.filter((item) => !seen.has(item.id))
  return { items: [...prev.items, ...incoming], nextCursor: page.nextCursor }
}
