import { describe, expect, test } from 'bun:test'
import { categoryScore, keywordScore, keywordTokens, priceScore, scoreMatch } from './scoring'

/**
 * 固定 fixture 的分数断言（`Backend Done` 第 1 条："给定 fixture Listing/Wish 能稳定得到预期分数"）。
 * 种子数据里的那对（`packages/db/src/seed.ts`）：罗技 K380 机械键盘 / DIGITAL / ¥160 / 愿望"机械键盘" / DIGITAL / 预算上限 ¥200。
 */
const seedListing = {
  title: '罗技 K380 机械键盘',
  description: '自用一年，键帽无打油，附原装收纳袋。可刀。',
  priceCents: 16000,
  category: 'DIGITAL',
} as const

describe('keywordScore', () => {
  test('scores a single-token keyword 100 when the title contains it', () => {
    expect(keywordScore(seedListing, '机械键盘')).toBe(100)
  })

  test('scores 0 when no token is present', () => {
    expect(keywordScore(seedListing, '显示器')).toBe(0)
  })

  // 多 token 求命中率：种子里的"高等数学 教材"对"高等数学上册（同济第七版）"只命中前一个 token。
  test('scores the hit ratio for multi-token keywords', () => {
    const textbook = {
      title: '高等数学上册（同济第七版）',
      description: '有少量笔记，不影响阅读。',
      priceCents: 2000,
      category: 'BOOKS',
    } as const
    expect(keywordScore(textbook, '高等数学 教材')).toBe(50)
    expect(keywordScore(textbook, '高等数学 教材 同济')).toBe(67)
  })

  test('is case-insensitive and ignores description matches', () => {
    expect(keywordScore({ ...seedListing, title: 'Logitech K380' }, 'logitech')).toBe(100)
    expect(
      keywordScore({ ...seedListing, title: '键盘', description: '含机械键盘轴体' }, '机械'),
    ).toBe(100)
  })

  test('scores 0 for an empty or whitespace-only keyword', () => {
    expect(keywordTokens('   ')).toEqual([])
    expect(keywordScore(seedListing, '   ')).toBe(0)
  })
})

describe('priceScore', () => {
  test('scores 100 when there is no budget cap or the price is within it', () => {
    expect(priceScore(seedListing, null)).toBe(100)
    expect(priceScore(seedListing, 16000)).toBe(100)
    expect(priceScore(seedListing, 20000)).toBe(100)
  })

  // 候选集收窄的界限与这里必须是同一个数：2 倍预算处归零。
  test('decays linearly and reaches 0 at twice the budget cap', () => {
    expect(priceScore(seedListing, 12000)).toBe(67)
    expect(priceScore(seedListing, 10000)).toBe(40)
    expect(priceScore(seedListing, 8000)).toBe(0)
  })

  test('handles a 0 budget cap without dividing by zero', () => {
    expect(priceScore(seedListing, 0)).toBe(0)
    expect(priceScore({ ...seedListing, priceCents: 0 }, 0)).toBe(100)
  })
})

describe('categoryScore', () => {
  test('scores equality 100 and mismatch 0, and a null wish category 0', () => {
    expect(categoryScore(seedListing, 'DIGITAL')).toBe(100)
    expect(categoryScore(seedListing, 'BOOKS')).toBe(0)
    expect(categoryScore(seedListing, null)).toBe(0)
  })
})

describe('scoreMatch', () => {
  test('matches the seed pair at 100 (cat 100 / kw 100 / price 100)', () => {
    expect(
      scoreMatch(seedListing, { keyword: '机械键盘', category: 'DIGITAL', budgetMaxCents: 20000 }),
    ).toEqual({ score: 100, categoryScore: 100, keywordScore: 100, priceScore: 100 })
  })

  // 只命中关键词与价格、分类不符 = 65，够不到 70 阈值。
  test('keeps a category-mismatched pair below the threshold even with a perfect keyword', () => {
    const breakdown = scoreMatch(seedListing, {
      keyword: '机械键盘',
      category: 'BOOKS',
      budgetMaxCents: 20000,
    })
    expect(breakdown.score).toBe(65)
  })

  /**
   * `wish.category IS NULL`（不限分类）：跳过分类分项并归一化权重。
   * 记 0 分的话"不限分类"的愿望最高只有 65 分，永远达不到阈值。
   *
   * 价格为 1.5 倍预算 → priceScore 50 → `(0.35×100 + 0.30×50) / 0.65 = 76.9 → 77`，
   * 与契约评论 §3.2 举的例子一致。
   */
  test('renormalizes the weights when the wish has no category', () => {
    const breakdown = scoreMatch(
      { ...seedListing, priceCents: 18000 },
      { keyword: '机械键盘', category: null, budgetMaxCents: 12000 },
    )
    expect(breakdown.categoryScore).toBe(0)
    expect(breakdown.priceScore).toBe(50)
    expect(breakdown.score).toBe(77)
  })
})
