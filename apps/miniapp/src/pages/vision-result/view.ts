/**
 * 识图结果页的**派生逻辑**（Taro-free，可单测）。
 *
 * 三块：查询图卡的识别结论文案、两段统计行、「排序胶囊 → 结果顺序」。
 * 抽出来的理由同仓内其它 `view.ts`：这些判据写进页面组件就没人能钉住，
 * 而它们都有「看起来对、实际错」的写法（比如把「识别中」的统计位写成 0 件）。
 *
 * **排序是客户端做的**：契约 `VisualSearchRequestSchema` 只有 `objectKey`
 * （`packages/contracts/src/visual/schema.ts`），没有排序参数 —— 服务端按混合权重
 * 排好序返回。所以除「综合」（= 服务端顺序）外，其余三档都是对**已返回的那一批**
 * （服务端 `VISUAL_RESULT_LIMIT` = 30 条上限）重排，不改变召回范围。这是当前契约下的
 * 上限，不假装是服务端排序。
 */
import type {
  ListingCard,
  ListingCategory,
  ListingCondition,
} from '@fish/contracts/listings/schema'
import type { VisualInterpretation } from '@fish/contracts/visual/schema'
import { categoryLabel } from '@/mock/api'
import type { SearchFilter } from '@/mock/types'

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
 * 同页已经在 import 同一个模块的 `searchFilters`（排序胶囊与搜索页同源），
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

/** 两段统计行（稿 03 里空态写 `0 件`、价格区间给 `—`）。 */
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

/** 成色档位（数字越小越新），「成色」排序用。 */
const CONDITION_RANK: Record<ListingCondition, number> = {
  NEW: 0,
  LIKE_NEW: 1,
  GOOD: 2,
  FAIR: 3,
}

/** 时间戳；解析不出来按 0（排在最后），不让脏值把整次排序打乱 */
function timeOf(iso: string): number {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : 0
}

/**
 * 按当前胶囊重排结果。
 *
 * `综合` 原样返回**同一个数组实例**：那是服务端的混合排序结果（M6 的权重算出来的），
 * 任何本地重排都是对它的一次降级 —— 复制一份反而会让「有没有动过」看不出来。
 * 其余三档返回新数组，不改原数组。
 */
export function sortResults(items: ListingCard[], filter: SearchFilter): ListingCard[] {
  if (filter === '综合') return items
  const sorted = [...items]
  if (filter === '最新') {
    sorted.sort((left, right) => timeOf(right.createdAt) - timeOf(left.createdAt))
    return sorted
  }
  if (filter === '价格') {
    sorted.sort((left, right) => left.priceCents - right.priceCents)
    return sorted
  }
  sorted.sort((left, right) => CONDITION_RANK[left.condition] - CONDITION_RANK[right.condition])
  return sorted
}
