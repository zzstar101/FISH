/**
 * 离线评估口径测试（Issue #323 R6 §10.1）。
 *
 * 断言的都是**手算过**的数字（见 `eval-fixture.ts`）：这些用例的作用是"改口径必须改测试"，
 * 而不是"跑一遍看不报错"。因此这里既不断言实现细节，也不放宽到只检查"不为 null"。
 */

import { describe, expect, test } from 'bun:test'
import { RANK_EVAL_K_VALUES } from '@fish/contracts/recommendation/eval'
import { RANK_FEATURE_KEYS } from '@fish/contracts/recommendation/rank'
import { computeRankEvalMetrics, type RankEvalDataset } from './eval'
import {
  RANK_EVAL_FIXTURE,
  RANK_EVAL_FIXTURE_EXPECTED,
  RANK_EVAL_FIXTURE_EXPECTED_FEATURES,
} from './eval-fixture'

describe('computeRankEvalMetrics（fixture 手算值）', () => {
  const metrics = computeRankEvalMetrics(RANK_EVAL_FIXTURE)

  test('样本量与分母：降级请求与空快照请求分开计数，相关集为空的请求不进质量分母', () => {
    expect(metrics.sample).toEqual(RANK_EVAL_FIXTURE_EXPECTED.sample)
    expect(metrics.skippedBreakdownRows).toBe(1)
    expect(metrics.missingListingRefs).toBe(0)
    // 质量指标的分母是"有相关集的请求"，不是"评估过的请求"：4 个评估请求里有 1 个相关集为空。
    const requests = RANK_EVAL_FIXTURE_EXPECTED.sample.evaluatedRequests
    expect(requests).toBe(4)
    expect(metrics.sample.requestsWithoutPositiveSignal).toBe(1)
    for (const row of metrics.quality) {
      expect(row.requests).toBe(requests - 1)
      // Σ|R(r)|：fixture 里 3 个有正向信号的请求各 1 个相关商品；它与 K 无关（相关集是请求的属性）。
      expect(row.relevantListings).toBe(3)
    }
  })

  test('默认 K 与 K=1,3 的 Recall / MRR / NDCG', () => {
    const [recallK1, mrrK1, ndcgK1] = RANK_EVAL_FIXTURE_EXPECTED.qualityK1
    const [recallK3, mrrK3, ndcgK3] = RANK_EVAL_FIXTURE_EXPECTED.qualityK3

    // 默认三档 K：相关项都在前 3 位，因此数值与 K=3 一致。
    expect(metrics.quality.map((row) => row.k)).toEqual([...RANK_EVAL_K_VALUES])
    for (const row of metrics.quality) {
      expect(row.recall).toBeCloseTo(recallK3 ?? 0, 12)
      expect(row.mrr).toBeCloseTo(mrrK3 ?? 0, 12)
      expect(row.ndcg).toBeCloseTo(ndcgK3 ?? 0, 12)
    }

    const [k1, k3] = computeRankEvalMetrics(RANK_EVAL_FIXTURE, { kValues: [1, 3] }).quality
    expect(k1?.recall).toBeCloseTo(recallK1 ?? 0, 12)
    expect(k1?.mrr).toBeCloseTo(mrrK1 ?? 0, 12)
    expect(k1?.ndcg).toBeCloseTo(ndcgK1 ?? 0, 12)
    expect(k3?.recall).toBeCloseTo(recallK3 ?? 0, 12)
    expect(k3?.mrr).toBeCloseTo(mrrK3 ?? 0, 12)
    expect(k3?.ndcg).toBeCloseTo(ndcgK3 ?? 0, 12)
  })

  test('覆盖与曝光分布（含重复曝光率与新鲜商品曝光率）', () => {
    const { coverage, coverageDetail } = metrics
    const expected = RANK_EVAL_FIXTURE_EXPECTED.coverage
    expect(coverage.recommendedListings).toBe(expected.recommendedListings)
    expect(coverage.visibleListings).toBe(expected.visibleListings)
    expect(coverage.coverage).toBeCloseTo(expected.coverage ?? 0, 12)
    expect(coverage.categoryDiversity).toBeCloseTo(expected.categoryDiversity ?? 0, 12)
    expect(coverage.categoriesPerRequest).toBeCloseTo(expected.categoriesPerRequest ?? 0, 12)
    expect(coverage.recommendedSellers).toBe(expected.recommendedSellers)
    expect(coverage.visibleSellers).toBe(expected.visibleSellers)
    expect(coverage.sellerCoverage).toBeCloseTo(expected.sellerCoverage ?? 0, 12)
    expect(coverage.freshItemExposureRate).toBeCloseTo(expected.freshItemExposureRate ?? 0, 12)
    expect(coverage.repeatedExposureRate).toBeCloseTo(expected.repeatedExposureRate ?? 0, 12)

    // 每一行的分子/分母都要能还原出「值」——否则打印出来的表格是自相矛盾的。
    expect(coverage.coverage).toBeCloseTo(
      coverage.recommendedListings / coverage.visibleListings,
      12,
    )
    expect(coverage.sellerCoverage).toBeCloseTo(
      coverage.recommendedSellers / coverage.visibleSellers,
      12,
    )
    // 均值行：Σ / 样本数 = 均值；样本数是"有快照的请求数"（含相关集为空的那一个）。
    expect(coverageDetail.categoryDiversity.samples).toBe(metrics.sample.evaluatedRequests)
    expect(coverageDetail.categoryDiversity.sum).toBeCloseTo(
      (coverage.categoryDiversity ?? 0) * coverageDetail.categoryDiversity.samples,
      12,
    )
    expect(coverageDetail.categoriesPerRequest.sum).toBeCloseTo(
      (coverage.categoriesPerRequest ?? 0) * coverageDetail.categoriesPerRequest.samples,
      12,
    )
    // 比率行：分子分母都是计数（新鲜率的分母是"被推荐且查得到商品"的快照行数）。
    expect(coverage.freshItemExposureRate).toBeCloseTo(
      coverageDetail.freshItemExposure.fresh / coverageDetail.freshItemExposure.samples,
      12,
    )
    expect(coverage.repeatedExposureRate).toBeCloseTo(
      coverageDetail.repeatedExposure.extras / coverageDetail.repeatedExposure.samples,
      12,
    )
  })

  test('特征分布：`missing` 的键不进分布，形状不符的行只跳过不抛错', () => {
    expect(metrics.features.map((row) => row.key)).toEqual([...RANK_FEATURE_KEYS])
    for (const expected of RANK_EVAL_FIXTURE_EXPECTED_FEATURES) {
      const row = metrics.features.find((candidate) => candidate.key === expected.key)
      expect(row?.samples).toBe(expected.samples)
      expect(row?.mean).toBeCloseTo(expected.mean, 12)
      expect(row?.p50).toBeCloseTo(expected.p50, 12)
      expect(row?.p95).toBeCloseTo(expected.p95, 12)
      expect(row?.missingCount).toBe(expected.missingCount)
    }
  })

  test('商品侧生命周期：新商品首次曝光 / 首次有效意向 / 成交前曝光次数', () => {
    expect(metrics.lifecycle).toEqual(RANK_EVAL_FIXTURE_EXPECTED.lifecycle)
  })

  test('通道分账：只统计可归因位次与它们带来的相关商品', () => {
    expect(metrics.channelAccounting).toEqual(RANK_EVAL_FIXTURE_EXPECTED.channelAccounting)
  })

  test('纯函数：同一份输入重复计算结果一致', () => {
    expect(computeRankEvalMetrics(RANK_EVAL_FIXTURE)).toEqual(metrics)
  })
})

describe('computeRankEvalMetrics（边界）', () => {
  const base: RankEvalDataset = {
    since: new Date('2026-01-08T00:00:00Z'),
    until: new Date('2026-01-15T00:00:00Z'),
    listings: [
      {
        listingId: 'A',
        sellerId: 'S1',
        category: 'DIGITAL',
        createdAt: new Date('2026-01-09T00:00:00Z'),
        status: 'ACTIVE',
      },
    ],
    visibleListings: [
      {
        listingId: 'A',
        sellerId: 'S1',
        category: 'DIGITAL',
        createdAt: new Date('2026-01-09T00:00:00Z'),
        status: 'ACTIVE',
      },
    ],
    requests: [
      {
        requestId: 'EARLY',
        identity: 'user:1',
        strategyVersion: 'rec-v1-rule+interest-v1+recall-v1+rank-v1',
        requestedAt: new Date('2026-01-09T10:00:00Z'),
        items: [
          {
            listingId: 'A',
            position: 0,
            primarySource: 'fresh',
            rankBreakdown: { normalized: {} },
          },
        ],
      },
      {
        requestId: 'LATE',
        identity: 'user:1',
        strategyVersion: 'rec-v1-rule+interest-v1+recall-v1+rank-v1',
        requestedAt: new Date('2026-01-10T10:00:00Z'),
        items: [
          {
            listingId: 'A',
            position: 0,
            primarySource: 'fresh',
            rankBreakdown: { normalized: {} },
          },
        ],
      },
    ],
    events: [
      // §4.3 的归因结果：两次快照都含 A，但事件只归给更早的那次请求。
      {
        listingId: 'A',
        eventType: 'PURCHASE',
        occurredAt: new Date('2026-01-10T12:00:00Z'),
        attributedRequestId: 'EARLY',
      },
    ],
  }

  test('同一商品出现在两次快照里时，只有被归因的那次请求拿到相关性', () => {
    const metrics = computeRankEvalMetrics(base, { kValues: [1] })
    expect(metrics.sample.requestsWithoutPositiveSignal).toBe(1)
    // 只有 EARLY 有相关项 ⇒ 分母 1，且它 rank1 命中。
    expect(metrics.quality[0]?.requests).toBe(1)
    expect(metrics.quality[0]?.recall).toBe(1)
    expect(metrics.quality[0]?.ndcg).toBe(1)
  })

  test('窗口外的事件不参与任何指标（防御性过滤）', () => {
    const withOutOfWindow: RankEvalDataset = {
      ...base,
      events: [
        ...base.events,
        {
          listingId: 'A',
          eventType: 'PURCHASE',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          attributedRequestId: 'LATE',
        },
      ],
    }
    const metrics = computeRankEvalMetrics(withOutOfWindow, { kValues: [1] })
    expect(metrics.sample.attributedEvents).toBe(1)
    expect(metrics.sample.requestsWithoutPositiveSignal).toBe(1)
  })

  test('负向事件把商品移出相关集（不是记负分）', () => {
    const withHide: RankEvalDataset = {
      ...base,
      events: [
        ...base.events,
        {
          listingId: 'A',
          eventType: 'HIDE',
          occurredAt: new Date('2026-01-10T13:00:00Z'),
          attributedRequestId: 'EARLY',
        },
      ],
    }
    const metrics = computeRankEvalMetrics(withHide, { kValues: [1] })
    expect(metrics.sample.requestsWithoutPositiveSignal).toBe(2)
    expect(metrics.quality[0]?.requests).toBe(0)
    expect(metrics.quality[0]?.recall).toBeNull()
    expect(metrics.quality[0]?.mrr).toBeNull()
    expect(metrics.quality[0]?.ndcg).toBeNull()
  })

  test('没有可见商品时分母为 0 的比率是 null 而不是 0', () => {
    const metrics = computeRankEvalMetrics({ ...base, visibleListings: [] }, { kValues: [1] })
    expect(metrics.coverage.coverage).toBeNull()
    expect(metrics.coverage.sellerCoverage).toBeNull()
    // 覆盖率的分母是"窗口末可见商品"：真为 0 时分子分母一起归零，是"无法判定"而不是 0%。
    expect(metrics.coverage.visibleListings).toBe(0)
    expect(metrics.coverage.recommendedListings).toBeGreaterThan(0)
  })

  test('完全没有快照时均值行的 Σ 是 null、样本数是 0（而不是 0 均值）', () => {
    const metrics = computeRankEvalMetrics({ ...base, requests: [] }, { kValues: [1] })
    expect(metrics.coverage.categoryDiversity).toBeNull()
    expect(metrics.coverageDetail.categoryDiversity).toEqual({ sum: null, samples: 0 })
    expect(metrics.coverageDetail.categoriesPerRequest).toEqual({ sum: null, samples: 0 })
    expect(metrics.coverageDetail.freshItemExposure).toEqual({ fresh: 0, samples: 0 })
    expect(metrics.coverageDetail.repeatedExposure).toEqual({ extras: 0, samples: 0 })
    expect(metrics.coverage.repeatedExposureRate).toBeNull()
  })
})
