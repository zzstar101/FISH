/**
 * `rank:eval --fixture` 的确定性样本（Issue #323 R6 §5.1 / §10.1）。
 *
 * 这份数据的**每一个数字都是手算出来的**，并且 `RANK_EVAL_FIXTURE_EXPECTED` 就是那份手算结果：
 * 指标口径出错时，测试与 CLI 的 `--fixture` 会同时失败。因此它必须保持"人能一眼验算"的规模——
 * 不要往这里加真实流量样本，真实回放归 `rank:eval` 连库模式。
 *
 * 样本刻意覆盖的六种边界：
 *   1. 降级请求（`rec-v1-none`，无快照）——不计入评估分母；
 *   2. 有排序但快照为空（`items = []`）——单独计数；
 *   3. 相关集为空的请求（只有 `HIDE`）——按 0/0 口径排除，计入 `requestsWithoutPositiveSignal`；
 *   4. 同一商品在同一身份下被两次推荐（重复曝光）；
 *   5. `rank_breakdown` 形状不符的一行（`null`）——跳过并计数；
 *   6. `missing` 里出现 `repeatedExposure` 的一行——该键不进特征分布。
 *
 * 时间基准：窗口 `[2026-01-08T00:00Z, 2026-01-15T00:00Z)`，全部时间戳写死。
 */

import { INTEREST_STRATEGY_VERSION } from '@fish/contracts/recommendation/interest'
import {
  composeRecommendationStrategyVersion,
  RANK_STRATEGY_VERSION,
  RECOMMENDATION_STRATEGY_VERSION_RULE,
} from '@fish/contracts/recommendation/rank'
import { RECALL_STRATEGY_VERSION } from '@fish/contracts/recommendation/recall'
import { RECOMMENDATION_STRATEGY_VERSION_NONE } from '@fish/contracts/recommendation/schema'
import type {
  RankEvalDataset,
  RankEvalListing,
  RankEvalMetrics,
  RankEvalSnapshotItem,
} from './eval'

const RANKED_STRATEGY_VERSION = composeRecommendationStrategyVersion([
  RECOMMENDATION_STRATEGY_VERSION_RULE,
  INTEREST_STRATEGY_VERSION,
  RECALL_STRATEGY_VERSION,
  RANK_STRATEGY_VERSION,
])

/** 快照行的排序明细：七个键全在，形状与 `RankScoreBreakdownSchema` 一致。 */
function breakdown(semantic: number, missing: readonly string[] = []): unknown {
  const contribution = (normalized: number) => ({ normalized, weight: 0.1, contribution: 0 })
  return {
    semantic: contribution(semantic),
    wish: contribution(0),
    category: contribution(0),
    freshness: contribution(0),
    popularity: contribution(0),
    repeatedExposure: contribution(0),
    negativeFeedback: contribution(0),
    missing: [...missing],
  }
}

function item(
  listingId: string,
  position: number,
  primarySource: string,
  rankBreakdown: unknown,
): RankEvalSnapshotItem {
  return { listingId, position, primarySource, rankBreakdown }
}

/**
 * 可见商品集（coverage / sellerCoverage 的分母）＝ L1–L8；`L8` **从未被推荐**，
 * 用来让 coverage 不等于 1（分母里必须有没被推荐到的商品，否则指标恒为 100%）。
 */
const LISTINGS: RankEvalListing[] = [
  {
    listingId: 'L1',
    sellerId: 'S1',
    category: 'DIGITAL',
    createdAt: new Date('2025-12-01T00:00:00Z'),
    status: 'ACTIVE',
  },
  {
    listingId: 'L2',
    sellerId: 'S1',
    category: 'BOOKS',
    createdAt: new Date('2026-01-10T09:00:00Z'),
    status: 'ACTIVE',
  },
  {
    listingId: 'L3',
    sellerId: 'S2',
    category: 'DIGITAL',
    createdAt: new Date('2026-01-10T08:00:00Z'),
    status: 'ACTIVE',
  },
  {
    listingId: 'L4',
    sellerId: 'S3',
    category: 'BEAUTY',
    createdAt: new Date('2025-11-20T00:00:00Z'),
    status: 'SOLD',
  },
  {
    listingId: 'L5',
    sellerId: 'S2',
    category: 'DIGITAL',
    createdAt: new Date('2025-12-15T00:00:00Z'),
    status: 'ACTIVE',
  },
  {
    listingId: 'L6',
    sellerId: 'S4',
    category: 'SPORTS',
    createdAt: new Date('2025-12-20T00:00:00Z'),
    status: 'ACTIVE',
  },
  {
    listingId: 'L7',
    sellerId: 'S5',
    category: 'DIGITAL',
    createdAt: new Date('2026-01-12T00:00:00Z'),
    status: 'ACTIVE',
  },
  {
    listingId: 'L8',
    sellerId: 'S5',
    category: 'BOOKS',
    createdAt: new Date('2025-12-28T00:00:00Z'),
    status: 'ACTIVE',
  },
]

export const RANK_EVAL_FIXTURE: RankEvalDataset = {
  since: new Date('2026-01-08T00:00:00Z'),
  until: new Date('2026-01-15T00:00:00Z'),
  requests: [
    {
      requestId: 'R1',
      identity: 'user:1',
      strategyVersion: RANKED_STRATEGY_VERSION,
      requestedAt: new Date('2026-01-10T10:00:00Z'),
      items: [
        item('L1', 0, 'semantic', breakdown(0.5)),
        item('L2', 1, 'fresh', breakdown(0.4)),
        item('L3', 2, 'popular', breakdown(0.3)),
      ],
    },
    {
      requestId: 'R2',
      identity: 'user:1',
      strategyVersion: RANKED_STRATEGY_VERSION,
      requestedAt: new Date('2026-01-11T10:00:00Z'),
      items: [
        item('L4', 0, 'fresh', breakdown(0.2)),
        item('L5', 1, 'category', breakdown(0.1)),
        item('L1', 2, 'explore', breakdown(0)),
      ],
    },
    {
      requestId: 'R3',
      identity: 'session:9',
      // 降级请求：`rec-v1-none` 不写快照，因此没有位次可评（§5.3）。
      strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
      requestedAt: new Date('2026-01-11T12:00:00Z'),
      items: [],
    },
    {
      requestId: 'R4',
      identity: 'user:4',
      strategyVersion: RANKED_STRATEGY_VERSION,
      requestedAt: new Date('2026-01-11T13:00:00Z'),
      // 排序过但候选为空：库里没有任何快照行，只能与降级请求分开计数。
      items: [],
    },
    {
      requestId: 'R5',
      identity: 'user:2',
      strategyVersion: RANKED_STRATEGY_VERSION,
      requestedAt: new Date('2026-01-12T09:00:00Z'),
      items: [
        // 形状不符（`null`）：整行跳过，但位次/覆盖仍然统计（§11 第 12 条）。
        item('L6', 0, 'popular', null),
        item('L1', 1, 'explore', breakdown(0.6)),
      ],
    },
    {
      requestId: 'R6',
      identity: 'user:3',
      strategyVersion: RANKED_STRATEGY_VERSION,
      requestedAt: new Date('2026-01-12T08:00:00Z'),
      items: [item('L7', 0, 'fresh', breakdown(0.7, ['repeatedExposure']))],
    },
  ],
  events: [
    // R1：L3 只有 DETAIL_VIEW（grade 1）⇒ 相关项排在第 3 位。
    {
      listingId: 'L2',
      eventType: 'IMPRESSION',
      occurredAt: new Date('2026-01-10T10:00:00Z'),
      attributedRequestId: 'R1',
    },
    {
      listingId: 'L1',
      eventType: 'IMPRESSION',
      occurredAt: new Date('2026-01-10T10:01:00Z'),
      attributedRequestId: 'R1',
    },
    {
      listingId: 'L3',
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date('2026-01-10T11:00:00Z'),
      attributedRequestId: 'R1',
    },
    {
      listingId: 'L3',
      eventType: 'IMPRESSION',
      occurredAt: new Date('2026-01-10T12:00:00Z'),
      attributedRequestId: 'R1',
    },
    // R2：L4 成交（grade 3，且用于 `exposuresBeforeSale`），L5 只有详情。
    {
      listingId: 'L4',
      eventType: 'IMPRESSION',
      occurredAt: new Date('2026-01-11T09:00:00Z'),
      attributedRequestId: 'R2',
    },
    {
      listingId: 'L5',
      eventType: 'IMPRESSION',
      occurredAt: new Date('2026-01-11T09:30:00Z'),
      attributedRequestId: 'R2',
    },
    {
      listingId: 'L4',
      eventType: 'PURCHASE',
      occurredAt: new Date('2026-01-11T10:00:00Z'),
      attributedRequestId: 'R2',
    },
    // R5：只有 HIDE ⇒ 相关集为空（0/0 口径）。
    {
      listingId: 'L1',
      eventType: 'HIDE',
      occurredAt: new Date('2026-01-12T09:10:00Z'),
      attributedRequestId: 'R5',
    },
    // R6：L7 是窗口内新建商品，曝光 → 收藏（grade 2）用于 `firstPublishToFirstIntent`。
    {
      listingId: 'L7',
      eventType: 'IMPRESSION',
      occurredAt: new Date('2026-01-12T00:30:00Z'),
      attributedRequestId: 'R6',
    },
    {
      listingId: 'L7',
      eventType: 'FAVORITE',
      occurredAt: new Date('2026-01-12T06:00:00Z'),
      attributedRequestId: 'R6',
    },
    // 未归因（requestId 为空）：不进任何请求级指标，也不进 `attributedEvents`。
    {
      listingId: 'L1',
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date('2026-01-10T12:00:00Z'),
      attributedRequestId: null,
    },
    // 归因了但在窗口之前：防御性过滤掉（取数侧本应切好，但纯函数不该依赖调用方自觉）。
    {
      listingId: 'L2',
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date('2025-12-31T00:00:00Z'),
      attributedRequestId: 'R1',
    },
  ],
  listings: LISTINGS,
  visibleListings: LISTINGS,
}

/**
 * 手算的期望值（与上面样本一一对应）。
 *
 * 验算要点：
 * - 评估集 = R1/R2/R5/R6（R3 降级、R4 空快照）；其中 R5 相关集为空 ⇒ 质量指标只在 3 个请求上平均；
 * - `K=1`：R1 的相关项在 rank3 ⇒ 全 0；R2 的 L4 在 rank1（grade3，且它是 R2 唯一的相关项）⇒ 全 1；
 *   R6 的 L7 在 rank1 ⇒ 全 1；因此三项均值都是 2/3；
 * - `K=3`：R1 ⇒ Recall 1、RR 1/3、NDCG 0.5（DCG 1/log2(4)，IDCG 1/log2(2)）；
 *   R2 ⇒ Recall 1、RR 1、NDCG 1（DCG=IDCG）；R6 同 R2；
 * - 默认 K=5/10/20 与 K=3 相同（所有相关项都在前 3 位）。
 */
export const RANK_EVAL_FIXTURE_EXPECTED: {
  /** 用默认 K（5/10/20）与 K=1,3 两组断言。 */
  readonly qualityK1: readonly number[]
  readonly qualityK3: readonly number[]
  readonly sample: RankEvalMetrics['sample']
  readonly coverage: RankEvalMetrics['coverage']
  readonly lifecycle: RankEvalMetrics['lifecycle']
  readonly channelAccounting: RankEvalMetrics['channelAccounting']
} = {
  qualityK1: [2 / 3, 2 / 3, 2 / 3],
  qualityK3: [1, 7 / 9, 5 / 6],
  sample: {
    requests: 6,
    evaluatedRequests: 4,
    degradedRequests: 1,
    requestsWithoutSnapshot: 1,
    requestsWithoutPositiveSignal: 1,
    snapshotItems: 9,
    attributedEvents: 10,
  },
  coverage: {
    recommendedListings: 7,
    visibleListings: 8,
    coverage: 7 / 8,
    // (4/9 + 4/9 + 0.5 + 0) / 4 = 25/72
    categoryDiversity: 25 / 72,
    categoriesPerRequest: 7 / 4,
    recommendedSellers: 5,
    visibleSellers: 5,
    sellerCoverage: 1,
    // L2、L3、L7 各 1 个位次新于 7 天 ⇒ 3/9
    freshItemExposureRate: 1 / 3,
    // 9 行、8 个不同 (身份, 商品) 对 ⇒ 1 - 8/9
    repeatedExposureRate: 1 / 9,
  },
  lifecycle: {
    // L2 1h、L7 0.5h、L3 4h（最近秩：median 取第 2 个、p90 取第 3 个）
    newListingTimeToFirstExposureHours: { count: 3, median: 1, p90: 4 },
    firstPublishToFirstIntentHours: { count: 1, median: 6, p90: 6 },
    exposuresBeforeSale: { count: 1, median: 1, p90: 1 },
  },
  channelAccounting: [
    { primarySource: 'category', positions: 1, relevantListings: 0 },
    { primarySource: 'explore', positions: 2, relevantListings: 0 },
    { primarySource: 'fresh', positions: 3, relevantListings: 2 },
    { primarySource: 'popular', positions: 2, relevantListings: 1 },
    { primarySource: 'semantic', positions: 1, relevantListings: 0 },
  ],
}

/** 特征分布的手算期望（semantic 有 8 个样本，`repeatedExposure` 7 个 + 1 次缺失）。 */
export const RANK_EVAL_FIXTURE_EXPECTED_FEATURES = [
  { key: 'semantic', samples: 8, mean: 0.35, p50: 0.3, p95: 0.7, missingCount: 0 },
  { key: 'wish', samples: 8, mean: 0, p50: 0, p95: 0, missingCount: 0 },
  { key: 'category', samples: 8, mean: 0, p50: 0, p95: 0, missingCount: 0 },
  { key: 'freshness', samples: 8, mean: 0, p50: 0, p95: 0, missingCount: 0 },
  { key: 'popularity', samples: 8, mean: 0, p50: 0, p95: 0, missingCount: 0 },
  { key: 'repeatedExposure', samples: 7, mean: 0, p50: 0, p95: 0, missingCount: 1 },
  { key: 'negativeFeedback', samples: 8, mean: 0, p50: 0, p95: 0, missingCount: 0 },
] as const
