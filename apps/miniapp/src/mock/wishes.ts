import type { MockWish, WishStatus } from './types'

/**
 * 愿望 fixture（字段对齐 `wishes/schema.ts` 的 `wishDtoSchema`，预算一律整数分）。
 *
 * **只服务演示回退**：许愿页 / 发布页 / 匹配结果页已全部走真接口
 * （`features/wish/api.ts`、`features/match/api.ts`），不再读这里。当前唯一消费者是
 * `mock/api.ts` 的 `myWishes()` —— 个人中心在演示构建下回退「当前用户自己的愿望」时用。
 * 愿望池的人群 fixture 与本地写（发布 / 关闭）随 #138 的本地 helper 一起删掉了。
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
    timeLabel: spec.timeLabel,
  })),
]
