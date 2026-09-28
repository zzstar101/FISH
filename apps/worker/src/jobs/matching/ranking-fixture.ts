// ---------------------------------------------------------------------------
// #322 M3 人工标注排序样本（Issue 的 "人工标注 fixture" 验收项）。
//
// 为什么人工给 cosine 而不是跑 provider：
//   * CI 不出网，stub provider 的余弦尺度与真实 embedding 不可比（见
//     `apps/worker/src/jobs/embedding/providers/stub.ts` 的注释）；
//   * 本 fixture 考核的是 "拿到 cosine 之后的归一化与加权排序是否符合人工判断"，
//     模型语义质量本身由 M4 的 live smoke 考核。
//
// 每条样本的 `similarity` 代表 "一个真实 embedding 模型在这一对上大概会给多少"，
// `expectMatch` 是人工判断（该不该成为有效匹配，即 score >= MATCH_SCORE_THRESHOLD）。
// 样本覆盖 Issue 点名的九类：完全词法命中 / 中文同义表达 / 品牌型号表达 /
// 描述命中但标题不命中 / 高语义但错误分类 / 高语义但超价 / acceptSimilar=false 的
// 近似商品 / acceptSimilar=true 的替代商品 / 完全无关。
// ---------------------------------------------------------------------------

import type { MatchListingFacts, MatchWishFacts } from './scoring'

export type RankingSampleClass =
  | 'exact-lexical'
  | 'chinese-synonym'
  | 'brand-model'
  | 'description-only'
  | 'semantic-category-mismatch'
  | 'semantic-over-budget'
  | 'accept-similar-false'
  | 'accept-similar-true'
  | 'unrelated'

export type RankingSample = {
  id: string
  sampleClass: RankingSampleClass
  /** 商品侧事实（`scoreMatch` 的第一个参数）。 */
  listing: MatchListingFacts
  /** 愿望侧事实（`scoreMatch` 的第二个参数）。 */
  wish: MatchWishFacts
  /** 人工给定的 cosine（真实模型在该对上的语义强度）。 */
  similarity: number
  /** 人工判断：该不该成为有效匹配。 */
  expectMatch: boolean
  /** 冻结权重后如果与该判断不一致，在这里写明为什么可以接受。 */
  knownDivergence?: string
  /** 一句话理由（PR 表格逐条贴）。 */
  rationale: string
}

const K380: MatchListingFacts = {
  title: '罗技 K380 机械键盘',
  description: '自用一年，键帽无打油，附原装收纳袋。可刀。',
  priceCents: 16000,
  category: 'DIGITAL',
}

const K380_PORTABLE: MatchListingFacts = {
  title: '罗技 K380 键盘',
  description: '轻巧便携，蓝牙三设备切换，适合长时间码字。',
  priceCents: 16000,
  category: 'DIGITAL',
}

const TEXTBOOK: MatchListingFacts = {
  title: '高等数学上册（同济第七版）',
  description: '有少量笔记，不影响阅读。',
  priceCents: 2000,
  category: 'BOOKS',
}

const AIRPODS: MatchListingFacts = {
  title: 'AirPods Pro 2 USB-C',
  description: '主动降噪，通透模式，续航 6 小时。',
  priceCents: 129000,
  category: 'DIGITAL',
}

const LAMP: MatchListingFacts = {
  title: '小米台灯 Pro',
  description: '无频闪，可调色温。',
  priceCents: 8900,
  category: 'DAILY',
}

export const RANKING_FIXTURE: RankingSample[] = [
  {
    id: 'k380-exact-lexical',
    sampleClass: 'exact-lexical',
    listing: K380,
    wish: {
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.93,
    expectMatch: true,
    rationale:
      '关键词整词命中 + 分类一致 + 预算内：v1 的 100 分样例，hybrid 必须继续判为匹配（core smoke 的 K380 demo 就是这一对）。',
  },
  {
    id: 'textbook-partial-keyword',
    sampleClass: 'exact-lexical',
    listing: TEXTBOOK,
    wish: {
      keyword: '高等数学 教材',
      category: 'BOOKS',
      budgetMaxCents: 3000,
      acceptSimilar: false,
    },
    similarity: 0.9,
    expectMatch: true,
    rationale:
      'keyword 两个 token 只命中一个（“教材”没出现），v1 = 83；acceptSimilar=false 但分类与关键词都有结构支撑，语义分应正常参与。',
  },
  {
    id: 'k380-synonym-same-category',
    sampleClass: 'chinese-synonym',
    listing: K380_PORTABLE,
    wish: {
      keyword: '静音键盘',
      category: 'DIGITAL',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.88,
    expectMatch: true,
    rationale:
      '愿望关键词是一个整体 token，标题与描述里都没有这个子串 ⇒ keywordScore 0；只能靠语义 + 分类 + 预算过阈值，正是 Issue 要求的“无 substring 的语义近似可被召回”。',
  },
  {
    id: 'airpods-brand-model',
    sampleClass: 'brand-model',
    listing: AIRPODS,
    wish: {
      keyword: '苹果降噪耳机',
      category: 'DIGITAL',
      budgetMaxCents: 150000,
      acceptSimilar: true,
    },
    similarity: 0.91,
    expectMatch: true,
    rationale:
      'Issue 点名的场景：愿望写“苹果降噪耳机”，商品是“AirPods Pro 2 USB-C”，文本零 token 重叠（“降噪”只在描述里但整 token 不匹配），只有语义能连上。',
  },
  {
    id: 'k380-description-only',
    sampleClass: 'description-only',
    listing: {
      title: '罗技 K380 键盘',
      description: '键帽无打油，机械键盘手感，附原装收纳袋。',
      priceCents: 16000,
      category: 'DIGITAL',
    },
    wish: {
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.86,
    expectMatch: true,
    rationale:
      '关键词只在描述里出现、标题不含：v1 的 keywordScore 已经把描述算进 haystack，hybrid 不能把这种对压到阈值以下。',
  },
  {
    id: 'keyboard-books-category-mismatch',
    sampleClass: 'semantic-category-mismatch',
    listing: K380,
    wish: {
      keyword: '机械键盘',
      category: 'BOOKS',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.88,
    expectMatch: false,
    rationale:
      '分类不符（愿望要书、商品是数码）：v1 恰好 65 分被挡在阈值外。语义相似度高，hybrid 不该仅凭语义把它推过 70 —— 否则“愿望改过分类”的历史行会重新出现在读接口里。',
  },
  {
    id: 'k380-over-budget',
    sampleClass: 'semantic-over-budget',
    listing: K380,
    wish: {
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMaxCents: 9000,
      acceptSimilar: true,
    },
    similarity: 0.9,
    expectMatch: true,
    rationale:
      '价格 1.78× 预算（仍在 2× 收窄边界内 ⇒ 仍是结构化候选，读接口也允许展示）：priceScore 只剩 22。v1 = 77 仍匹配；本样本确认语义分不会把价格分项挤掉。',
  },
  {
    id: 'any-category-similar-false',
    sampleClass: 'accept-similar-false',
    listing: K380,
    wish: {
      keyword: '数码好物',
      category: null,
      budgetMaxCents: 20000,
      acceptSimilar: false,
    },
    similarity: 0.9,
    expectMatch: false,
    rationale:
      '不限分类 + 关键词 0 命中 ⇒ 唯一结构支撑是价格。acceptSimilar=false 明说“不能仅凭高语义相似跨产品召回”，语义分必须被门禁记 0。',
  },
  {
    id: 'any-category-similar-true',
    sampleClass: 'accept-similar-true',
    listing: K380,
    wish: {
      keyword: '数码好物',
      category: null,
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.9,
    expectMatch: true,
    rationale:
      '与上一条只差 acceptSimilar：true 时允许“同用途 / 近似品牌型号”进入，语义分参与后应过阈值 —— 这就是 acceptSimilar 必须产生可验证差异的那一对。',
  },
  {
    id: 'any-category-synonym',
    sampleClass: 'chinese-synonym',
    listing: K380_PORTABLE,
    wish: {
      keyword: '静音键盘',
      category: null,
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.87,
    expectMatch: true,
    rationale:
      '不限分类 + 关键词 0 命中 + 高语义：语义必须能单独把这一对送过阈值，否则“不限分类”的愿望永远只能靠词法命中，语义召回形同不存在。',
  },
  {
    id: 'unrelated-textbook-keyboard',
    sampleClass: 'unrelated',
    listing: TEXTBOOK,
    wish: {
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.15,
    expectMatch: false,
    rationale: '完全无关：语义低、分类不符、关键词不命中，任何权重集都必须判不匹配。',
  },
  {
    id: 'unrelated-lamp-keyboard',
    sampleClass: 'unrelated',
    listing: LAMP,
    wish: {
      keyword: '机械键盘',
      category: null,
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    similarity: 0.32,
    expectMatch: false,
    rationale: '不限分类 + 低语义：防止“不限分类”变成什么都匹配（价格在预算内也不能过阈值）。',
  },
]
