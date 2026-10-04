import { describe, expect, test } from 'bun:test'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import {
  type RankFeatureKey,
  type RankScoreBreakdown,
  RERANK_CATEGORY_MAX_IN_WINDOW,
  RERANK_CATEGORY_WINDOW,
  RERANK_EXPLORE_MIN_PER_WINDOW,
  RERANK_EXPLORE_WINDOW,
  RERANK_SELLER_MIN_GAP,
} from '@fish/contracts/recommendation/rank'
import type { RecallChannel } from '@fish/contracts/recommendation/recall'
import type { RecallCandidate } from '../recall/types'
import { rerankCandidates } from './rerank'
import type { ScoredCandidate } from './score'

/**
 * 重排单测（#323 R4 / M6）。
 *
 * 重排的价值全在"约束真的被守住了"和"守不住时让掉了哪一条"，所以断言分两类：
 * ① 输出里**不存在**违反约束的窗口（不是"大概打散了"）；② 让位必须被计数，且只计**确实卡住**的约束。
 */

const NOW = new Date('2026-10-02T12:00:00.000Z')

/** 重排只读 `candidate` 与 `rankScore`；明细用零值填充即可，形状必须合法。 */
const ZERO = { normalized: 0, weight: 0, contribution: 0 }
function zeroBreakdown(): RankScoreBreakdown {
  const keys: RankFeatureKey[] = [
    'semantic',
    'wish',
    'category',
    'freshness',
    'popularity',
    'repeatedExposure',
    'negativeFeedback',
  ]
  const breakdown = {} as Record<RankFeatureKey, typeof ZERO>
  for (const key of keys) breakdown[key] = { ...ZERO }
  return { ...breakdown, missing: [] }
}

type ItemSpec = {
  listingId: string
  rankScore: number
  sellerId?: string
  category?: ListingCategory
  primarySource?: RecallChannel
  /** 命中多个通道时用（M6 的 `wish` 豁免看的是整个 `recallSources`，不只是 primary）。 */
  recallSources?: RecallChannel[]
}

function scored(spec: ItemSpec): ScoredCandidate {
  const candidate: RecallCandidate = {
    listingId: spec.listingId,
    sellerId: spec.sellerId ?? `seller-${spec.listingId}`,
    category: spec.category ?? 'DIGITAL',
    recallSources: spec.recallSources ?? [spec.primarySource ?? 'fresh'],
    semanticScore: null,
    wishScore: null,
    popularity: null,
    userCategoryAffinity: null,
    freshness: 0.5,
    createdAt: NOW,
    alreadySeenCount: 0,
    sellerExposure: 1,
  }
  return { candidate, rankScore: spec.rankScore, breakdown: zeroBreakdown() }
}

function ids(items: readonly ScoredCandidate[]): string[] {
  return items.map((item) => item.candidate.listingId)
}

const NO_HIDDEN: ReadonlySet<string> = new Set()

/** 依次取不同类目：用来把"类目窗口"这条约束从别的用例里摘干净。 */
const CATEGORIES: readonly ListingCategory[] = [
  'DIGITAL',
  'BOOKS',
  'BEAUTY',
  'DAILY',
  'SPORTS',
  'APPAREL',
]
function categoryAt(index: number): ListingCategory {
  return CATEGORIES[index % CATEGORIES.length] ?? 'OTHER'
}

/** 输出里是否存在"连续 `span` 条同类目"的窗口。 */
function hasCategoryRun(items: readonly ScoredCandidate[], span: number): boolean {
  for (let start = 0; start + span <= items.length; start += 1) {
    const window = items.slice(start, start + span)
    const first = window[0]?.candidate.category
    if (window.every((item) => item.candidate.category === first)) return true
  }
  return false
}

/** 输出里是否存在"相邻同卖家"。 */
function hasAdjacentSameSeller(items: readonly ScoredCandidate[]): boolean {
  for (let index = 1; index < items.length; index += 1) {
    if (items[index]?.candidate.sellerId === items[index - 1]?.candidate.sellerId) return true
  }
  return false
}

describe('基本形状', () => {
  test('limit 之外的不入选，`droppedOverflow` 如实计数', () => {
    const pool = ['a', 'b', 'c', 'd'].map((id, index) =>
      scored({ listingId: id, rankScore: 10 - index }),
    )
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 'seed',
      limit: 2,
    })

    expect(ids(items)).toEqual(['a', 'b'])
    expect(summary).toEqual({
      inputCount: 4,
      droppedHidden: 0,
      droppedCooldown: 0,
      droppedOverflow: 2,
      relaxations: { seller: 0, category: 0, explore: 0 },
    })
  })

  test('limit 大于候选池时全放行；limit = 0 时一条都不放', () => {
    const pool = ['a', 'b'].map((id, index) => scored({ listingId: id, rankScore: 5 - index }))
    expect(
      ids(
        rerankCandidates({ scored: pool, hiddenListingIds: NO_HIDDEN, seed: 's', limit: 10 }).items,
      ),
    ).toEqual(['a', 'b'])

    const zero = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 0,
    })
    expect(zero.items).toEqual([])
    expect(zero.summary.droppedOverflow).toBe(2)
  })

  test('硬排除的 listing 不出现，且计入 `droppedHidden`', () => {
    const pool = [
      scored({ listingId: 'a', rankScore: 3 }),
      scored({ listingId: 'hidden', rankScore: 2 }),
      scored({ listingId: 'b', rankScore: 1 }),
    ]
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: new Set(['hidden']),
      seed: 's',
      limit: 10,
    })

    expect(ids(items)).toEqual(['a', 'b'])
    expect(summary.droppedHidden).toBe(1)
    expect(summary.inputCount).toBe(3)
  })

  test('输入未排序时也会按分数从高到低重排（函数自己保证前提）', () => {
    const pool = [
      scored({ listingId: 'low', rankScore: 1 }),
      scored({ listingId: 'high', rankScore: 9 }),
      scored({ listingId: 'mid', rankScore: 5 }),
    ]
    const { items } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 3,
    })
    expect(ids(items)).toEqual(['high', 'mid', 'low'])
  })

  test('空候选集 → 空结果，计数全 0（降级路径依赖它）', () => {
    const { items, summary } = rerankCandidates({
      scored: [],
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 20,
    })
    expect(items).toEqual([])
    expect(summary).toEqual({
      inputCount: 0,
      droppedHidden: 0,
      droppedCooldown: 0,
      droppedOverflow: 0,
      relaxations: { seller: 0, category: 0, explore: 0 },
    })
  })
})

describe('seller 间隔', () => {
  test('同一卖家的商品不相邻：分数更高的同卖家商品会被让到后面', () => {
    // 两条同卖家（分数 3/2）+ 一条异卖家（分数 1）：不重排就是 a,b 相邻。
    const pool = [
      scored({ listingId: 'a', rankScore: 3, sellerId: 's1' }),
      scored({ listingId: 'b', rankScore: 2, sellerId: 's1' }),
      scored({ listingId: 'x', rankScore: 1, sellerId: 's2' }),
    ]
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 3,
    })

    expect(hasAdjacentSameSeller(items)).toBe(false)
    expect(ids(items)).toEqual(['a', 'x', 'b'])
    // 有可用的异卖家 ⇒ 不该动到松弛阶梯。
    expect(summary.relaxations.seller).toBe(0)
  })

  test('3 条同卖家 + 1 条异卖家时相邻不可避免：让掉 seller 并如实计数', () => {
    // 鸽笼原理：1 条异卖家分不开 3 条同卖家，一定有一对相邻 —— 这时必须"让位且记账"，
    // 而不是静默输出违反约束的顺序（记账才能从线上指标看出候选池的结构问题）。
    const pool = [
      scored({ listingId: 'a', rankScore: 3, sellerId: 's1' }),
      scored({ listingId: 'b', rankScore: 2, sellerId: 's1' }),
      scored({ listingId: 'c', rankScore: 1, sellerId: 's1' }),
      scored({ listingId: 'x', rankScore: 0.5, sellerId: 's2' }),
    ]
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 4,
    })

    expect(ids(items)).toEqual(['a', 'x', 'b', 'c'])
    expect(summary.relaxations.seller).toBeGreaterThan(0)
    // 让位发生在最后一条上：前两条仍然是"同卖家不相邻"的。
    expect(hasAdjacentSameSeller(items.slice(0, 3))).toBe(false)
  })

  test('只有同卖家可用时（卖家池耗尽）才让掉 seller，并记一次', () => {
    const pool = ['a', 'b', 'c'].map((id, index) =>
      scored({ listingId: id, rankScore: 3 - index, sellerId: 'only' }),
    )
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 3,
    })

    expect(ids(items)).toEqual(['a', 'b', 'c'])
    expect(summary.relaxations.seller).toBeGreaterThan(0)
    expect(RERANK_SELLER_MIN_GAP).toBeGreaterThanOrEqual(2)
  })
})

describe('category 窗口', () => {
  test('候选池允许时，不存在"连续 3 条同类目"的窗口，且无需松弛', () => {
    const pool = [
      scored({ listingId: 'd1', rankScore: 5, category: 'DIGITAL' }),
      scored({ listingId: 'd2', rankScore: 4, category: 'DIGITAL' }),
      scored({ listingId: 'd3', rankScore: 3, category: 'DIGITAL' }),
      scored({ listingId: 'b1', rankScore: 2, category: 'BOOKS' }),
      scored({ listingId: 'b2', rankScore: 1, category: 'BOOKS' }),
    ]
    // limit 取 4：5 条时"每 5 位至少 1 条探索"会被触发（这个池子里没有探索候选），
    // 那条与类目规则无关，会污染本用例的"无需松弛"断言。
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 4,
    })

    expect(hasCategoryRun(items, RERANK_CATEGORY_WINDOW)).toBe(false)
    expect(summary.relaxations).toEqual({ seller: 0, category: 0, explore: 0 })
    // 窗口上限 2 意味着"最多两条连续"——第一条异类目必须出现在第 3 位之前。
    expect(ids(items).slice(0, 3)).toEqual(['d1', 'd2', 'b1'])
  })

  test('全同类目时让掉 category 并计数（不是静默违反）', () => {
    const pool = ['a', 'b', 'c', 'd'].map((id, index) =>
      scored({ listingId: id, rankScore: 4 - index, category: 'DIGITAL' }),
    )
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 4,
    })

    expect(ids(items)).toEqual(['a', 'b', 'c', 'd'])
    expect(summary.relaxations.category).toBeGreaterThan(0)
    expect(RERANK_CATEGORY_MAX_IN_WINDOW).toBeLessThan(RERANK_CATEGORY_WINDOW)
  })
})

describe('explore 配额', () => {
  test('窗口内至少一条探索候选：探索候选分数最低也会被强制放进窗口', () => {
    const pool = [
      // 类目各不相同：否则"连续 3 条同类目"会先把探索候选挡住，让这个用例测不到配额规则。
      ...['n1', 'n2', 'n3', 'n4', 'n5'].map((id, index) =>
        scored({ listingId: id, rankScore: 100 - index, category: categoryAt(index) }),
      ),
      // 分数最低，正常排序下永远进不了前 5。
      scored({ listingId: 'e1', rankScore: 0, primarySource: 'explore', category: 'TRANSPORT' }),
    ]
    const { items } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 'seed-a',
      limit: RERANK_EXPLORE_WINDOW,
    })

    const exploreCount = items.filter(
      (item) => item.candidate.recallSources[0] === 'explore',
    ).length
    expect(exploreCount).toBeGreaterThanOrEqual(RERANK_EXPLORE_MIN_PER_WINDOW)
    // 前 5 位（= 第一个窗口）里必须有它，而不是排在更后面。
    expect(ids(items).slice(0, RERANK_EXPLORE_WINDOW)).toContain('e1')
  })

  test('完全没有探索候选时让掉 explore 并计数（配额不可能满足）', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      scored({ listingId: id, rankScore: 5 - index }),
    )
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 5,
    })

    expect(items).toHaveLength(5)
    expect(summary.relaxations.explore).toBeGreaterThan(0)
    // 让掉配额不等于乱序：仍然按分数从高到低。
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('探索位用种子哈希打散：同一 seed 可复现，不同 seed 会选到不同探索候选', () => {
    const build = (seed: string): string[] => {
      const pool = [
        ...['n1', 'n2', 'n3', 'n4'].map((id, index) =>
          scored({ listingId: id, rankScore: 100 - index, category: categoryAt(index) }),
        ),
        scored({ listingId: 'e1', rankScore: 2, primarySource: 'explore', category: 'TRANSPORT' }),
        scored({ listingId: 'e2', rankScore: 1, primarySource: 'explore', category: 'OTHER' }),
      ]
      return ids(
        rerankCandidates({ scored: pool, hiddenListingIds: NO_HIDDEN, seed, limit: 5 }).items,
      )
    }

    // 可复现：同一个请求重放得到同一份顺序。
    expect(build('seed-a')).toEqual(build('seed-a'))

    const chosen = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      const picked = build(`seed-${index}`).find((id) => id === 'e1' || id === 'e2')
      if (picked !== undefined) chosen.add(picked)
    }
    // 两个探索候选都被选到过 ⇒ 哈希确实在打散，而不是永远给同一条（那就失去了"探索"的意义）。
    expect(chosen.size).toBe(2)
  })
})

describe('松弛只计"确实卡住"的约束', () => {
  test('没有探索候选、但 seller/category 都不缺时，只让 explore', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      scored({
        listingId: id,
        rankScore: 5 - index,
        category: index % 2 === 0 ? 'DIGITAL' : 'BOOKS',
      }),
    )
    const { summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 5,
    })

    expect(summary.relaxations.explore).toBeGreaterThan(0)
    // 类目/卖家本来就没卡住，不该被记一笔 —— 否则计数就失去诊断意义（看不出池子到底缺什么）。
    expect(summary.relaxations.seller).toBe(0)
    expect(summary.relaxations.category).toBe(0)
  })

  test('三类约束同时不可能满足时，最终仍能填满 limit 且计数总和 = 让位次数', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) =>
      scored({ listingId: id, rankScore: 6 - index, sellerId: 'only', category: 'DIGITAL' }),
    )
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 6,
    })

    expect(items).toHaveLength(6)
    const total =
      summary.relaxations.seller + summary.relaxations.category + summary.relaxations.explore
    expect(total).toBeGreaterThan(0)
    expect(summary.droppedOverflow).toBe(0)
  })
})

describe('重复曝光冷却（M6）', () => {
  test('冷却集合里的候选被剔除，且与 `droppedHidden` 分开计数', () => {
    const pool = [
      scored({ listingId: 'a', rankScore: 3 }),
      scored({ listingId: 'cooling', rankScore: 2 }),
      scored({ listingId: 'hidden', rankScore: 1.5 }),
      scored({ listingId: 'b', rankScore: 1 }),
    ]
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: new Set(['hidden']),
      cooldownListingIds: new Set(['cooling']),
      seed: 's',
      limit: 10,
    })

    expect(ids(items)).toEqual(['a', 'b'])
    expect(summary.droppedCooldown).toBe(1)
    expect(summary.droppedHidden).toBe(1)
  })

  test('命中 `wish` 召回通道的候选豁免冷却（M6「Wish 命中时允许重新进入」）', () => {
    const pool = [
      scored({ listingId: 'wished', rankScore: 2, recallSources: ['fresh', 'wish'] }),
      scored({ listingId: 'plain', rankScore: 1 }),
    ]
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      // 两条都在冷却名单里，但 `wished` 的召回通道里有 wish ⇒ 只有 `plain` 被剔。
      cooldownListingIds: new Set(['wished', 'plain']),
      seed: 's',
      limit: 10,
    })

    expect(ids(items)).toEqual(['wished'])
    expect(summary.droppedCooldown).toBe(1)
  })

  test('缺省不传冷却集合 = 空集（调用方 fail-open 的语义）', () => {
    const pool = ['a', 'b'].map((id, index) => scored({ listingId: id, rankScore: 2 - index }))
    const { items, summary } = rerankCandidates({
      scored: pool,
      hiddenListingIds: NO_HIDDEN,
      seed: 's',
      limit: 10,
    })

    expect(ids(items)).toEqual(['a', 'b'])
    expect(summary.droppedCooldown).toBe(0)
  })
})
