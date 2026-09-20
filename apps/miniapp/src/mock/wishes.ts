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

/** 相对时间文案（与 SPECS 里手写的「3 小时前 / 昨天 / 2 天前」同口径） */
function timeLabelOf(hoursAgo: number): string {
  if (hoursAgo < 24) return `${hoursAgo} 小时前`
  if (hoursAgo < 48) return '昨天'
  return `${Math.floor(hoursAgo / 24)} 天前`
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

/**
 * `/wishes/pool` 的 k-匿名门槛：只有 **≥ 3 个不同用户**求同一个关键词，该关键词才会出现在池子里。
 *
 * 真源是 `apps/api/src/modules/wishes/service.ts` 的 `POOL_MIN_COUNT`（契约里没有这个常量，
 * 所以这里镜像一份，只为让页面的说明文案与筛选口径与后端一致）。
 */
export const POOL_MIN_COUNT = 3

/**
 * 「愿望池」的人群 fixture。
 *
 * 为什么需要它：`wantCount` 的真实语义是 `count(DISTINCT user_id)`，上面 11 条手写愿望
 * 关键词两两不同、每条只有 1 个人求 —— 聚合出来每个关键词都是 1，既进不了池子
 * （`POOL_MIN_COUNT = 3`），也会让页面上「≥ 3 人才会出现」的说明当场自相矛盾。
 *
 * 所以这里补一批**同一关键词、多人求**的愿望：每个关键词配 N 个**互不相同**的 mock 用户，
 * 使聚合结果落在 3~6 之间且各关键词之间有梯度（热门榜的热度条才有意义）。
 * 用户池刻意**不含 `u-alan`**（`ME`），否则这些愿望会混进「我的愿望」。
 * 预算区间给的是设计稿「常见预算」对应的中位数。
 */
type PoolSeed = {
  keyword: string
  category: MockWish['category']
  /** 想要人数 = 参与该关键词的用户数（互不相同），必须 ≥ POOL_MIN_COUNT */
  users: number
  /** 预算区间（元），中位数即池子卡上的「常见预算」 */
  min: number
  max: number
}

const POOL_SEEDS: PoolSeed[] = [
  { keyword: '考研数学', category: 'BOOKS', users: 6, min: 40, max: 60 },
  { keyword: '雅思真题', category: 'BOOKS', users: 4, min: 50, max: 70 },
  { keyword: 'iPad', category: 'DIGITAL', users: 6, min: 1400, max: 1600 },
  { keyword: '游戏本', category: 'DIGITAL', users: 5, min: 3800, max: 4600 },
  { keyword: '降噪耳机', category: 'DIGITAL', users: 3, min: 250, max: 350 },
  { keyword: '台灯', category: 'DAILY', users: 5, min: 50, max: 70 },
  { keyword: '人体工学椅', category: 'DAILY', users: 3, min: 400, max: 500 },
  { keyword: '山地车', category: 'TRANSPORT', users: 4, min: 500, max: 700 },
  { keyword: '羽毛球拍', category: 'SPORTS', users: 5, min: 100, max: 200 },
  { keyword: '防晒霜', category: 'BEAUTY', users: 4, min: 60, max: 100 },
  { keyword: '冲锋衣', category: 'APPAREL', users: 5, min: 250, max: 350 },
  { keyword: '行李箱', category: 'APPAREL', users: 3, min: 150, max: 210 },
  { keyword: '尤克里里', category: 'OTHER', users: 3, min: 200, max: 300 },
]

/** 「我的愿望」之外的用户池（不含 `u-alan`，见 `POOL_SEEDS` 的说明） */
const OTHER_USER_IDS = [
  'u-xiaobei',
  'u-chengzi',
  'u-susu',
  'u-linyi',
  'u-soda',
  'u-qiqi',
  'u-zhou',
  'u-lin',
  'u-zhouyan',
  'u-zhangyu',
  'u-suyiran',
  'u-xuche',
  'u-hexu',
]

const POOL_WISHES: MockWish[] = POOL_SEEDS.flatMap((seed, seedIndex) =>
  Array.from({ length: seed.users }, (_, userIndex) => {
    // 每个关键词取一段**连续**的用户，段内必不重复（users ≤ 用户池长度）；段起点错开，
    // 避免所有关键词都由同一批人求
    const userId =
      OTHER_USER_IDS[(seedIndex * 3 + userIndex) % OTHER_USER_IDS.length] ?? 'u-xiaobei'
    const hoursAgo = 6 + seedIndex * 5
    return {
      id: `w-pool-${String(seedIndex + 1).padStart(2, '0')}-${userIndex + 1}`,
      userId,
      keyword: seed.keyword,
      category: seed.category,
      budgetMinCents: seed.min * 100,
      budgetMaxCents: seed.max * 100,
      // 池子只有 keyword / category / wantCount / medianBudgetCents 四个字段
      // （`wishPoolItemSchema`），描述不会出现在界面上，所以不编内容
      description: null,
      acceptSimilar: true,
      status: 'ACTIVE' as const,
      matchCount: 0,
      createdAt: iso(hoursAgo),
      campus: null,
      timeLabel: timeLabelOf(hoursAgo),
    }
  }),
)

export const WISHES: MockWish[] = [
  ...SPECS.map((spec) => ({
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
  })),
  ...POOL_WISHES,
]

/**
 * 归一化后的关键词 —— 与服务端同口径的分组依据。
 *
 * `keywordSchema`（`packages/contracts/src/wishes/schema.ts`）入库前就 `.trim().toLowerCase()`，
 * 所以服务端 `GROUP BY keyword, category` 里的 keyword 已经是小写。mock 的 fixture 是手写的
 * （`iPad` 带大写），本地发布又走的是页面输入 —— 不归一就会出现 `iPad` / `ipad` 两个池子项，
 * 而真实接口只会有一个（#138 review P1）。
 */
function poolKeyword(keyword: string): string {
  return keyword.trim().toLowerCase()
}

/**
 * 需求池：对应 `wishPoolResponseSchema` 的 `items`。
 * 由愿望列表按关键词聚合得到（真实实现里是服务端聚合，见
 * `apps/api/src/modules/wishes/store.ts` 的 `aggregatePool`），这里在 mock 层算。
 *
 * 聚合 key = **归一化 keyword + category**，与后端 `GROUP BY keyword, category` 一致：
 * 发布页（`pages/wish-publish`）允许同一关键词选不同分类，所以「同关键词分类唯一」这个
 * 假设不成立 —— 只按 keyword 分组会把不同分类的人并成一条，且分类取决于谁先进 Map
 * （#138 review P1）。
 *
 * 口径按**页面的需求**（k-匿名是硬约束），与后端那条 SQL 有两处**有意不同**：
 * 1. `wantCount` 数的是 **不同用户**（`Set`）—— 后端 `want_count` 是 `count(*)`（行数），
 *    两者在真接口下是两个数（k-匿名门槛 `HAVING count(DISTINCT user_id)` 数的是前者）。
 *    这里取前者，是为了让池子卡上的「N 人想要」与筛选门槛口径一致。
 * 2. `medianBudgetCents` 取的是每条愿望**预算中值**（(min+max)/2）的上中位数，
 *    后端是 `percentile_cont(0.5)` on `budget_max_cents`；且后端有 `LIMIT`，
 *    mock 全量返回（页面的「展示全部 N 个标签」要能数到全部）。
 *
 * 展示用的 keyword 取该组**第一个出现**的写法：归一化只用于分组，不改变展示
 * （设计稿的 `iPad` 不该被渲染成 `ipad`）。
 *
 * 是函数而不是常量：本地写（发布 / 关闭愿望）之后池子要跟着变。
 */
export function wishPoolItems(): MockWishPoolItem[] {
  const map = new Map<
    string,
    { keyword: string; users: Set<string>; budgets: number[]; category: MockWish['category'] }
  >()
  for (const wish of WISHES) {
    if (wish.status !== 'ACTIVE') continue
    const category = wish.category
    // `\0` 分隔：关键词里不会出现它，category 是枚举，两者拼不出歧义
    const key = `${poolKeyword(wish.keyword)}\0${category}`
    const entry = map.get(key) ?? {
      keyword: wish.keyword,
      users: new Set<string>(),
      budgets: [],
      category,
    }
    entry.users.add(wish.userId)
    entry.budgets.push(Math.round((wish.budgetMinCents + wish.budgetMaxCents) / 2))
    map.set(key, entry)
  }
  return [...map.values()]
    .filter((entry) => entry.users.size >= POOL_MIN_COUNT)
    .map((entry) => {
      const sorted = [...entry.budgets].sort((a, b) => a - b)
      const mid = sorted[Math.floor(sorted.length / 2)] ?? 0
      return {
        keyword: entry.keyword,
        category: entry.category,
        wantCount: entry.users.size,
        medianBudgetCents: mid,
      }
    })
    .sort((a, b) => b.wantCount - a.wantCount)
}

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
