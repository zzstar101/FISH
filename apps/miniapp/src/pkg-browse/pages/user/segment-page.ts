import type { MockListing } from '@/mock/types'

/**
 * 他人主页「在售 / 已售出」分段的纯状态（#565 → #581）。
 *
 * 三个纯函数：视图状态的形状、一页怎么合并进现有列表、首屏那一页从哪来。
 * 发请求、判重入、判过期都在页面里（`index.tsx` 的 `loadSegment`），这里不碰时序。
 */

/** 他人主页的两个分段：在售 / 已售出。取值域与契约 `PublicUserListingsQuerySchema.status` 逐字对齐。 */
export type Segment = 'ACTIVE' | 'SOLD'

/** 一段列表的视图状态。 */
export type SegmentPage<T extends { id: string } = MockListing> = {
  items: T[]
  nextCursor: string | null
  /** 首屏那一页已经到了。切段时整份重置回假，由页面「空页就补第一页」的 effect 接手。 */
  loaded: boolean
  loading: boolean
  failed: boolean
}

/** 空段（未加载）。页内切段就是整份重置成它。 */
export const emptyPage = <T extends { id: string } = MockListing>(): SegmentPage<T> => ({
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  failed: false,
})

/** 读取层交回来的一页（不含视图三态）。 */
export type SegmentPageSnapshot<T extends { id: string }> = {
  listings: T[]
  nextCursor: string | null
}

/** 页面加载态（与 `index.tsx` 的 `loadState` 取值域一致）。 */
export type UserHomeLoadState = 'loading' | 'ok' | 'notFound' | 'failed'

/**
 * 该不该为当前分段补拉第一页。
 *
 * 「任何一段只要是空页」都在这里补：切段后整份重置成 `emptyPage()`、以及深链直接进
 * 「已售出」两种情形都走这条路 —— 所以**不许**在这里看口径（写成「只有 SOLD 才补」会
 * 让切回在售的分段永远空着）。`failed` 也挡住自动补拉：失败后只认用户点「重试」，
 * 否则每次重渲染都会再打一次接口。
 */
export const shouldRefetch = (
  loadState: UserHomeLoadState,
  page: { loaded: boolean; loading: boolean; failed: boolean },
): boolean => loadState === 'ok' && !page.loaded && !page.loading && !page.failed

/** 页头与列表共用的那两个数（服务端给的 `activeCount` / `soldCount`）。 */
export type UserCounts = { activeCount: number; soldCount: number }

/**
 * 当前分段的**真总数**：在售段用 `activeCount`、已售出段用 `soldCount`。
 * 列表是分页的，拿已加载条数冒充会在还没加载完时低报，所以页头计数与列表尾注都走它。
 */
export const totalOf = (seg: Segment, profile: UserCounts | null): number =>
  seg === 'ACTIVE' ? (profile?.activeCount ?? 0) : (profile?.soldCount ?? 0)

/** 分段名的唯一来源（分段标题、空态「TA 暂无…商品」、列表失败文案都用它）。 */
export const segTitleOf = (seg: Segment): string => (seg === 'ACTIVE' ? '在售' : '已售出')

/** 深链 `?tab=` 只决定首屏停在哪个分段，非法值一律回落在售。 */
export const segmentOfTab = (tab: string | undefined): Segment =>
  tab === 'SOLD' ? 'SOLD' : 'ACTIVE'

/**
 * 把一页合并进现有列表。
 *
 * `cursor === null` 是首屏 / 重取：整份覆盖；否则是续页：按 id 去重后追尾（同一条游标被
 * 并发打两次时，迟到的同页响应不会追加第二遍）。游标始终取读取层刚交回的那一个 ——
 * 它是「还有没有下一页」的唯一权威信号。
 */
export function mergeSegmentPage<T extends { id: string }>(
  prev: { items: T[] },
  page: SegmentPageSnapshot<T>,
  cursor: string | null,
): { items: T[]; nextCursor: string | null } {
  if (cursor === null) return { items: page.listings, nextCursor: page.nextCursor }

  const seen = new Set(prev.items.map((item) => item.id))
  const items = [...prev.items]
  for (const listing of page.listings) {
    if (seen.has(listing.id)) continue
    seen.add(listing.id)
    items.push(listing)
  }
  return { items, nextCursor: page.nextCursor }
}

/**
 * 首屏那一页从哪来。他人主页每次都会顺带取回「在售」的第一页（`loadPublicUserHome`），
 * 所以只有在售段有首屏；已售出段拿到空页，由页面「空页就补第一页」的 effect 自己发请求。
 */
export function firstPageOf<T extends { id: string }>(
  seg: Segment,
  home: SegmentPageSnapshot<T>,
): SegmentPage<T> {
  if (seg !== 'ACTIVE') return emptyPage<T>()
  return {
    items: home.listings,
    nextCursor: home.nextCursor,
    loaded: true,
    loading: false,
    failed: false,
  }
}
