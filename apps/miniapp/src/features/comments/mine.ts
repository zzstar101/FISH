/**
 * 「我的评论」（`pages/comments`）的纯数据与判定（#195 页面半边）。
 *
 * ## 数据源（#195 PR1/PR2 已合入 main）
 *
 * `GET /me/comments` 单端点 + `kind` 过滤（`all` = 留言 ∪ 评价跨表合并 / `comment` /
 * `review`），响应 `{ items, nextCursor, total }`；`items` 是**判别联合**：留言行
 * `{ comment, listing }`、评价行 `{ review, transaction }`，两个 `toMyCommentFrom*`
 * 适配器把两种行折成页面统一的 `MyComment`。删留言走 `DELETE /comments/:id`，
 * 删评价走交易域评价边 `DELETE /transactions/:id/review`（资源身份是「(我, 这笔交易)」，
 * 评价行没记住评价 id 也不需要 —— 交易 id 就是地址）。
 *
 * ## 三档评分，不是 1–5 星（#195 冻结口径）
 *
 * 评分是 `POSITIVE / NEUTRAL / NEGATIVE` 枚举（`TransactionReviewRatingSchema`），
 * 不是连续星级 —— #196 当年按稿画的五颗星在真实数据下没有出处（好评画 5 星是把
 * 「档位」编造成「分数」）。展示用 `ratingChipOf` 给出「好评 / 中评 / 差评」胶囊；
 * 商品留言在契约里就没有评分字段，`rating` 恒为 `null`，胶囊整块不渲染。
 *
 * ## 行跳转用真实 id，删除落在真实写端点上
 *
 * 留言行跳商品详情（`comment.listingId`），评价行跳面交/订单页（`transaction.id`，
 * 该页能渲染 COMPLETED 终态卡）。两条行都带 `deleteRef`（留言 → 评论域删除；
 * 评价 → 评价边删除）；演示行两者皆 `null` —— 演示 id 在库里不存在，照旧给说明 toast。
 *
 * 本模块不 import 任何 Taro / fixture 模块（`dayLabelOf` 除外），`tests/comments.test.ts` 直接加载它。
 */
import type { MyCommentItem, MyCommentsKind } from '@fish/contracts/comments/schema'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import type {
  TransactionReviewItem,
  TransactionReviewRating,
} from '@fish/contracts/transaction-reviews/schema'
import { dayLabelOf } from '@/lib/time'

/**
 * 两类来源：商品留言（LISTING）/ 交易评价（TRADE）。
 *
 * 这两个值**不是契约术语**（响应的判别键是 `comment` / `review`），
 * 是本页按稿（`小程序1版comments.html` 的 `.kind` 分类）自立的分类。
 * 与页面分段键（`'listing' | 'trade'`）是两套值，只允许在 `segmentOf` 一处换算。
 */
export type MyCommentKind = 'LISTING' | 'TRADE'

/** 行上删除动作的写目标。`null` = 不可删（演示行）。 */
export type MyCommentDeleteRef =
  | { type: 'comment'; commentId: string }
  | { type: 'review'; transactionId: string }

export type MyComment = {
  id: string
  kind: MyCommentKind
  /**
   * 品类（缩略图色块与品类小字）。**评价行可能没有**：交易 DTO 内嵌的商品摘要
   * （`transactionListingSchema`）没有分类字段 —— 为 `null` 时不画品类小字、色块退回 OTHER。
   */
  category: ListingCategory | null
  title: string
  /** 整数分。留言行 = 挂价；评价行 = `transaction.amountCents`（成交价）。 */
  priceCents: number
  /** 商品封面（真实数据才有；`null` 退回品类色块，与列表卡的占位口径一致）。 */
  coverUrl: string | null
  /** 我写的那句话。评价行可能是空串（「只打分没写字」是契约明说的正常形态）。 */
  text: string
  timeLabel: string
  /** 三档评分，**只有交易评价有**；商品留言恒为 `null`（见文件头）。 */
  rating: TransactionReviewRating | null
  /** 评价对象（@对方），**只有交易评价有**；商品留言恒为 `null`（见文件头）。 */
  to: string | null
  /** 行跳转目标 id（真实数据才有）：留言行 = listingId；评价行 = transactionId。 */
  targetId: string | null
  /** 删除动作的写目标（真实数据才有；演示行恒 `null`，见文件头）。 */
  deleteRef: MyCommentDeleteRef | null
}

/**
 * 演示数据：8 条 = 4 条商品留言 + 4 条交易评价（照 `小程序1版comments.html`）。
 *
 * 只在演示构建（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，判据见 `./load`）使用，
 * 界面上有可辨认的「演示数据」标注；行不带 `targetId` / `deleteRef`（跳转与删除给说明 toast）。
 * 演示评分同步改成三档档位：原稿 5 星的三条 = 好评；兰蔻那条原稿 4 星带一句抱怨，落到中评档。
 */
export const DEMO_MY_COMMENTS: MyComment[] = [
  {
    id: 'C01',
    kind: 'LISTING',
    category: 'DIGITAL',
    title: '索尼 WH-1000XM4 头戴降噪耳机',
    priceCents: 76000,
    coverUrl: null,
    text: '还在吗？我今晚下课顺路，能帮我留到八点吗',
    timeLabel: '2 小时前',
    rating: null,
    to: null,
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C02',
    kind: 'LISTING',
    category: 'SPORTS',
    title: '斯伯丁篮球 7 号 室内外通用',
    priceCents: 8900,
    coverUrl: null,
    text: '球是室内打过还是室外打的？气还足吗',
    timeLabel: '昨天 19:40',
    rating: null,
    to: null,
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C03',
    kind: 'LISTING',
    category: 'TRANSPORT',
    title: '捷安特 ATX 山地车 27.5 寸',
    priceCents: 42000,
    coverUrl: null,
    text: '车在哪栋楼？周末方便试骑一下吗',
    timeLabel: '3 天前',
    rating: null,
    to: null,
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C04',
    kind: 'LISTING',
    category: 'DAILY',
    title: '米家台灯 Pro 护眼版',
    priceCents: 12000,
    coverUrl: null,
    text: '色温有几档？宿舍桌面用会不会太亮',
    timeLabel: '上周',
    rating: null,
    to: null,
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C05',
    kind: 'TRADE',
    category: 'DAILY',
    title: '米家 LED 护眼台灯 可调色温',
    priceCents: 4500,
    coverUrl: null,
    text: '准时到了面交点，验完直接确认，很好沟通的一位同学。',
    timeLabel: '8 月 21 日',
    rating: 'POSITIVE',
    to: '周予安',
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C06',
    kind: 'TRADE',
    category: 'SPORTS',
    title: '尤尼克斯 羽毛球拍 双拍装 含拍包',
    priceCents: 16000,
    coverUrl: null,
    text: '验货很仔细，但确认得很爽快，全程没有压价。',
    timeLabel: '8 月 14 日',
    rating: 'POSITIVE',
    to: '许澈',
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C07',
    kind: 'TRADE',
    category: 'BOOKS',
    title: '灌篮高手 完全版 1-24 全集',
    priceCents: 46000,
    coverUrl: null,
    text: '书收到啦，包得很仔细，成色比描述的还好。',
    timeLabel: '5 月 20 日',
    rating: 'POSITIVE',
    to: '橙子',
    targetId: null,
    deleteRef: null,
  },
  {
    id: 'C08',
    kind: 'TRADE',
    category: 'BEAUTY',
    title: '兰蔻小黑瓶精华 50ml 全新未拆',
    priceCents: 52000,
    coverUrl: null,
    text: '瓶身完好、日期也新，就是见面时间来回改了两回。',
    timeLabel: '4 月 28 日',
    rating: 'NEUTRAL',
    to: '苏打水',
    targetId: null,
    deleteRef: null,
  },
]

/* ---------------------------------------------------------- 真实数据适配器 */

/**
 * 留言行 `{ comment, listing }` → 页面行。跳商品详情，删除走评论域。
 * 时间文案与其它页同一把尺子（`dayLabelOf`，一屏共用同一个 `nowMs`）。
 */
export function toMyCommentFromCommentItem(item: MyCommentItem, nowMs: number): MyComment {
  return {
    id: item.comment.id,
    kind: 'LISTING',
    category: item.listing.category,
    title: item.listing.title,
    priceCents: item.listing.priceCents,
    coverUrl: item.listing.coverUrl,
    text: item.comment.content,
    timeLabel: dayLabelOf(item.comment.createdAt, nowMs),
    rating: null,
    to: null,
    targetId: item.comment.listingId,
    deleteRef: { type: 'comment', commentId: item.comment.id },
  }
}

/**
 * 评价行 `{ review, transaction }` → 页面行。跳面交/订单页（该页能渲染 COMPLETED 终态），
 * 删除走评价边。挂价与成交价不是一回事：这里展示**成交价** `transaction.amountCents`。
 */
export function toMyCommentFromReviewItem(item: TransactionReviewItem, nowMs: number): MyComment {
  return {
    id: item.review.id,
    kind: 'TRADE',
    category: null,
    title: item.transaction.listing.title,
    priceCents: item.transaction.amountCents,
    coverUrl: item.transaction.listing.coverUrl,
    text: item.review.body ?? '',
    timeLabel: dayLabelOf(item.review.createdAt, nowMs),
    rating: item.review.rating,
    to: item.transaction.counterpart.nickname,
    targetId: item.transaction.id,
    deleteRef: { type: 'review', transactionId: item.transaction.id },
  }
}

/** 判别联合分流：留言行有 `comment` 键、评价行有 `review` 键，形状互斥。 */
export function toMyCommentFromResponseItem(
  item: MyCommentItem | TransactionReviewItem,
  nowMs: number,
): MyComment {
  return 'comment' in item
    ? toMyCommentFromCommentItem(item, nowMs)
    : toMyCommentFromReviewItem(item, nowMs)
}

/* ------------------------------------------------------------------ 分段 */

export type CommentSegment = 'all' | 'listing' | 'trade'

/**
 * 三段**互斥**（全部 = 商品留言 ∪ 交易评价），所以胶囊上摆计数：三个数能互相对上。
 * 收藏页的三段不互斥，那里就不摆 —— 这是「给不给计数」的判据。
 *
 * 真实构建的计数来自服务端 `total`（同 kind 口径的全量数，契约保证 `kind=all` 时
 * `total = 留言数 + 评价数`）；`countBySegment` 只服务演示构建的本地数组。
 */
export const SEGMENTS: { key: CommentSegment; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'listing', label: '商品留言' },
  { key: 'trade', label: '交易评价' },
]

/** 分段 → `/me/comments` 的 `kind` 档位。两套键只在这一处换算。 */
export function kindOfSegment(segment: CommentSegment): MyCommentsKind {
  switch (segment) {
    case 'listing':
      return 'comment'
    case 'trade':
      return 'review'
    default:
      return 'all'
  }
}

/** 条目 → 分段。`kind` 用页面的大写值，分段键用短名，两者必须在这里对上。 */
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

/** 评分胶囊：三档各自的文案与色调（`cls` 挂到页面的色修饰类上）。 */
export type RatingChip = { label: string; cls: string }

const RATING_CHIPS: Record<TransactionReviewRating, RatingChip> = {
  POSITIVE: { label: '好评', cls: 'is-pos' },
  NEUTRAL: { label: '中评', cls: 'is-mid' },
  NEGATIVE: { label: '差评', cls: 'is-neg' },
}

/**
 * 三档评分的展示胶囊。**`null` 返回 `null`** —— 一颗都不画、一个字都不标：
 * 商品留言在契约里就没有评分字段，给它标档位等于替它编了一个评分（给好评尤其糟）。
 * 页面据此整块不渲染。
 */
export function ratingChipOf(rating: TransactionReviewRating | null): RatingChip | null {
  if (rating === null) return null
  return RATING_CHIPS[rating]
}

/** 类型胶囊文案（两类各一色，一眼分出「我在别人商品下问的一句」与「交易后给的评价」）。 */
export function kindLabel(kind: MyCommentKind): string {
  return kind === 'TRADE' ? '交易评价' : '商品留言'
}

/**
 * 缩略图上的两字品类小字（稿里压在色块上，如「数码」「运动」）。
 *
 * 与 `@/mock/api` 的 `categoryLabel`（四字的「数码电子」）不是一回事：那个是**列表
 * 文案**，这是压在色块里的排版字，四个字会换行溢出。所以在页面内另立一张短表，
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
 * 交易评价指向的是那笔订单（面交页能渲染 COMPLETED 终态卡），商品留言指向的是商品详情 ——
 * 演示态下都**不真跳转**（演示行没有 `targetId`），由页面给说明 toast。
 */
export function viewTargetOf(kind: MyCommentKind): '商品详情' | '订单详情' {
  return kind === 'TRADE' ? '订单详情' : '商品详情'
}

/* ------------------------------------------------------------------ 空态文案 */

export type EmptyCopy = { title: string; text: string; action: string }

/**
 * 分段空态。演示构建与真实构建共用这三支（真实数据下分段空了就是真的没有）——
 * #196 时代的「真实构建恒走缺口说明」那一档已随 #195 接线删除。
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

/* ------------------------------------------------------------------ 演示开关 */

/**
 * 演示数据开关的**纯判定**：两个开关必须同时成立。
 *
 * 抽成纯函数是为了能被 `bun test` 直接覆盖四种组合 —— 页面走的是
 * `@/features/load-failure` → `@/lib/request`，那条链在模块求值阶段就读 Taro 注入的
 * 全局量，测试里要先顶掉 Taro 才 import 得动（见 `tests/order-list-state.test.ts` 的手法）。
 * 判定逻辑本身与那两个模块无关，放在这里测更直接。
 *
 * 为什么是「与」而不是只看 `MOCK_FALLBACK_ENABLED`（方案 §2.3 明写的一条）：
 * `__ALLOW_MOCK_FALLBACK__` 在 `dev:weapp` 的日常开发里也是 true（注入式含
 * `NODE_ENV === 'development'`），只认它会让演示数据顶掉真实数据 —— 真实构建
 * （含 dev:weapp）现在有真接口，必须走真实路径。
 */
export function demoCommentsEnabled(mockFallback: boolean, demoAuth: boolean): boolean {
  return mockFallback && demoAuth
}

/** `/me/comments` 的 kind 档位类型（从契约转出口，页面与 api 共用）。 */
export type { MyCommentsKind } from '@fish/contracts/comments/schema'
