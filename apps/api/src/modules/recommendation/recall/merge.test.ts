import { describe, expect, test } from 'bun:test'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import { RECALL_FRESHNESS_HALF_LIFE_MS } from '@fish/contracts/recommendation/recall'
import type { VisibleListing } from './merge'
import { compareRecallCandidates, freshnessOf, mergeRecallCandidates } from './merge'
import type { ChannelRecall } from './types'

/**
 * 合并 / 去重的单测（#323 M3）。
 *
 * 这是纯函数，因此"候选去重后保留所有 source feature""不可见商品最终再次过滤""截断顺序确定"
 * 这些验收项可以在**不碰数据库**的情况下逐字断言。真库测试只覆盖"SQL 取出的候选确实进了合并层"，
 * 不再重复这里的每条规则。
 */

const NOW = new Date('2026-01-15T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function listing(
  listingId: string,
  sellerId: string,
  category: ListingCategory = 'OTHER',
  ageMs = 0,
): VisibleListing {
  return { listingId, sellerId, category, createdAt: new Date(NOW.getTime() - ageMs) }
}

function channel(
  name: ChannelRecall['channel'],
  candidates: { listingId: string; score?: number | null }[],
): ChannelRecall {
  return {
    channel: name,
    candidates: candidates.map((row) => ({ listingId: row.listingId, score: row.score ?? null })),
    degradedReason: null,
  }
}

const EMPTY_MAPS = {
  impressions: new Map<string, number>(),
  categoryAffinity: new Map<string, number>(),
}

describe('mergeRecallCandidates', () => {
  test('不在最终可见性复核结果里的候选被丢弃', () => {
    const candidates = mergeRecallCandidates({
      channels: [channel('fresh', [{ listingId: 'a' }, { listingId: 'gone' }])],
      // 'gone' 曾被召回（快照里是 ACTIVE），但复核时已经不可见。
      visible: [listing('a', 'seller-1')],
      ...EMPTY_MAPS,
      now: NOW,
    })

    expect(candidates.map((row) => row.listingId)).toEqual(['a'])
  })

  test('同一商品被多路命中：source 全保留且按优先级排列，feature 不互相覆盖', () => {
    const candidates = mergeRecallCandidates({
      channels: [
        // 故意用与优先级相反的顺序传入：合并层必须自己按优先级排序，而不是信任入参顺序。
        channel('fresh', [{ listingId: 'a' }]),
        channel('popular', [{ listingId: 'a', score: 4.5 }]),
        channel('semantic', [{ listingId: 'a', score: 0.8 }]),
      ],
      visible: [listing('a', 'seller-1')],
      ...EMPTY_MAPS,
      now: NOW,
    })

    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]
    if (!candidate) throw new Error('候选丢失')
    expect(candidate.recallSources).toEqual(['semantic', 'popular', 'fresh'])
    expect(candidate.semanticScore).toBe(0.8)
    expect(candidate.popularity).toBe(4.5)
  })

  test('类目亲和与曝光次数对所有通道的候选都生效（不只 category/fresh 通道）', () => {
    const candidates = mergeRecallCandidates({
      channels: [channel('semantic', [{ listingId: 'a', score: 0.9 }])],
      visible: [listing('a', 'seller-1', 'BOOKS')],
      impressions: new Map([['a', 3]]),
      categoryAffinity: new Map([['BOOKS', 1]]),
      now: NOW,
    })

    const candidate = candidates[0]
    if (!candidate) throw new Error('候选丢失')
    expect(candidate.category).toBe('BOOKS')
    expect(candidate.userCategoryAffinity).toBe(1)
    expect(candidate.alreadySeenCount).toBe(3)
  })

  test('没有类目亲和 / 没有曝光记录时是 null / 0，而不是 0 亲和（两者语义不同）', () => {
    const candidates = mergeRecallCandidates({
      channels: [channel('fresh', [{ listingId: 'a' }])],
      visible: [listing('a', 'seller-1', 'BOOKS')],
      ...EMPTY_MAPS,
      now: NOW,
    })

    const candidate = candidates[0]
    if (!candidate) throw new Error('候选丢失')
    expect(candidate.userCategoryAffinity).toBeNull()
    expect(candidate.alreadySeenCount).toBe(0)
  })

  test('freshness 按半衰期折半，未来时间戳钳到 1', () => {
    expect(freshnessOf(new Date(NOW.getTime()), NOW)).toBe(1)
    expect(freshnessOf(new Date(NOW.getTime() - RECALL_FRESHNESS_HALF_LIFE_MS), NOW)).toBeCloseTo(
      0.5,
      12,
    )
    expect(
      freshnessOf(new Date(NOW.getTime() - 2 * RECALL_FRESHNESS_HALF_LIFE_MS), NOW),
    ).toBeCloseTo(0.25, 12)
    // 客户端时间/时钟漂移可能造出"未来发布"的商品：钳到 1，不让它拿到 >1 的新鲜度加成。
    expect(freshnessOf(new Date(NOW.getTime() + DAY_MS), NOW)).toBe(1)
  })

  test('sellerExposure 在截断前统计：截断后每个候选看到的卖家密度不随 maxCandidates 变化', () => {
    const channels = [
      channel('fresh', [{ listingId: 'a' }, { listingId: 'b' }, { listingId: 'c' }]),
    ]
    const visible = [listing('a', 'seller-1'), listing('b', 'seller-1'), listing('c', 'seller-2')]

    const truncated = mergeRecallCandidates({
      channels,
      visible,
      ...EMPTY_MAPS,
      now: NOW,
      maxCandidates: 1,
    })
    expect(truncated).toHaveLength(1)
    // 只返回 1 件商品时，它的 sellerExposure 仍是"候选集里同卖家 2 件"——若在截断后统计会变成 1，
    // 同一个商品在 limit=1 与 limit=20 下 feature 不同，R4 的排序就不可复现了。
    expect(truncated[0]?.sellerExposure).toBe(2)
  })

  test('截断顺序：跨通道命中多者优先 → 最高优先级通道靠前者优先 → listingId 升序兜底', () => {
    const candidates = mergeRecallCandidates({
      channels: [
        channel('semantic', [
          { listingId: 'zzz', score: 0.5 },
          { listingId: 'aaa', score: 0.9 },
        ]),
        channel('popular', [{ listingId: 'zzz', score: 2 }]),
        channel('fresh', [{ listingId: 'bbb' }]),
      ],
      visible: [listing('zzz', 'seller-1'), listing('aaa', 'seller-2'), listing('bbb', 'seller-3')],
      ...EMPTY_MAPS,
      now: NOW,
    })

    // zzz 命中 2 路排第一；aaa（semantic）与 bbb（fresh）各命中 1 路，按最高优先级通道分先后；
    // 同通道内按 listingId 升序（这里 aaa 的语义分更高也不影响——R3 不做排序，排序是 R4 的事）。
    expect(candidates.map((row) => row.listingId)).toEqual(['zzz', 'aaa', 'bbb'])
  })

  test('maxCandidates 生效，且结果顺序与入参通道顺序无关（确定性）', () => {
    const visible = [listing('a', 'seller-1'), listing('b', 'seller-2'), listing('c', 'seller-3')]
    const forward = mergeRecallCandidates({
      channels: [
        channel('fresh', [{ listingId: 'a' }, { listingId: 'b' }]),
        channel('explore', [{ listingId: 'c' }]),
      ],
      visible,
      ...EMPTY_MAPS,
      now: NOW,
    })
    const reversed = mergeRecallCandidates({
      channels: [
        channel('explore', [{ listingId: 'c' }]),
        channel('fresh', [{ listingId: 'b' }, { listingId: 'a' }]),
      ],
      visible,
      ...EMPTY_MAPS,
      now: NOW,
    })

    expect(forward.map((row) => row.listingId)).toEqual(reversed.map((row) => row.listingId))
    expect(
      mergeRecallCandidates({
        channels: [channel('fresh', [{ listingId: 'a' }, { listingId: 'b' }])],
        visible,
        ...EMPTY_MAPS,
        now: NOW,
        maxCandidates: 1,
      }),
    ).toHaveLength(1)
  })

  test('compareRecallCandidates 是确定性的全序（同分不比出 0 以外的歧义）', () => {
    const build = (listingId: string): ReturnType<typeof mergeRecallCandidates>[number] => {
      const rows = mergeRecallCandidates({
        channels: [channel('fresh', [{ listingId }])],
        visible: [listing(listingId, 'seller-1')],
        ...EMPTY_MAPS,
        now: NOW,
      })
      const row = rows[0]
      if (!row) throw new Error('候选丢失')
      return row
    }

    const a = build('aaa')
    const b = build('bbb')
    expect(compareRecallCandidates(a, a)).toBe(0)
    expect(compareRecallCandidates(a, b)).toBeLessThan(0)
    expect(compareRecallCandidates(b, a)).toBeGreaterThan(0)
  })
})

describe('freshnessOf', () => {
  test('非法时间戳（age 为 NaN）返回 0：NaN 会顺着 rankScore 污染整条排序', () => {
    expect(freshnessOf(new Date('invalid'), NOW)).toBe(0)
  })
})
