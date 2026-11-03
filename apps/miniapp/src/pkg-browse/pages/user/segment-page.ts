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

/**
 * 当前视图的列表数据 + 游标与三态。
 *
 * 页内切段会**整份重置**成 `emptyPage()`（#581 交互改动）：两个口径的滚动位置、游标、
 * 失败态互不继承，切过去就是从第一页重新拉，不会把上一段的游标带进新段。
 */
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
 * 首屏那一页数据从哪来（#581 复核 M8）。
 *
 * 「在售」的第一页与资料同一次请求回来（`loadPublicUserHome` 里是 `Promise.all`）；
 * 「已售出」视图**不能**拿这份在售列表充当自己的首屏 —— 那会把 TA 正在卖的东西画在
 * 「已售出」标题下面。抽成纯函数，是因为接线侧一个 `if (seg === 'ACTIVE')` 的变异
 * （改成 `if (true)`）在只读源码的用例里根本抓不住；这里逐条钉住。
 */
export function firstPageOf<T extends { id: string }>(
  seg: Segment,
  home: { listings: T[]; nextCursor: string | null },
): { items: T[]; nextCursor: string | null; loaded: boolean; loading: boolean; failed: boolean } {
  if (seg !== 'ACTIVE') {
    return { items: [], nextCursor: null, loaded: false, loading: false, failed: false }
  }
  return {
    items: home.listings,
    nextCursor: home.nextCursor,
    loaded: true,
    loading: false,
    failed: false,
  }
}

/**
 * 页面路由参数 `tab` → 列表口径（#581）。
 *
 * 只认 `'SOLD'` 一个字面量；缺省、`''`、大小写不符（`sold`）、以及任何别的值都回落到
 * 「在售」—— 页头点错了、外部链接写坏了都不该白屏，最差就是看到默认那段。
 */
export const segmentOfTab = (tab: string | undefined): Segment =>
  tab === 'SOLD' ? 'SOLD' : 'ACTIVE'

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

/**
 * 一次列表请求的「身份」：发起时的口径 + 代号（`epoch`）。
 *
 * 页内切段不换页面实例，所以**旧段在飞的请求会照常返回**。响应回来时必须能判断
 * 「这还是不是当前视图要的那一份」—— 段变了、或者中间又切过一次，整包丢掉。
 */
export type SegmentRequest = { seg: Segment; epoch: number }

/** 响应回来时还该不该写进视图：段或代号变了就是过期响应。 */
export const isCurrentRequest = (sent: SegmentRequest, live: SegmentRequest): boolean =>
  sent.seg === live.seg && sent.epoch === live.epoch

/**
 * 把一次列表响应落到当前视图状态上 —— 过期响应原样返回 `prev`，一个字段都不动。
 *
 * 这条规则必须能被用例钉住，所以放在这里：切段瞬间返回的旧段数据既不能污染新段的列表，
 * 也不能把 `loading` / `nextCursor`（`hasMore` 的来源）改掉 —— 新段自己的请求还在飞，
 * 被旧响应改写成「已加载完成」会让它连第一页都不拉。
 */
export function applySegmentPage<T extends { id: string }>(
  prev: {
    items: T[]
    nextCursor: string | null
    loaded: boolean
    loading: boolean
    failed: boolean
  },
  sent: SegmentRequest,
  live: SegmentRequest,
  page: { listings: T[]; nextCursor: string | null },
  cursor: string | null,
): {
  items: T[]
  nextCursor: string | null
  loaded: boolean
  loading: boolean
  failed: boolean
} {
  if (!isCurrentRequest(sent, live)) return prev
  return {
    ...mergeSegmentPage(prev, page, cursor),
    loaded: true,
    loading: false,
    failed: false,
  }
}
