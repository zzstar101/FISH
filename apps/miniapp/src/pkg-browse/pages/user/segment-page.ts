import type { MockListing } from '@/mock/types'

/**
 * 他人主页「在售 / 已售出」的分段状态与加载器（#565 → #581 → #582）。
 *
 * 这一段代码只做四件事，全部是纯函数或可注入依赖的工厂，页面只负责「什么时候发请求、
 * 结果怎么落进 state」：
 *
 * 1. 口径（`Segment`）与一页分段列表的状态形状（`SegmentPage`）；
 * 2. 一页数据怎么合并进现有列表（`mergeSegmentPage`：首屏覆盖、续页按 id 去重追尾）；
 * 3. 首屏那一页从哪来（`firstPageOf`：只有「在售」段用他人主页随 profile 一起回来的
 *    那一页，「已售出」段要自己发请求）；
 * 4. 在途请求的「还算不算数」判定（`SegmentRequest` / `isCurrentRequest`）与把判定包好的
 *    加载器（`makeSegmentLoader`）。
 *
 * 第 4 点是页内切段唯一的正确性卖点：切段那一刻可能还有旧段的请求在飞，它的响应回来时
 * 既不能写进新段，也不能替新段把闩还回去。这两条只靠两行代码撑着 —— `live()` 实时读
 * 当前口径与代号、`finally` 只由自己那一份归还闩 —— 所以逻辑不能散在页面里，
 * 否则删掉任何一行都不会有用例变红。把它抽成 `makeSegmentLoader` 之后，
 * `tests/user-page-tabs.test.ts` 能用挂起的 promise 把时序真的跑一遍。
 */

/** 他人主页的两个分段：在售 / 已售出。 */
export type Segment = 'ACTIVE' | 'SOLD'

/** 一段列表的视图状态。 */
export type SegmentPage<T extends { id: string } = MockListing> = {
  items: T[]
  nextCursor: string | null
  /**
   * 这一段的「第几页」口径已经定下来了：`load()` 填首屏时置真（只有「在售」段会置真，
   * 「已售出」段要等补拉 effect 自己去取）、页内切段时整份重置回假、补拉 effect 只看它。
   */
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

/**
 * 深链参数决定首屏停在哪个分段。外部带进来的 `?tab=` 只做**初值**，
 * 页内点页头两格切段不再写 URL 参数；非法值一律回落在售。
 */
export const segmentOfTab = (tab: string | undefined): Segment =>
  tab === 'SOLD' ? 'SOLD' : 'ACTIVE'

/** 一次请求的身份证：发起时的口径 + 页面代次。 */
export type SegmentRequest = { seg: Segment; epoch: number }

/** 回来的响应「还算不算数」：口径换了算过期，同段重载（代号变了）也算过期。 */
export const isCurrentRequest = (sent: SegmentRequest, live: SegmentRequest): boolean =>
  sent.seg === live.seg && sent.epoch === live.epoch

/**
 * 把一页数据合并进现有列表。
 *
 * `cursor === null` 是首屏 / 重取：整份覆盖；否则是续页：按 id 去重后追尾（迟到的同页
 * 响应不会把同一批条目追加第二遍）。两种情况都把 `nextCursor` 换成读取层刚交回的游标 ——
 * 游标是「还有没有下一页」的唯一权威信号。
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
 * 首屏那一页从哪来。他人主页每开一次都会顺带取回「在售」的第一页
 * （`loadPublicUserHome`），所以游标已经在手上；「已售出」段不在这条请求里，
 * 由页面的补拉 effect 自己发请求。
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

/**
 * 把一页写回分段状态。过期响应**原样返回 `prev`**（引用相等，不是值相等）：旧段的列表、
 * 游标、`loading` / `loaded` / `failed` 一个字段都不动 —— 新段自己的请求还在飞，
 * 旧响应连「把 loading 改回 false」的资格都没有。
 */
export function applySegmentPage<T extends { id: string }>(
  prev: SegmentPage<T>,
  sent: SegmentRequest,
  live: SegmentRequest,
  page: SegmentPageSnapshot<T>,
  cursor: string | null,
): SegmentPage<T> {
  if (!isCurrentRequest(sent, live)) return prev
  return {
    ...mergeSegmentPage(prev, page, cursor),
    loaded: true,
    loading: false,
    failed: false,
  }
}

/** 一次 `load()` 的结局。 */
export type SegmentLoadOutcome = 'busy' | 'stale' | 'applied' | 'missing' | 'failed'

/** 一次 `load()` 的落地回调；页面只在这里碰 state。 */
export type SegmentLoadHandlers<T extends { id: string }> = {
  onStart?: () => void
  onPage: (sent: SegmentRequest, page: SegmentPageSnapshot<T>, cursor: string | null) => void
  onMissing: () => void
  onFailed: (sent: SegmentRequest, error: unknown) => void
}

/** 加载器的外部依赖：当前口径 / 代次由页面注入（同步镜像），取数由读取层注入。 */
export type SegmentLoaderDeps<T extends { id: string }> = {
  getSeg: () => Segment
  getEpoch: () => number
  fetch: (seg: Segment, cursor: string | null) => Promise<SegmentPageSnapshot<T> | null>
}

export type SegmentLoader<T extends { id: string }> = {
  /** 切段 / 重载时放开闩：上一轮的请求作废，新段立刻能发。 */
  release: () => void
  load: (cursor: string | null, handlers: SegmentLoadHandlers<T>) => Promise<SegmentLoadOutcome>
}

/**
 * 分段列表加载器：一把同步闩（同一时刻只允许一条在途请求）+ 每次请求的身份证校验。
 *
 * `load()` 的时序：
 * - 闩已占用 → `'busy'`（滚到底的回调读的是渲染快照，不能靠 `loading` 决定要不要发）；
 * - 先同步占闩，再取身份证 `sent`，然后 `onStart`、取数；
 * - 响应回来先比对身份：不一致就是 `'stale'`，一个回调都不调；
 * - `page === null` 是「这个人不存在 / 被删」（读取层的 404 折叠成 null）→ `onMissing`；
 * - `finally` 只由身份仍然有效的那一份归还闩 —— 旧段的成败不许替新段解锁。
 */
export function makeSegmentLoader<T extends { id: string }>(
  deps: SegmentLoaderDeps<T>,
): SegmentLoader<T> {
  let inFlight = false
  const live = (): SegmentRequest => ({ seg: deps.getSeg(), epoch: deps.getEpoch() })

  return {
    release: () => {
      inFlight = false
    },
    load: async (cursor, handlers) => {
      if (inFlight) return 'busy'
      inFlight = true
      const sent = live()
      handlers.onStart?.()
      try {
        const page = await deps.fetch(sent.seg, cursor)
        if (!isCurrentRequest(sent, live())) return 'stale'
        if (page === null) {
          handlers.onMissing()
          return 'missing'
        }
        handlers.onPage(sent, page, cursor)
        return 'applied'
      } catch (error) {
        if (!isCurrentRequest(sent, live())) return 'stale'
        handlers.onFailed(sent, error)
        return 'failed'
      } finally {
        if (isCurrentRequest(sent, live())) inFlight = false
      }
    },
  }
}
