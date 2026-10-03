/**
 * R6 离线评估的**纯计算**层（Issue #323 §M8 / 设计 §5）。
 *
 * 输入是一份"已经回放好的"内存数据集（请求 + 快照 + 事件 + 商品），输出是指标对象；
 * 取数由 `apps/worker/scripts/rank-eval.ts` 负责，样本由 `eval-fixture.ts` 提供。
 * 这样切分的理由：指标口径是**唯一需要被断言**的东西（手算样本 → 已知数字），
 * 而 SQL 只是它的搬运工；把两者混在一起，测试就得起库，指标本身反而没人验证。
 *
 * 三条贯穿口径（全部来自设计 §5，改动前先读 §11 的已知边界）：
 *
 * 1. **只评"有排序结果"的请求**：降级请求（`strategy_version = 'rec-v1-none'`）不写快照，
 *    没有位次可评，单独计数；
 * 2. **`R(r) = ∅` 的请求不进 Recall/MRR/NDCG 的分母**（0/0 口径，§5.3）：把"没人点"算成 0
 *    会让指标随用户活跃度变化，而不是随排序质量变化；
 * 3. **所有输出都带分母**：只有比率没有样本量的指标在小样本下会骗人。
 *
 * 这里不引入随机性、不算置信区间：样本量与分布一起报出来，让人自己判断（§5.6）。
 */

import {
  RANK_EVAL_FRESH_ITEM_DAYS,
  RANK_EVAL_K_VALUES,
  RANK_EVAL_NEGATIVE_EVENT_TYPES,
  RANK_EVAL_RELEVANCE_GRADES,
} from '@fish/contracts/recommendation/eval'
import { RANK_FEATURE_KEYS, type RankFeatureKey } from '@fish/contracts/recommendation/rank'
import {
  RECOMMENDATION_STRATEGY_VERSION_NONE,
  type RecommendationEventType,
} from '@fish/contracts/recommendation/schema'

/** 快照行：`position` 从 0 起（与 `recommendation_request_items` 一致）。 */
export type RankEvalSnapshotItem = {
  listingId: string
  position: number
  primarySource: string | null
  /** `rank_breakdown` 的原始 jsonb（可能为空/形状不符，读取侧必须容错，见 §11 第 12 条）。 */
  rankBreakdown: unknown
}

export type RankEvalRequest = {
  requestId: string
  /** 身份键（登录取 user，匿名取 session）：`repeatedExposureRate` 按它去重。 */
  identity: string
  strategyVersion: string
  requestedAt: Date
  /**
   * 快照行。数组本身可变：这是**取数适配器**逐行填出来的 DTO（`store.ts` 按 `request_id`
   * 分组时增量 push），只读约束落在 `RankEvalDataset.requests` 那一层。
   */
  items: RankEvalSnapshotItem[]
}

export type RankEvalEvent = {
  listingId: string
  eventType: RecommendationEventType
  occurredAt: Date
  /**
   * 由 §4.3 的口径**算出来**的归因请求；`null` = 候选集为空（来自非推荐入口或窗口外曝光）。
   *
   * 刻意不是事件自带的 `request_id`：那是"客户端当时带着哪个推荐头"，与"哪次曝光真正促成了
   * 这次行为"不是一回事（同一商品可以在多次快照里出现）。
   */
  attributedRequestId: string | null
}

export type RankEvalListing = {
  listingId: string
  sellerId: string
  category: string
  createdAt: Date
  status: string
}

export type RankEvalDataset = {
  /** 评估窗口（左闭右开）。事件与请求都应已按它切好，这里只用它做二次防御与输出。 */
  since: Date
  until: Date
  requests: readonly RankEvalRequest[]
  events: readonly RankEvalEvent[]
  /**
   * 商品维度真值：被推荐到的 + 窗口内新建的 + 窗口内有成交的。
   * 缺少某个 listing 时相关指标按"无法判定"跳过并计入 `missingListingRefs`，不抛错。
   */
  listings: readonly RankEvalListing[]
  /** 窗口末的可见商品（coverage / sellerCoverage 的分母，口径见设计 §4.1）。 */
  visibleListings: readonly RankEvalListing[]
}

export type RankEvalQualityRow = {
  k: number
  requests: number
  /**
   * `Σ|R(r)|`：这些请求的相关集**总规模**（设计 §5.2）。
   *
   * 与 `requests` 一起才能读懂 Recall：`Recall@K = 1.0` 可能是"1 个请求、1 个相关商品"，
   * 也可能是"50 个请求、200 个相关商品"——只看比率分不出来，而这两件事的可信度完全不同。
   */
  relevantListings: number
  recall: number | null
  mrr: number | null
  ndcg: number | null
}

export type RankEvalFeatureRow = {
  key: RankFeatureKey
  samples: number
  mean: number | null
  p50: number | null
  p95: number | null
  /** `missing` 数组里出现该键的次数（长期缺失 = 对应特征在降级）。 */
  missingCount: number
}

export type RankEvalHoursSummary = {
  count: number
  median: number | null
  p90: number | null
}

export type RankEvalChannelRow = {
  /** `null` 源（快照行的 `primary_source` 为空）在这里归到 `null`。 */
  primarySource: string | null
  positions: number
  relevantListings: number
}

/**
 * 覆盖率 / 曝光分布每一行的分子与分母（设计 §5.2「所有输出都带分母」）。
 *
 * 比率行（新鲜曝光率、重复曝光率）的分子分母都是计数；均值行（类目多样性、每请求去重类目数）
 * 的「分子」是 Σ、「分母」是样本数——均值在 3 个请求上平均和在 300 个请求上平均不是一回事，
 * 而只有均值一个数时读者无从判断（`null` = 样本量为 0）。
 */
export type RankEvalCoverageDetail = {
  categoryDiversity: { sum: number | null; samples: number }
  categoriesPerRequest: { sum: number | null; samples: number }
  freshItemExposure: { fresh: number; samples: number }
  /** 重复曝光 = 快照行里"同身份同商品已出现过"的那部分（`extras / samples`）。 */
  repeatedExposure: { extras: number; samples: number }
}

export type RankEvalMetrics = {
  since: Date
  until: Date
  kValues: readonly number[]
  sample: {
    requests: number
    evaluatedRequests: number
    degradedRequests: number
    requestsWithoutSnapshot: number
    requestsWithoutPositiveSignal: number
    snapshotItems: number
    attributedEvents: number
  }
  quality: RankEvalQualityRow[]
  coverage: {
    recommendedListings: number
    visibleListings: number
    coverage: number | null
    categoryDiversity: number | null
    categoriesPerRequest: number | null
    recommendedSellers: number
    visibleSellers: number
    sellerCoverage: number | null
    freshItemExposureRate: number | null
    repeatedExposureRate: number | null
  }
  /** 上面那几个均值/比率的分子与分母（打印表格用；`null` = 样本量为 0）。 */
  coverageDetail: RankEvalCoverageDetail
  features: RankEvalFeatureRow[]
  channelAccounting: RankEvalChannelRow[]
  lifecycle: {
    newListingTimeToFirstExposureHours: RankEvalHoursSummary
    firstPublishToFirstIntentHours: RankEvalHoursSummary
    exposuresBeforeSale: RankEvalHoursSummary
  }
  /** 形状不符的 `rank_breakdown` 行数：跳过而不是终止整次评估（§11 第 12 条）。 */
  skippedBreakdownRows: number
  /** 快照引用了 `listings` 里不存在的商品的行数（数据被清理/查询缺失）。 */
  missingListingRefs: number
}

const HOUR_MS = 3_600_000

/**
 * 最近秩分位（与 `apps/api/src/observability/latency.ts` 同一约定：不插值）。
 *
 * 不插值是为了让"p90 就是某个真实样本"这一性质成立——延迟与小时数这类右偏分布上，
 * 插值出来的分位数看起来更平滑，但不对应任何一次真实观测。
 */
function percentileOf(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil(p * sorted.length)
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1
  return sorted[index] ?? null
}

function summarizeHours(values: readonly number[]): RankEvalHoursSummary {
  if (values.length === 0) return { count: 0, median: null, p90: null }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, median: percentileOf(sorted, 0.5), p90: percentileOf(sorted, 0.9) }
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function ratioOf(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/** Σ（空数组 → `null`，与 `meanOf` 同口径：没有样本就"无法判定"）。 */
function sumOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return sum
}

function gradeOf(eventType: RecommendationEventType): number | null {
  const grade = (RANK_EVAL_RELEVANCE_GRADES as Record<string, number | undefined>)[eventType]
  return grade ?? null
}

function isNegativeEvent(eventType: RecommendationEventType): boolean {
  return (RANK_EVAL_NEGATIVE_EVENT_TYPES as readonly string[]).includes(eventType)
}

/**
 * 从 `rank_breakdown` 里取七个特征的 `normalized`。
 *
 * 形状真值由 `RankScoreBreakdownSchema` 定义（每个键是 `{normalized, weight, contribution}`）；
 * 库层不做校验，所以这里**逐键验形**：任一键缺失/不是对象/`normalized` 不是数字就返回 `null`，
 * 由调用方计入 `skippedBreakdownRows` 并跳过（设计 §11 第 12 条：形状不符不能终止整次评估）。
 */
function readNormalized(rankBreakdown: unknown): Record<RankFeatureKey, number> | null {
  if (rankBreakdown === null || typeof rankBreakdown !== 'object') return null
  const record = rankBreakdown as Record<string, unknown>
  const result = {} as Record<RankFeatureKey, number>
  for (const key of RANK_FEATURE_KEYS) {
    const contribution = record[key]
    if (contribution === null || typeof contribution !== 'object') return null
    const normalized = (contribution as { normalized?: unknown }).normalized
    if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return null
    result[key] = normalized
  }
  return result
}

/** 从 `rank_breakdown` 里取 `missing`；形状不符返回 `null`（与 `normalized` 分开容错）。 */
function readMissing(rankBreakdown: unknown): readonly string[] | null {
  if (rankBreakdown === null || typeof rankBreakdown !== 'object') return null
  const missing = (rankBreakdown as { missing?: unknown }).missing
  if (!Array.isArray(missing)) return null
  return missing.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * 一个请求的相关集 `R(r)`：取每个商品的**最高** grade（同一商品可能既是详情又是收藏），
 * 且任一负向事件命中即整个剔除（§3.1 的剔除口径）。
 */
function buildRelevance(events: readonly RankEvalEvent[]): Map<string, number> {
  const grades = new Map<string, number>()
  const negative = new Set<string>()
  for (const event of events) {
    if (isNegativeEvent(event.eventType)) {
      negative.add(event.listingId)
      continue
    }
    const grade = gradeOf(event.eventType)
    if (grade === null) continue
    const current = grades.get(event.listingId) ?? 0
    if (grade > current) grades.set(event.listingId, grade)
  }
  for (const listingId of negative) grades.delete(listingId)
  return grades
}

function dcgOf(grades: readonly number[], k: number): number {
  let dcg = 0
  const limit = Math.min(grades.length, k)
  for (let index = 0; index < limit; index += 1) {
    const grade = grades[index] ?? 0
    if (grade <= 0) continue
    dcg += (2 ** grade - 1) / Math.log2(index + 2)
  }
  return dcg
}

/**
 * 计算全部离线指标。**纯函数**：同一份数据集必须得到同一份结果（fixture 测试的基础）。
 */
export function computeRankEvalMetrics(
  dataset: RankEvalDataset,
  options?: { kValues?: readonly number[] },
): RankEvalMetrics {
  const kValues = options?.kValues ?? RANK_EVAL_K_VALUES
  const listingById = new Map(dataset.listings.map((listing) => [listing.listingId, listing]))

  const eventsByRequest = new Map<string, RankEvalEvent[]>()
  let attributedEvents = 0
  for (const event of dataset.events) {
    if (event.attributedRequestId === null) continue
    // 窗口外事件不参与（防御性：取数侧应已切好，但纯函数不该依赖调用方自觉）。
    if (event.occurredAt < dataset.since || event.occurredAt >= dataset.until) continue
    attributedEvents += 1
    const bucket = eventsByRequest.get(event.attributedRequestId)
    if (bucket === undefined) eventsByRequest.set(event.attributedRequestId, [event])
    else bucket.push(event)
  }

  let degradedRequests = 0
  let requestsWithoutSnapshot = 0
  let requestsWithoutPositiveSignal = 0
  let relevantSetSum = 0
  let snapshotItems = 0
  let skippedBreakdownRows = 0
  let missingListingRefs = 0

  const recallSums = new Map<number, number>()
  const mrrSums = new Map<number, number>()
  const ndcgSums = new Map<number, number>()
  const qualityCounts = new Map<number, number>()
  for (const k of kValues) {
    recallSums.set(k, 0)
    mrrSums.set(k, 0)
    ndcgSums.set(k, 0)
    qualityCounts.set(k, 0)
  }

  const recommendedListings = new Set<string>()
  const recommendedSellers = new Set<string>()
  const repeatedPairs = new Set<string>()
  const diversityValues: number[] = []
  const categoriesPerRequest: number[] = []
  const freshFlags: boolean[] = []
  const featureValues = new Map<RankFeatureKey, number[]>()
  const featureMissing = new Map<RankFeatureKey, number>()
  for (const key of RANK_FEATURE_KEYS) {
    featureValues.set(key, [])
    featureMissing.set(key, 0)
  }
  const channelPositions = new Map<string | null, number>()
  const channelRelevant = new Map<string | null, Set<string>>()

  for (const request of dataset.requests) {
    if (request.strategyVersion === RECOMMENDATION_STRATEGY_VERSION_NONE) {
      degradedRequests += 1
      continue
    }
    if (request.items.length === 0) {
      requestsWithoutSnapshot += 1
      continue
    }

    const ordered = [...request.items].sort((a, b) => a.position - b.position)
    const relevance = buildRelevance(eventsByRequest.get(request.requestId) ?? [])
    const rankByListing = new Map(ordered.map((item, index) => [item.listingId, index + 1]))
    const sourceByListing = new Map(ordered.map((item) => [item.listingId, item.primarySource]))

    const categories = new Set<string>()
    for (const item of ordered) {
      snapshotItems += 1
      recommendedListings.add(item.listingId)
      repeatedPairs.add(`${request.identity}\u0000${item.listingId}`)

      const listing = listingById.get(item.listingId)
      if (listing === undefined) {
        missingListingRefs += 1
      } else {
        recommendedSellers.add(listing.sellerId)
        categories.add(listing.category)
        const ageMs = request.requestedAt.getTime() - listing.createdAt.getTime()
        freshFlags.push(ageMs <= RANK_EVAL_FRESH_ITEM_DAYS * 24 * HOUR_MS)
      }

      const normalized = readNormalized(item.rankBreakdown)
      const missing = readMissing(item.rankBreakdown)
      if (normalized === null || missing === null) {
        skippedBreakdownRows += 1
      } else {
        for (const key of RANK_FEATURE_KEYS) {
          // `missing` 里的键不进分布：那些位置的 `normalized` 是"没有信号"的占位 0，
          // 把它当样本会人为把均值拉向 0，而它恰恰代表"这一路特征没算出来"。
          if (missing.includes(key)) continue
          featureValues.get(key)?.push(normalized[key])
        }
        for (const key of missing) {
          if ((RANK_FEATURE_KEYS as readonly string[]).includes(key)) {
            featureMissing.set(
              key as RankFeatureKey,
              (featureMissing.get(key as RankFeatureKey) ?? 0) + 1,
            )
          }
        }
      }

      channelPositions.set(item.primarySource, (channelPositions.get(item.primarySource) ?? 0) + 1)
    }

    const counts = new Map<string, number>()
    for (const item of ordered) {
      const listing = listingById.get(item.listingId)
      if (listing === undefined) continue
      counts.set(listing.category, (counts.get(listing.category) ?? 0) + 1)
    }
    let sumSquares = 0
    for (const count of counts.values()) sumSquares += (count / ordered.length) ** 2
    diversityValues.push(1 - sumSquares)
    categoriesPerRequest.push(categories.size)

    for (const [listingId] of relevance) {
      const source = sourceByListing.get(listingId)
      if (source === undefined) continue
      const bucket = channelRelevant.get(source)
      if (bucket === undefined) channelRelevant.set(source, new Set([listingId]))
      else bucket.add(listingId)
    }

    const relevantGrades = [...relevance.values()]
    if (relevantGrades.length === 0) {
      requestsWithoutPositiveSignal += 1
      continue
    }

    const idealGrades = [...relevantGrades].sort((a, b) => b - a)
    // 与 k 无关：相关集大小是请求的属性，不是截断位的属性（所以同一份 Σ|R| 出现在每一行）。
    relevantSetSum += relevance.size
    for (const k of kValues) {
      const hits = [...relevance.keys()].filter((listingId) => {
        const rank = rankByListing.get(listingId)
        return rank !== undefined && rank <= k
      }).length
      recallSums.set(k, (recallSums.get(k) ?? 0) + hits / relevance.size)

      let firstRank: number | null = null
      for (const [listingId] of relevance) {
        const rank = rankByListing.get(listingId)
        if (rank === undefined || rank > k) continue
        if (firstRank === null || rank < firstRank) firstRank = rank
      }
      mrrSums.set(k, (mrrSums.get(k) ?? 0) + (firstRank === null ? 0 : 1 / firstRank))

      const dcg = dcgOf(
        ordered.slice(0, k).map((item) => relevance.get(item.listingId) ?? 0),
        k,
      )
      const idcg = dcgOf(idealGrades, k)
      ndcgSums.set(k, (ndcgSums.get(k) ?? 0) + (idcg === 0 ? 0 : dcg / idcg))
      qualityCounts.set(k, (qualityCounts.get(k) ?? 0) + 1)
    }
  }

  const quality: RankEvalQualityRow[] = kValues.map((k) => {
    const requests = qualityCounts.get(k) ?? 0
    return {
      k,
      requests,
      relevantListings: relevantSetSum,
      recall: ratioOf(recallSums.get(k) ?? 0, requests),
      mrr: ratioOf(mrrSums.get(k) ?? 0, requests),
      ndcg: ratioOf(ndcgSums.get(k) ?? 0, requests),
    }
  })

  // ---- 商品侧生命周期（§5.5）：窗口内新建 → 首次归因曝光 / 首次有效意向 ----------
  const firstExposureAt = new Map<string, number>()
  const firstIntentAt = new Map<string, number>()
  const purchaseAt = new Map<string, number>()
  const exposureTimes = new Map<string, number[]>()
  for (const event of dataset.events) {
    if (event.attributedRequestId === null) continue
    if (event.occurredAt < dataset.since || event.occurredAt >= dataset.until) continue
    const at = event.occurredAt.getTime()
    if (event.eventType === 'IMPRESSION') {
      const current = firstExposureAt.get(event.listingId)
      if (current === undefined || at < current) firstExposureAt.set(event.listingId, at)
      const times = exposureTimes.get(event.listingId)
      if (times === undefined) exposureTimes.set(event.listingId, [at])
      else times.push(at)
    }
    const grade = gradeOf(event.eventType)
    if (grade !== null && grade >= 2) {
      const current = firstIntentAt.get(event.listingId)
      if (current === undefined || at < current) firstIntentAt.set(event.listingId, at)
    }
    if (event.eventType === 'PURCHASE') {
      const current = purchaseAt.get(event.listingId)
      if (current === undefined || at < current) purchaseAt.set(event.listingId, at)
    }
  }

  const timeToFirstExposure: number[] = []
  const timeToFirstIntent: number[] = []
  for (const listing of dataset.listings) {
    const createdAt = listing.createdAt.getTime()
    if (listing.createdAt < dataset.since || listing.createdAt >= dataset.until) continue
    const exposure = firstExposureAt.get(listing.listingId)
    if (exposure !== undefined) timeToFirstExposure.push((exposure - createdAt) / HOUR_MS)
    const intent = firstIntentAt.get(listing.listingId)
    if (intent !== undefined) timeToFirstIntent.push((intent - createdAt) / HOUR_MS)
  }

  const exposuresBeforeSale: number[] = []
  for (const [listingId, soldAt] of purchaseAt) {
    const times = exposureTimes.get(listingId) ?? []
    exposuresBeforeSale.push(times.filter((at) => at < soldAt).length)
  }

  const channelRows: RankEvalChannelRow[] = [...channelPositions.entries()]
    .map(([primarySource, positions]) => ({
      primarySource,
      positions,
      relevantListings: channelRelevant.get(primarySource)?.size ?? 0,
    }))
    .sort((a, b) => {
      if (a.primarySource === null) return 1
      if (b.primarySource === null) return -1
      return a.primarySource.localeCompare(b.primarySource)
    })

  const evaluatedRequests = dataset.requests.length - degradedRequests - requestsWithoutSnapshot
  const freshTrue = freshFlags.filter(Boolean).length

  return {
    since: dataset.since,
    until: dataset.until,
    kValues,
    sample: {
      requests: dataset.requests.length,
      evaluatedRequests,
      degradedRequests,
      requestsWithoutSnapshot,
      requestsWithoutPositiveSignal,
      snapshotItems,
      attributedEvents,
    },
    quality,
    coverage: {
      recommendedListings: recommendedListings.size,
      visibleListings: dataset.visibleListings.length,
      coverage: ratioOf(recommendedListings.size, dataset.visibleListings.length),
      categoryDiversity: meanOf(diversityValues),
      categoriesPerRequest: meanOf(categoriesPerRequest),
      recommendedSellers: recommendedSellers.size,
      visibleSellers: new Set(dataset.visibleListings.map((listing) => listing.sellerId)).size,
      sellerCoverage: ratioOf(
        recommendedSellers.size,
        new Set(dataset.visibleListings.map((listing) => listing.sellerId)).size,
      ),
      freshItemExposureRate: ratioOf(freshTrue, freshFlags.length),
      repeatedExposureRate: snapshotItems === 0 ? null : 1 - repeatedPairs.size / snapshotItems,
    },
    coverageDetail: {
      categoryDiversity: { sum: sumOf(diversityValues), samples: diversityValues.length },
      categoriesPerRequest: {
        sum: sumOf(categoriesPerRequest),
        samples: categoriesPerRequest.length,
      },
      freshItemExposure: { fresh: freshTrue, samples: freshFlags.length },
      repeatedExposure: { extras: snapshotItems - repeatedPairs.size, samples: snapshotItems },
    },
    features: RANK_FEATURE_KEYS.map((key) => {
      const values = [...(featureValues.get(key) ?? [])].sort((a, b) => a - b)
      return {
        key,
        samples: values.length,
        mean: meanOf(values),
        p50: percentileOf(values, 0.5),
        p95: percentileOf(values, 0.95),
        missingCount: featureMissing.get(key) ?? 0,
      }
    }),
    channelAccounting: channelRows,
    lifecycle: {
      newListingTimeToFirstExposureHours: summarizeHours(timeToFirstExposure),
      firstPublishToFirstIntentHours: summarizeHours(timeToFirstIntent),
      exposuresBeforeSale: summarizeHours(exposuresBeforeSale),
    },
    skippedBreakdownRows,
    missingListingRefs,
  }
}
