/**
 * 识图结果页的**派生逻辑**（Taro-free，可单测）。
 *
 * 三块：查询图卡的识别结论文案、统计行（在售同款 / 价格区间 / 同类成交均价）、
 * 排序胶囊「中文标签 ↔ 契约 sort 码」的映射。抽出来的理由同仓内其它 `view.ts`：
 * 这些判据写进页面组件就没人能钉住，而它们都有「看起来对、实际错」的写法
 * （比如把「识别中」的统计位写成 0 件、把 2 件样本的均价当成行情）。
 *
 * **排序是服务端做的**（#324 M6）：契约 `VisualSearchRequestSchema` 带**可选** `sort`
 * （`packages/contracts/src/visual/schema.ts`），服务端在**截断到 30 条之前**排序 ——
 * 「最新 / 最便宜」是全局前 30 条，不是对已返回那 30 条的本地重排。
 * 所以本文件**没有任何本地重排**：页面切档 = 换一个 sort 码重新请求，
 * 「综合」就是缺省 `relevance`。
 */
import type { ListingCard, ListingCategory } from '@fish/contracts/listings/schema'
import {
  VISUAL_SEARCH_SORTS,
  VISUAL_SOLD_AVG_MIN_SAMPLES,
  type VisualInterpretation,
  type VisualSearchSort,
  type VisualSearchStats,
} from '@fish/contracts/visual/schema'
import { formatAmount } from '@/lib/money'
import { categoryLabel } from '@/mock/api'

/** 查询图卡的文案（稿 01 的默认态 / 05 的 `interpretation === null` 变体）。 */
export type QueryCardCopy = {
  /** 分类胶囊文案；没有识别出分类时为 `null`（整枚不渲染） */
  category: string | null
  /** 标题行：识别出的型号 / 品牌 / 文字，识别不出就是一句说明 */
  title: string
  /** 副行：关键词或一句说明 */
  subtitle: string
}

/** 识别不出文字时的固定文案（稿 05） */
const NO_INTERPRETATION: QueryCardCopy = {
  category: null,
  title: '只看图找同款',
  subtitle: '没读出图里的文字，按图片相似度匹配',
}

/**
 * 分类中文名。
 *
 * **直接用 `mock/api.ts` 的 `categoryLabel`**（而不是自己再抄一份 8 项中文表）：
 * 另抄一份只会多出一个「同值不同源」的漂移点 —— 分类口径变化时两边不会一起动。
 *
 * `mock/` 是 Taro-free 的纯数据模块（`git grep @tarojs apps/miniapp/src/mock` 无命中），
 * 本文件因此在 `tests/` 里可以直接 import。
 */
export function categoryText(category: ListingCategory): string {
  return categoryLabel(category)
}

/**
 * `interpretation` → 查询图卡文案。
 *
 * 标题的取值顺序是**型号 → 品牌 → 原文**：型号最具体（AirPods Pro 2），品牌次之（Apple），
 * 都没有才退回整段识别文字 —— 反过来会让「Apple」盖住更准的型号。都没有时（含
 * `interpretation === null`）就是「只看图找同款」，不编造结论。
 */
export function queryCardCopy(interpretation: VisualInterpretation | null): QueryCardCopy {
  if (interpretation === null) return NO_INTERPRETATION

  const title = interpretation.model ?? interpretation.brand ?? interpretation.text ?? null
  const keywords = interpretation.keywords ?? []
  const subtitle =
    keywords.length > 0 ? `关键词 ${keywords.join(' · ')}` : (interpretation.text ?? '')
  const category = interpretation.category ? categoryText(interpretation.category) : null

  if (title === null) {
    // 有 category / keywords 但没有型号与品牌：给一句说明而不是留空行
    return {
      category,
      title: NO_INTERPRETATION.title,
      subtitle: subtitle || NO_INTERPRETATION.subtitle,
    }
  }

  return { category, title, subtitle }
}

/**
 * 本次结果的两个统计（稿 03 里空态写 `0 件`、价格区间给 `—`）。
 *
 * 只有「在售同款 / 价格区间」——它们是从**本次返回的 items** 派生的。
 * 「同类成交均价」不在里面：它来自契约 `stats`（服务端按解析出的类目查库），
 * 与本次结果无关（没有结果也可能有行情），见 `soldAvgText`。
 */
export type ResultStats = {
  count: number
  /** 价格区间（分）；空结果时为 `null`，页面渲染成 `—` */
  priceMinCents: number | null
  priceMaxCents: number | null
}

/** 结果统计。空数组时价格区间为 `null` —— 不把「没有结果」说成「¥0–¥0」。 */
export function resultStats(items: ListingCard[]): ResultStats {
  if (items.length === 0) return { count: 0, priceMinCents: null, priceMaxCents: null }
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (const item of items) {
    if (item.priceCents < min) min = item.priceCents
    if (item.priceCents > max) max = item.priceCents
  }
  return { count: items.length, priceMinCents: min, priceMaxCents: max }
}

/**
 * 排序胶囊的中文标签。
 *
 * `Record<VisualSearchSort, string>` 而不是 `{ label, sort }[]` 字面量数组：
 * 契约给 `VISUAL_SEARCH_SORTS` 加第六档时，这里**编译期**就缺一个键而报错，
 * 不会静默少一档；数组字面量抄一份则两边各自漂移（这正是本页旧的
 * 「综合/最新/价格/成色」四档与契约五档对不上的原因）。
 */
const SORT_LABEL: Record<VisualSearchSort, string> = {
  relevance: '综合',
  popular: '热销',
  newest: '最新',
  price_asc: '价格',
  condition: '成色',
}

/** 排序胶囊的一项：展示用中文标签 + 请求体里的契约 sort 码 */
export type VisualSortOption = {
  label: string
  sort: VisualSearchSort
}

/**
 * 五档排序胶囊（顺序 = 契约 `VISUAL_SEARCH_SORTS` 的顺序，不另抄一份数组）。
 *
 * **本页自己持有这五档**，不复用搜索页的 `SEARCH_FILTERS`：那是文本搜索的四档
 * （没有「热销」，多一个搜索页的语义），两个页面共用一份必然把识图的档位
 * 削回文本搜索的口径。
 */
export const VISUAL_SORT_OPTIONS: readonly VisualSortOption[] = VISUAL_SEARCH_SORTS.map((sort) => ({
  label: SORT_LABEL[sort],
  sort,
}))

/** 契约里的缺省排序档：请求体不带 `sort` 时由服务端用它兜底。 */
export const DEFAULT_VISUAL_SORT: VisualSearchSort = 'relevance'

/**
 * 当前**生效**的排序档（胶囊高亮、同档不重发的判定都用它）。
 *
 * 用户一档都没点过时页面 state 是 `null`，生效档就是服务端缺省的 `relevance`：
 * 胶囊必须有一项是亮的，但这一档**不能**被写进请求体（见 `visualSortQuery`）——
 * 「没点过」与「点了综合」是两种不同的请求形状。
 */
export function activeVisualSort(sort: VisualSearchSort | null): VisualSearchSort {
  return sort ?? DEFAULT_VISUAL_SORT
}

/**
 * 请求体里的排序字段：**没点过档时整个键都不出现**。
 *
 * 契约里 `sort` 是可选的（`VisualSortSchema.optional()`，缺省由服务端 `input.sort ?? 'relevance'`
 * 补），所以「用户没点过任何档」的正确请求是 `{ objectKey }` 而不是
 * `{ objectKey, sort: 'relevance' }`：后者会让服务端与回放日志以为客户端显式选过档，
 * 也让老客户端 / M9 脚本的同形状假设失效。返回 `{}` 而不是 `{ sort: undefined }`：
 * 少一个键最稳，不依赖某条序列化路径把 `undefined` 丢掉。
 */
export function visualSortQuery(sort: VisualSearchSort | null): { sort?: VisualSearchSort } {
  return sort === null ? {} : { sort }
}

/**
 * 「同类成交均价」的展示值：`¥X · N 件`，样本不足或服务端没给均价时为 `null`（页面渲染 `—`）。
 *
 * 两个条件都判：
 * 1. `soldSampleCount < VISUAL_SOLD_AVG_MIN_SAMPLES` —— 阈值本身锁在服务端
 *    （契约注释：少于 3 件的「均价」不是行情），客户端这里只是把「样本不足」显式化成
 *    页面上的 `—`，**不自己拿样本价去算一个均价**；
 * 2. `soldAvgPriceCents === null` —— 服务端已经判过阈值，客户端不替它兜底成 0。
 *
 * 文案口径与统计行一致：label 由页面渲染成「同类成交均价」，值就是这里的 `¥X · N 件`。
 */
export function soldAvgText(stats: VisualSearchStats): string | null {
  if (stats.soldSampleCount < VISUAL_SOLD_AVG_MIN_SAMPLES) return null
  if (stats.soldAvgPriceCents === null) return null
  return `¥${formatAmount(stats.soldAvgPriceCents)} · ${stats.soldSampleCount} 件`
}
