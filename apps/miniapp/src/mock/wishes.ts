import type { MockMatch, MockWish, MockWishPoolItem, WishStatus } from './types'

/**
 * 愿望 fixture。字段对齐 `wishes/schema.ts` 的 `wishDtoSchema` / `wishPoolItemSchema`。
 * 预算一律整数分。
 */

const HOUR = 3600 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function iso(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString()
}

type WishSpec = {
  id: string
  userId: string
  keyword: string
  category: MockWish['category']
  min: number
  max: number
  description: string | null
  matchCount: number
  status?: WishStatus
  campus: MockWish['campus']
  timeLabel: string
  hoursAgo: number
}

const SPECS: WishSpec[] = [
  {
    id: 'w-001',
    userId: 'u-alan',
    keyword: '数据结构（C语言版）',
    category: 'BOOKS',
    min: 30,
    max: 50,
    description: '考研用 · 八成新即可，可接受少量笔记 · 校内自提',
    matchCount: 3,
    campus: '肇庆',
    timeLabel: '3 小时前',
    hoursAgo: 3,
  },
  {
    id: 'w-002',
    userId: 'u-xiaobei',
    keyword: '线性代数 同济第七版',
    category: 'BOOKS',
    min: 20,
    max: 40,
    description: '只要正版，笔记多也没关系',
    matchCount: 2,
    campus: '肇庆',
    timeLabel: '3 小时前',
    hoursAgo: 3,
  },
  {
    id: 'w-003',
    userId: 'u-chengzi',
    keyword: 'iPad 第 9/10 代',
    category: 'DIGITAL',
    min: 1200,
    max: 1800,
    description: '网课记笔记用，成色好可以加价',
    matchCount: 3,
    campus: '广州',
    timeLabel: '昨天',
    hoursAgo: 27,
  },
  {
    id: 'w-004',
    userId: 'u-susu',
    keyword: '入门民谣吉他',
    category: 'OTHER',
    min: 300,
    max: 600,
    description: '宿舍练手用，41 寸最好',
    matchCount: 1,
    campus: '肇庆',
    timeLabel: '昨天',
    hoursAgo: 30,
  },
  {
    id: 'w-005',
    userId: 'u-qiqi',
    keyword: '宿舍静音小冰箱',
    category: 'DAILY',
    min: 150,
    max: 300,
    description: '要能放下一层饮料，静音最重要',
    matchCount: 0,
    campus: '肇庆',
    timeLabel: '2 天前',
    hoursAgo: 52,
  },
  {
    id: 'w-006',
    userId: 'u-linyi',
    keyword: '机械键盘 87 键',
    category: 'DIGITAL',
    min: 100,
    max: 250,
    description: '青轴或茶轴都行，要能连笔记本',
    matchCount: 4,
    campus: '肇庆',
    timeLabel: '2 天前',
    hoursAgo: 55,
  },
  {
    id: 'w-007',
    userId: 'u-soda',
    keyword: '考研英语黄皮书',
    category: 'BOOKS',
    min: 30,
    max: 60,
    description: '2015 年以后的版本都可以',
    matchCount: 2,
    campus: '广州',
    timeLabel: '3 天前',
    hoursAgo: 74,
  },
  {
    id: 'w-008',
    userId: 'u-zhou',
    keyword: '羽毛球拍 双拍',
    category: 'SPORTS',
    min: 60,
    max: 150,
    description: '带拍包更好，周末打球用',
    matchCount: 1,
    campus: '肇庆',
    timeLabel: '3 天前',
    hoursAgo: 78,
  },
  {
    id: 'w-009',
    userId: 'u-alan',
    keyword: '罗技 K380 键盘',
    category: 'DIGITAL',
    min: 100,
    max: 180,
    description: '要白色，键帽不能打油',
    matchCount: 1,
    status: 'FULFILLED',
    campus: '肇庆',
    timeLabel: '5 天前',
    hoursAgo: 120,
  },
  {
    id: 'w-010',
    userId: 'u-xiaobei',
    keyword: '宿舍台灯',
    category: 'DAILY',
    min: 30,
    max: 100,
    description: '三档调光就行',
    matchCount: 2,
    status: 'CLOSED',
    campus: '肇庆',
    timeLabel: '6 天前',
    hoursAgo: 150,
  },
  /* C3 匹配结果稿里的愿望：命中「显示器」，预算 ¥200–¥400，已匹配 3 位同学 */
  {
    id: 'w-011',
    userId: 'u-alan',
    keyword: '显示器',
    category: 'DIGITAL',
    min: 200,
    max: 400,
    description: '想收一台 23~24 寸的 IPS 屏，无坏点即可',
    matchCount: 3,
    campus: '肇庆',
    timeLabel: '4 天前',
    hoursAgo: 96,
  },
]

export const WISHES: MockWish[] = SPECS.map((spec) => ({
  id: spec.id,
  userId: spec.userId,
  keyword: spec.keyword,
  category: spec.category,
  budgetMinCents: spec.min * 100,
  budgetMaxCents: spec.max * 100,
  description: spec.description,
  acceptSimilar: true,
  status: spec.status ?? 'ACTIVE',
  matchCount: spec.matchCount,
  createdAt: iso(spec.hoursAgo),
  campus: spec.campus,
  timeLabel: spec.timeLabel,
}))

/** 设计稿「许愿墙」主卡（WISH 吊牌）展示的那条心愿 */
export const FEATURED_WISH_ID = 'w-001'

/**
 * 需求池：对应 `wishPoolResponseSchema` 的 `items`。
 * 由愿望列表按关键词聚合得到（真实实现里也是服务端聚合，这里在 mock 层算）。
 */
export const WISH_POOL: MockWishPoolItem[] = (() => {
  const map = new Map<
    string,
    { count: number; budgets: number[]; category: MockWish['category'] }
  >()
  for (const wish of WISHES) {
    if (wish.status !== 'ACTIVE') continue
    const entry = map.get(wish.keyword) ?? { count: 0, budgets: [], category: wish.category }
    entry.count += 1
    entry.budgets.push(Math.round((wish.budgetMinCents + wish.budgetMaxCents) / 2))
    map.set(wish.keyword, entry)
  }
  return [...map.entries()]
    .map(([keyword, entry]) => {
      const sorted = [...entry.budgets].sort((a, b) => a - b)
      const mid = sorted[Math.floor(sorted.length / 2)] ?? 0
      return { keyword, category: entry.category, wantCount: entry.count, medianBudgetCents: mid }
    })
    .sort((a, b) => b.wantCount - a.wantCount)
})()

/**
 * 匹配结果：我许的愿 ↔ 命中的商品。
 * `score` 是匹配度（设计稿「匹配度 100 / 92」）。
 */
export const MATCHES: MockMatch[] = [
  /* C3 稿子：显示器 3 条命中 */
  { id: 'm-006', wishId: 'w-011', listingId: 'l-032', score: 92 },
  { id: 'm-007', wishId: 'w-011', listingId: 'l-033', score: 78 },
  { id: 'm-008', wishId: 'w-011', listingId: 'l-045', score: 64 },
  { id: 'm-001', wishId: 'w-001', listingId: 'l-004', score: 100 },
  { id: 'm-002', wishId: 'w-001', listingId: 'l-005', score: 92 },
  { id: 'm-003', wishId: 'w-001', listingId: 'l-017', score: 88 },
  { id: 'm-004', wishId: 'w-009', listingId: 'l-001', score: 96 },
  { id: 'm-005', wishId: 'w-002', listingId: 'l-004', score: 81 },
]

export function matchesForWish(wishId: string): MockMatch[] {
  return MATCHES.filter((match) => match.wishId === wishId).sort((a, b) => b.score - a.score)
}

/**
 * 许愿墙的筛选标签（设计稿 「#全部 / #教材书籍 / #数码电子 / #代步出行 / #已匹配」）。
 * 契约里没有「标签」概念，这是纯前端展示维度。
 */
export const WISH_FILTERS = [
  '全部',
  '教材书籍',
  '数码电子',
  '代步出行',
  '宿舍好物',
  '已匹配',
] as const

export type WishFilter = (typeof WISH_FILTERS)[number]

/**
 * 热门标签榜（设计稿的磨砂玻璃榜单）。
 * 契约的 `/wishes` 没有「热门标签」，所以这是**前端常量**，不来自接口。
 */
export const HOT_WISH_TAGS: { label: string; count: number }[] = [
  { label: '考研教材', count: 128 },
  { label: '机械键盘', count: 96 },
  { label: 'iPad', count: 87 },
  { label: '山地车', count: 74 },
  { label: '台灯', count: 68 },
  { label: 'Kindle', count: 55 },
  { label: '羽毛球拍', count: 49 },
  { label: '民谣吉他', count: 41 },
  { label: '宿舍冰箱', count: 36 },
  { label: '行李箱', count: 31 },
  { label: '电吹风', count: 28 },
  { label: '四六级真题', count: 24 },
]

/** 「累计成真」等营销数字（设计稿 bento 卡） */
export const WISH_STATS = {
  fulfilledTotal: 42,
  activeTotal: 128,
}
