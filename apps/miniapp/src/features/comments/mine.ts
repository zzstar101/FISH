/**
 * 「我的评论」（`pages/comments`）的纯数据与判定。
 *
 * ## 为什么这一页没有真实数据源（本轮最关键的一条口径）
 *
 * 仓库里「我发出去的话」有两种来源，**两种都没有「我发过的」聚合读路径**：
 *
 * 1. **商品留言**：契约 `@fish/contracts/comments/schema` 真实存在，读路径是
 *    `GET /listings/:listingId/comments`（#111）—— **按商品取**。
 *    `CommentListQuerySchema` 只有 `limit` / `cursor`，**没有 author 过滤**，
 *    所以不存在「我发过的留言」这个端点。
 * 2. **交易评价**：契约的 transactions 域没有 review / rating 字段，
 *    DB 的 `transactions` 也没有对应列 —— 连「评价」这个事件本身都不存在。
 *
 * 因此本页**不发任何请求**，也不做「遍历我的商品再逐条拉留言、按作者过滤」那种 N+1
 * 拼装：它既慢（商品数 × 每件一页留言）又不完整（漏掉我在**别人**商品下留的言），
 * 比空态更误导。真实构建下页面是空态 + 一句如实的缺口说明（`NO_SOURCE_COPY`）；
 * 只有演示构建（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，判据见 `./load`）才摆
 * 下面的演示数据，且界面上有可辨认的「演示数据」标注。
 *
 * ## 两条写进类型的取舍
 *
 * - **评分只属于交易评价**。商品留言在契约里就没有评分字段，所以 `rating` 是
 *   `number | null`，商品留言恒为 `null` —— 不给它默认满分（`starSlots(null)` 返回 `null`，
 *   页面因此整块不渲染星级）。
 * - **评价对象只属于交易评价**。商品留言的「对方」是卖家，但契约的留言读模型里
 *   没有这一项（`CommentDto` 只有 `author`），所以 `to` 同样只对交易评价有值。
 *
 * 本模块不 import 任何 Taro / fixture 模块，`tests/comments.test.ts` 直接加载它。
 */
import type { ListingCategory } from '@fish/contracts/listings/schema'

/**
 * 两类来源：商品留言（LISTING）/ 交易评价（TRADE）。
 *
 * 这两个值**不是契约术语**（`CommentDto` 里没有 `kind`，见文件头第 1 点），
 * 是本页按稿（`小程序1版comments.html` 的 `.kind` 分类）自立的分类。
 * 与页面分段键（`'listing' | 'trade'`）是两套值，只允许在 `segmentOf` 一处换算。
 */
export type MyCommentKind = 'LISTING' | 'TRADE'

export type MyComment = {
  id: string
  kind: MyCommentKind
  /** 缩略图色块与品类小字取自这里（色值来自 `@/mock/blocks`，不是新色） */
  category: ListingCategory
  title: string
  /** 整数分 */
  priceCents: number
  /** 我写的那句话 */
  text: string
  /** 时间文案（演示数据自带；契约没有可让前端派生的时间戳） */
  timeLabel: string
  /** 评分，**只有交易评价有**；商品留言恒为 `null`（见文件头） */
  rating: number | null
  /** 评价对象（@对方），**只有交易评价有**；商品留言恒为 `null`（见文件头） */
  to: string | null
}

/**
 * 演示数据：8 条 = 4 条商品留言 + 4 条交易评价（照 `小程序1版comments.html`）。
 *
 * 其中 2 条交易评价引用的是一笔**真实已完成的交易**（订单页 t-104 台灯 → 周予安、
 * t-106 球拍 → 许澈，我都是卖家），所以「评价对象」与订单页对得上。
 *
 * ⚠️ 另 2 条是演示占位：订单页里**已完成**的交易只有上面那两笔，「我买到的」三笔全是
 * PENDING_MEETUP（还没面交完，本来就不该能评价）。也就是说演示数据给不出第二条真实
 * 可评的成交 —— 这条口径要一并交给后端确认，别让「演示里能评、真实账户里一笔可评的
 * 都没有」变成上线后的落差。
 */
export const DEMO_MY_COMMENTS: MyComment[] = [
  {
    id: 'C01',
    kind: 'LISTING',
    category: 'DIGITAL',
    title: '索尼 WH-1000XM4 头戴降噪耳机',
    priceCents: 76000,
    text: '还在吗？我今晚下课顺路，能帮我留到八点吗',
    timeLabel: '2 小时前',
    rating: null,
    to: null,
  },
  {
    id: 'C02',
    kind: 'LISTING',
    category: 'SPORTS',
    title: '斯伯丁篮球 7 号 室内外通用',
    priceCents: 8900,
    text: '球是室内打过还是室外打的？气还足吗',
    timeLabel: '昨天 19:40',
    rating: null,
    to: null,
  },
  {
    id: 'C03',
    kind: 'LISTING',
    category: 'TRANSPORT',
    title: '捷安特 ATX 山地车 27.5 寸',
    priceCents: 42000,
    text: '车在哪栋楼？周末方便试骑一下吗',
    timeLabel: '3 天前',
    rating: null,
    to: null,
  },
  {
    id: 'C04',
    kind: 'LISTING',
    category: 'DAILY',
    title: '米家台灯 Pro 护眼版',
    priceCents: 12000,
    text: '色温有几档？宿舍桌面用会不会太亮',
    timeLabel: '上周',
    rating: null,
    to: null,
  },
  {
    id: 'C05',
    kind: 'TRADE',
    category: 'DAILY',
    title: '米家 LED 护眼台灯 可调色温',
    priceCents: 4500,
    text: '准时到了面交点，验完直接确认，很好沟通的一位同学。',
    timeLabel: '5 月 12 日',
    rating: 5,
    to: '周予安',
  },
  {
    id: 'C06',
    kind: 'TRADE',
    category: 'SPORTS',
    title: '尤尼克斯 羽毛球拍 双拍装',
    priceCents: 16000,
    text: '验货很仔细，但确认得很爽快，全程没有压价。',
    timeLabel: '5 月 6 日',
    rating: 5,
    to: '许澈',
  },
  {
    id: 'C07',
    kind: 'TRADE',
    category: 'BOOKS',
    title: '灌篮高手 完全版 1-24 全集',
    priceCents: 46000,
    text: '书收到啦，包得很仔细，成色比描述的还好。',
    timeLabel: '5 月 20 日',
    rating: 5,
    to: '苏亦然',
  },
  {
    id: 'C08',
    kind: 'TRADE',
    category: 'BEAUTY',
    title: '兰蔻小黑瓶精华 50ml 全新未拆',
    priceCents: 52000,
    text: '瓶身完好、日期也新，就是见面时间来回改了两回。',
    timeLabel: '4 月 28 日',
    rating: 4,
    to: '苏打水',
  },
]

/* ------------------------------------------------------------------ 分段 */

export type CommentSegment = 'all' | 'listing' | 'trade'

/**
 * 三段**互斥**（全部 = 商品留言 ∪ 交易评价），所以胶囊上摆计数：三个数能互相对上。
 * 收藏页的三段不互斥，那里就不摆 —— 这是「给不给计数」的判据。
 */
export const SEGMENTS: { key: CommentSegment; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'listing', label: '商品留言' },
  { key: 'trade', label: '交易评价' },
]

/** 条目 → 分段。`kind` 用契约那样的大写，分段键用短名，两者必须在这里对上。 */
export function segmentOf(kind: MyCommentKind): Exclude<CommentSegment, 'all'> {
  return kind === 'TRADE' ? 'trade' : 'listing'
}

export function inSegment(item: MyComment, segment: CommentSegment): boolean {
  return segment === 'all' || segmentOf(item.kind) === segment
}

export function filterBySegment(items: readonly MyComment[], segment: CommentSegment): MyComment[] {
  return items.filter((item) => inSegment(item, segment))
}

export function countBySegment(items: readonly MyComment[]): Record<CommentSegment, number> {
  const counts: Record<CommentSegment, number> = { all: items.length, listing: 0, trade: 0 }
  for (const item of items) counts[segmentOf(item.kind)] += 1
  return counts
}

/* ------------------------------------------------------------------ 展示量 */

/**
 * 星级槽位。`key` 给 React 列表用 —— **不用下标键**（Biome 的 `noArrayIndexKey` 会拦，
 * 而且下标键在列表重排时会让组件状态串位）。
 */
export type StarSlot = { key: string; filled: boolean }

const STAR_KEYS = ['s1', 's2', 's3', 's4', 's5'] as const

/**
 * 星级槽位（5 格，`filled` = 满格）。页面把满格映射到 `ICONS.starAccent`、
 * 空格映射到 `ICONS.starLine`（照仓库铁律：**图标只从 `@/assets/lib-icons` 取**）。
 *
 * **`null` 返回 `null`** —— 一颗都不画，既不是「0 星」也不是「5 星」：商品留言在契约里
 * 就没有评分字段，画一排星星等于替它编了一个分数（给满分尤其糟）。页面据此整块不渲染。
 *
 * 越界分数夹到 0~5，不画出多于 5 格的星。
 */
export function starSlots(rating: number | null): StarSlot[] | null {
  if (rating === null) return null
  const filled = Math.max(0, Math.min(STAR_KEYS.length, Math.round(rating)))
  return STAR_KEYS.map((key, index) => ({ key, filled: index < filled }))
}

/** 类型胶囊文案（两类各一色，一眼分出「我在别人商品下问的一句」与「交易后给的评价」）。 */
export function kindLabel(kind: MyCommentKind): string {
  return kind === 'TRADE' ? '交易评价' : '商品留言'
}

/**
 * 缩略图上的两字品类小字（稿里压在色块上，如「数码」「运动」）。
 *
 * 与 `@/mock/api` 的 `categoryLabel`（四字的「数码电子」）不是一回事：那个是**列表
 * 文案**，这是压在 76×76pt 色块里的排版字，四个字会换行溢出。所以在页面内另立一张短表，
 * **不要去改 `categoryLabel`**（首页 / 详情页 / 许愿页都在用它）。
 */
const SHORT_CATEGORY: Record<ListingCategory, string> = {
  DIGITAL: '数码',
  BOOKS: '书籍',
  DAILY: '日用',
  APPAREL: '服饰',
  SPORTS: '运动',
  TRANSPORT: '代步',
  BEAUTY: '美妆',
  OTHER: '其他',
}

export function shortCategoryLabel(category: ListingCategory): string {
  return SHORT_CATEGORY[category]
}

/**
 * 行上「查看…」按钮的文案与去向。
 *
 * 交易评价指向的是那笔订单（订单页），商品留言指向的是商品详情 —— 两者在演示态下都
 * **不真跳转**（演示 id 在库里不存在，跳过去必然 404），由页面给说明 toast。
 */
export function viewTargetOf(kind: MyCommentKind): '商品详情' | '订单详情' {
  return kind === 'TRADE' ? '订单详情' : '商品详情'
}

/* ------------------------------------------------------------------ 空态文案 */

export type EmptyCopy = { title: string; text: string; action: string }

/**
 * 演示构建下的分段空态（照稿）。**只有真拿到了数据才可以说这些** ——
 * 真实构建用的是 `NO_SOURCE_COPY`。
 */
export function emptyStateOf(segment: CommentSegment): EmptyCopy {
  switch (segment) {
    case 'listing':
      return {
        title: '没有发过商品留言',
        text: '在商品详情页的留言区说句话，就会收在这里',
        action: '看全部评论',
      }
    case 'trade':
      return {
        title: '还没有交易评价',
        text: '一笔交易完成后可以给对方评价，会收在这里',
        action: '看全部评论',
      }
    default:
      return {
        title: '还没有发过评论',
        text: '在商品下留言、或交易完成后给对方评价，都会收在这里',
        action: '去逛逛',
      }
  }
}

/**
 * 真实构建（没有聚合端点）的空态。
 *
 * **不能说「你还没有发过评论」**：系统根本读不到我发过什么，那是把「不知道」说成
 * 一个业务事实。这里如实说清缺的是哪一段能力。
 */
export const NO_SOURCE_COPY: EmptyCopy = {
  title: '暂时看不到你的评论',
  text: '「我发过的评论」还没有后端聚合接口：商品留言只能按商品一条条读，交易评价也还没有对应的记录，所以这里暂时是空的。',
  action: '去逛逛',
}

/* ------------------------------------------------------------------ 演示开关 */

/**
 * 演示数据开关的**纯判定**：两个开关必须同时成立。
 *
 * 抽成纯函数是为了能被 `bun test` 直接覆盖四种组合 —— `load.ts` 走的是
 * `@/features/load-failure` → `@/lib/request`，那条链在模块求值阶段就读 Taro 注入的
 * 全局量，测试里要先顶掉 Taro 才 import 得动（见 `tests/order-list-state.test.ts` 的手法）。
 * 判定逻辑本身与那两个模块无关，放在这里测更直接。
 *
 * 为什么是「与」而不是只看 `MOCK_FALLBACK_ENABLED`（方案 §2.3 明写的一条）：
 * `__ALLOW_MOCK_FALLBACK__` 在 `dev:weapp` 的日常开发里也是 true（注入式含
 * `NODE_ENV === 'development'`），只认它会让演示数据顶掉真实空态 —— 而真实空态正是
 * 这一页在真实构建下的**唯一**形态。
 */
export function demoCommentsEnabled(mockFallback: boolean, demoAuth: boolean): boolean {
  return mockFallback && demoAuth
}
