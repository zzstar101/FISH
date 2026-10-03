import { describe, expect, test } from 'bun:test'
import {
  RANKING_VERSION,
  RANKING_VERSION_V1,
  SEMANTIC_SCORE_CEILING,
  SEMANTIC_SCORE_FLOOR,
} from '@fish/contracts/matching/schema'
import {
  categoryScore,
  keywordScore,
  keywordTokens,
  normalizeSimilarity,
  priceScore,
  scoreMatch,
} from './scoring'

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

describe('scoreMatch（v1 分支：拿不到 cosine 时逐位退回 #8 的算法）', () => {
  test('matches the seed pair at 100 (cat 100 / kw 100 / price 100)', () => {
    expect(
      scoreMatch(
        seedListing,
        { keyword: '机械键盘', category: 'DIGITAL', budgetMaxCents: 20000, acceptSimilar: true },
        null,
      ),
    ).toEqual({
      score: 100,
      categoryScore: 100,
      keywordScore: 100,
      priceScore: 100,
      semanticScore: null,
      rankingVersion: 1,
    })
  })

  // 只命中关键词与价格、分类不符 = 65，够不到 70 阈值。
  test('keeps a category-mismatched pair below the threshold even with a perfect keyword', () => {
    const breakdown = scoreMatch(
      seedListing,
      { keyword: '机械键盘', category: 'BOOKS', budgetMaxCents: 20000, acceptSimilar: true },
      null,
    )
    expect(breakdown.score).toBe(65)
    expect(breakdown.rankingVersion).toBe(1)
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
      { keyword: '机械键盘', category: null, budgetMaxCents: 12000, acceptSimilar: true },
      null,
    )
    expect(breakdown.categoryScore).toBe(0)
    expect(breakdown.priceScore).toBe(50)
    expect(breakdown.score).toBe(77)
  })
})

describe('normalizeSimilarity（锚点分段线性，端点闭合）', () => {
  test('maps the two anchors and clamps outside them', () => {
    expect(normalizeSimilarity(SEMANTIC_SCORE_FLOOR)).toBe(0)
    expect(normalizeSimilarity(SEMANTIC_SCORE_CEILING)).toBe(100)
    // 区间中点 → 50（线性，不是 sigmoid）。
    expect(normalizeSimilarity((SEMANTIC_SCORE_FLOOR + SEMANTIC_SCORE_CEILING) / 2)).toBe(50)
    // FLOOR 以下一律 0：cosine 0.2/0.4 与 -1 对"语义相关"没有区别。
    expect(normalizeSimilarity(SEMANTIC_SCORE_FLOOR - 0.3)).toBe(0)
    expect(normalizeSimilarity(-1)).toBe(0)
    // CEILING 以上一律 100。
    expect(normalizeSimilarity(1)).toBe(100)
  })
})

describe('scoreMatch（v2 hybrid：语义分参与）', () => {
  const wish = {
    keyword: '机械键盘',
    category: 'DIGITAL',
    budgetMaxCents: 20000,
    acceptSimilar: true,
  } as const

  test('结构全中 + 语义满分 = 100，且落库语义分与版本号', () => {
    expect(scoreMatch(seedListing, wish, { similarity: SEMANTIC_SCORE_CEILING })).toEqual({
      score: 100,
      categoryScore: 100,
      keywordScore: 100,
      priceScore: 100,
      semanticScore: 100,
      rankingVersion: RANKING_VERSION,
    })
  })

  test('锚点以下语义分是 v2 的真实 0（不是退回 v1）', () => {
    const breakdown = scoreMatch(seedListing, wish, { similarity: 0.2 })
    expect(breakdown.semanticScore).toBe(0)
    expect(breakdown.rankingVersion).toBe(RANKING_VERSION)
    // S4（冻结）权重：0.30×0 + 0.32×100 + 0.15×100 + 0.23×100 = 70（正好在阈值上）。
    expect(breakdown.score).toBe(70)
    expect(breakdown.score).toBeGreaterThanOrEqual(70)
  })

  test('不限分类：M4 起分类分项按 100 计（约束天然满足，不再摊薄结构证据）', () => {
    const breakdown = scoreMatch(
      seedListing,
      { keyword: '机械键盘', category: null, budgetMaxCents: 20000, acceptSimilar: true },
      { similarity: SEMANTIC_SCORE_CEILING },
    )
    expect(breakdown.categoryScore).toBe(100)
    // 0.30×100 + 0.32×100 + 0.15×100 + 0.23×100 = 100（M3 的 renormalize 口径下同为 100，
    // 差别在"关键词没命中"的对上：那时 satisfied 仍保留 0.32×100 的分类分）。
    expect(breakdown.score).toBe(100)
  })

  /**
   * `acceptSimilar = false` 的门禁（#322 验收："不能仅凭高语义跨产品召回"）。
   *
   * 绑定的场景只有一个：**不限分类**愿望（没有分类约束）+ 关键词没命中 → 语义若单独成立，
   * 就是"仅凭高语义跨产品召回"。所以这条用例用 不限分类 的愿望。
   */
  test('acceptSimilar=false：不限分类且关键词没命中时，语义分记 0', () => {
    const strict = {
      keyword: '显示器', // 对 K380 的标题/描述 0 命中
      category: null,
      budgetMaxCents: 20000,
      acceptSimilar: false,
    } as const

    const gated = scoreMatch(seedListing, strict, { similarity: SEMANTIC_SCORE_CEILING })
    expect(gated.keywordScore).toBe(0)
    expect(gated.semanticScore).toBe(0)
    // 0.32×100（不限分类按 100）+ 0.23×100 = 55
    expect(gated.score).toBe(55)

    // 同一对换成"接受相似品"：语义正常计权 → 85，差异可验证。
    const loose = scoreMatch(
      seedListing,
      { ...strict, acceptSimilar: true },
      { similarity: SEMANTIC_SCORE_CEILING },
    )
    expect(loose.semanticScore).toBe(100)
    // 0.30×100 + 0.32×100 + 0.23×100 = 85
    expect(loose.score).toBe(85)
    expect(loose.score).toBeGreaterThan(gated.score)
  })

  /**
   * M4 把门禁从 `keyword-or-category` 收紧到 `keyword-only`：分类等值在"同分类不同产品"时恒成立
   * （校园二手场景里 DIGITAL 下既有键盘也有耳机），把它当结构支撑等于让开关形同虚设。
   *
   * 这里用与 K380 **分类相同**（DIGITAL）、词法 0 命中的愿望：收紧前语义会被放行到 85 分，
   * 收紧后语义记 0、只剩分类与价格 = 55 分（`cal-acceptfalse-tent` 就是这一类）。
   */
  test('acceptSimilar=false：分类命中不算结构支撑，语义不得单独成立', () => {
    const breakdown = scoreMatch(
      seedListing,
      { keyword: '显示器', category: 'DIGITAL', budgetMaxCents: 20000, acceptSimilar: false },
      { similarity: SEMANTIC_SCORE_CEILING },
    )
    expect(breakdown.categoryScore).toBe(100)
    expect(breakdown.keywordScore).toBe(0)
    expect(breakdown.semanticScore).toBe(0)
    // 0.32×100 + 0.23×100 = 55 < 70
    expect(breakdown.score).toBe(55)
    expect(breakdown.score).toBeLessThan(70)
  })

  test('acceptSimilar=false 但有结构支撑（关键词命中）时语义照常计权', () => {
    const breakdown = scoreMatch(
      seedListing,
      { keyword: '机械键盘', category: 'BOOKS', budgetMaxCents: 20000, acceptSimilar: false },
      { similarity: SEMANTIC_SCORE_CEILING },
    )
    expect(breakdown.keywordScore).toBe(100)
    expect(breakdown.semanticScore).toBe(100)
    // 0.30×100 + 0.32×0 + 0.15×100 + 0.23×100 = 68
    expect(breakdown.score).toBe(68)
  })

  test('v1 与 v2 的版本号常量不相等（落库 CHECK 依赖这一点）', () => {
    expect(RANKING_VERSION_V1).not.toBe(RANKING_VERSION)
    expect(RANKING_VERSION_V1).toBe(1)
    expect(RANKING_VERSION).toBe(2)
  })
})
