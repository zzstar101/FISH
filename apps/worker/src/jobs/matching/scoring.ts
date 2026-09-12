import type { ListingCategory } from '@fish/contracts/listings/schema'

/**
 * Match Engine 的打分（Issue #8 契约评论 §3.2）。
 *
 * 纯函数、不碰 DB：`Backend Done` 要求"给定 fixture Listing/Wish 能稳定得到预期分数"，
 * 所以打分必须能在没有数据库的情况下断言。候选集收窄（category / price 先删候选）在 `engine.ts`
 * 的 SQL 里，那里保证进来的 candidate 至少有一个分项可能非 0。
 *
 * 只在这里定义权重与阈值语义，别处不得再写一套 0.35 / 0.35 / 0.30。
 */

/** 契约 §3.2 冻结的权重，和恒为 1。 */
const WEIGHTS = { category: 0.35, keyword: 0.35, price: 0.3 } as const

/** 归一化后用于"不限分类"的权重和（`wishes.category IS NULL`，契约 §3.2）。 */
const WEIGHTS_WITHOUT_CATEGORY = WEIGHTS.keyword + WEIGHTS.price

export type MatchListingFacts = {
  title: string
  description: string
  priceCents: number
  category: ListingCategory
}

export type MatchWishFacts = {
  keyword: string
  /** `null` = 不限分类（DB 允许，契约 §3.2 对它有专门规则）。 */
  category: ListingCategory | null
  budgetMaxCents: number | null
}

export type MatchScoreBreakdown = {
  score: number
  categoryScore: number
  keywordScore: number
  priceScore: number
}

/**
 * keyword 的 token 切分：按空白切。
 *
 * #7 的写入路径会把 keyword 转小写（`wishes/schema.ts` 的 `keywordSchema` transform），
 * 所以这里统一做大小写不敏感比较，两侧都不再各自 lowercase 一次。
 */
export function keywordTokens(keyword: string): string[] {
  return keyword
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

/**
 * 命中 = `title` 或 `description` 包含该 token（大小写不敏感）。
 *
 * 刻意不用 pg_trgm：实测 `similarity('机械键盘','罗技 K380 机械键盘') = 0.385`、
 * `similarity('高等数学 教材','高等数学上册（同济第七版）') = 0.235`——中文短词在长标题里的
 * trigram 相似度天然很低，会把主 Demo 那对打到 38 分。同义词/品牌词扩展是 P1。
 */
export function keywordScore(listing: MatchListingFacts, keyword: string): number {
  const tokens = keywordTokens(keyword)
  if (tokens.length === 0) return 0

  const haystack = `${listing.title}\n${listing.description}`.toLowerCase()
  const hits = tokens.filter((token) => haystack.includes(token.toLowerCase())).length
  return Math.round((hits / tokens.length) * 100)
}

/**
 * 价格分：`budgetMaxCents` 为 NULL（不限预算）或在预算内 → 100；超出预算后线性衰减，
 * 到 **2 倍预算**归零（契约 §3.2）。
 *
 * 2 倍这个数与 `engine.ts` 的候选集收窄相同，但两处不是同一件事：收窄直接**排除**
 * `price > 2 × budget_max` 的候选（产品规则），所以那些对根本不会被打分——即使分类与关键词
 * 都满分（那会得 70 分，本可以过阈值）。不要把它读成"只排除 priceScore = 0 的候选"。
 */
export function priceScore(listing: MatchListingFacts, budgetMaxCents: number | null): number {
  if (budgetMaxCents === null) return 100
  if (listing.priceCents <= budgetMaxCents) return 100
  // 预算为 0（"0 元送"类愿望）：任何非 0 价格都已经越过 2 倍界限。
  if (budgetMaxCents <= 0) return 0

  const decayed = (100 * (2 * budgetMaxCents - listing.priceCents)) / budgetMaxCents
  return Math.max(0, Math.round(decayed))
}

/** 分类等值打分：相等 100，否则 0（`listings.ts` 的注释："#8 的匹配按分类等值打分"）。 */
export function categoryScore(
  listing: MatchListingFacts,
  category: ListingCategory | null,
): number {
  return category !== null && listing.category === category ? 100 : 0
}

/**
 * 总分。
 *
 * **`wish.category IS NULL`（不限分类）**：跳过 category 分项并把权重归一化
 * （`(0.35·kw + 0.30·price) / 0.65`），`categoryScore` 记 0 落库。
 * 记 0 分而不是归一化的话，"不限分类"的愿望最高只能拿 65 分，永远够不到 70 阈值。
 */
export function scoreMatch(listing: MatchListingFacts, wish: MatchWishFacts): MatchScoreBreakdown {
  const keyword = keywordScore(listing, wish.keyword)
  const price = priceScore(listing, wish.budgetMaxCents)
  const category = categoryScore(listing, wish.category)

  const raw =
    wish.category === null
      ? (WEIGHTS.keyword * keyword + WEIGHTS.price * price) / WEIGHTS_WITHOUT_CATEGORY
      : WEIGHTS.category * category + WEIGHTS.keyword * keyword + WEIGHTS.price * price

  return {
    score: Math.round(raw),
    categoryScore: category,
    keywordScore: keyword,
    priceScore: price,
  }
}
