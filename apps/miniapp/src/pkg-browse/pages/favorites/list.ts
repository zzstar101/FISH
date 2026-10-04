/**
 * 「我的收藏」的纯逻辑与**演示数据**（不 import Taro / 组件 / 图片资源，
 * `tests/favorites-list.test.ts` 直接 import）。
 *
 * ## 数据口径（依据《四页面并行-收藏历史评论关注》§2；端点随 #394 上线）
 *
 * **收藏在契约 / API 两层已实现**：契约在 `@fish/contracts/favorites`，端点是
 * `GET /me/favorites`（列表）与 `GET|POST|DELETE /listings/:id/favorite`（单品态与两个幂等写）。
 * 所以本页有两种真实形态，**都不再是「缺口空态」**：
 *
 * - **真实构建**（`MOCK_FALLBACK_ENABLED === false`）：页面调真接口，于是有三种状态 ——
 *   骨架屏 / 列表 / 真空态（`emptyCopy(segment, false)`，说的是「你还没有收藏」）；
 * - **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`）：用下面的 fixture。
 *
 * ## 契约行 → 本页行的适配（`toFavoriteItems`）
 *
 * 契约给的是**商品卡片 + 收藏时间**（`FavoriteItemSchema = { listing: ListingCardSchema,
 * favoritedAt }`），本页要的是排版用的行（分段、品类小字、色块、收藏时间人话）。
 * 中间这一层是纯函数、放在本模块而不是页面里，`tests/favorites-list.test.ts` 直接测它。
 *
 * **契约不新增「是否失效」字段**（见 `favorites/schema.ts` 的说明）：分段完全由
 * `listing.status` 推出来 —— `SOLD` → 「已卖掉」、`OFFLINE` → 「已下架」、
 * `ACTIVE` / `RESERVED` → 有效段。这也意味着**收藏行不会因为商品下架而消失**，
 * 它只是换一段呈现。
 *
 * ## 演示数据与「我的」页对得上
 *
 * `features/fetchers.ts` 的 `demoProfile()` 给 `favoritesCount: 8`（那是「我的」页数字栏
 * 唯一能显示这个数的地方，见 `pages/profile` 的注释）。这里的 fixture 因此也必须是
 * **8 件 = 6 有效 + 2 失效**，否则演示时会出现「数字栏 8、点进来 6 件」这种自相矛盾。
 * 条数与字段照稿 `小程序1版favorites.html` 的 `DATA` 表。
 *
 * **刻意没有 `priceDropCents` / 降价角标**：Owner 2026-09-22 决策③b（不做降价提醒），
 * 稿里连字段一起删了 —— 留着一个没人消费的字段，下次有人看见就会以为该画出来。
 *
 * **色块不新增色值**：稿的 `DATA` 给的是内联 hex（`av:'#9FB0CE'` / `--blk-*`），
 * 本目录禁止内联新色值，所以缩略图取 `mock/blocks.ts` 的**分类基色**（由令牌派生），
 * 头像取 `AVATAR_BLOCKS`（同上），下标写在 fixture 里。
 */
import type { FavoriteItem as ContractFavoriteItem } from '@fish/contracts/favorites/schema'
import type { ListingCategory, ListingStatus } from '@fish/contracts/listings/schema'
import { shortCategoryLabel } from '@/features/comments/mine'
import { relativeTimeOf } from '@/lib/time'
import { AVATAR_BLOCKS, LISTING_BLOCKS } from '@/mock/blocks'

/** 分段：两段互斥（有效 ⊎ 失效 = 全部） */
export type FavoriteSegment = 'sale' | 'gone'

/**
 * 二级栏的两段。**不摆计数**。
 *
 * 稿的原本理由是「统计行就在同一屏，胶囊再摆一遍是重复」；Owner 2026-09-23 把统计行
 * 整行去掉了，但**结论不变** —— 两段只有两段，件数在列表末尾的「已显示全部 N 件」里
 * 已经说了，胶囊上再挂一个数字仍是重复。
 */
export const FAVORITE_SEGMENTS: { key: FavoriteSegment; label: string }[] = [
  { key: 'sale', label: '有效宝贝' },
  { key: 'gone', label: '失效宝贝' },
]

/** 失效原因：只区分这两种角标文案，两者都进「失效宝贝」段（稿的 `gone` 字段） */
export type FavoriteGoneReason = '已下架' | '已卖掉'

type FavoriteBase = {
  id: string
  category: ListingCategory
  /** 缩略图里的品类小字（稿 `DATA.label`） */
  categoryText: string
  title: string
  /** 整数分（契约口径）；页面用 `lib/money` 的 `formatAmount` 投影成「760」 */
  priceCents: number
  seller: string
  /** 头像色块（`AVATAR_BLOCKS` 的下标，见文件头「色块不新增色值」） */
  avatarUrl: string
  verified: boolean
  /**
   * 「N 人想要」。**契约里没有这个计数**（`grep -rni wants packages/contracts/src` 命中 0），
   * 它是商品列表读模型的市场信号，不是收藏行自己的字段 —— 所以只能是 `null`，
   * 页面据此**整块不画**（与 `components/product-card`、`pages/listing-detail` 同一条口径：
   * 契约给不出来就不渲染，不编成 0）。
   *
   * 为什么可空而不是照旧 `number`：留成必填就等于宣称「真实数据一定有这个数」，
   * 适配层被迫在写真实接线时凭空造一个数字出来。可空把这件事交给渲染层显式决定。
   * 缺口跟踪见 Issue（商品列表卡缺市场计数；#74 的「需求信号」一节）。
   */
  wants: number | null
  savedLabel: string
  /** 缩略图色块（分类基色，`LISTING_BLOCKS`） */
  coverUrl: string
  /**
   * 这一行来自演示 fixture：`id` 在商品库里**不存在**，跳详情必然 404。
   * 真实行恒为 `false`（见 `toFavoriteItems`），页面 `openItem()` 据此分支。
   */
  demo: boolean
}

/**
 * 一行收藏。`segment` 与 `goneReason` 做成**联合**而不是两个独立字段：
 * 「失效行必有遮罩文案、有效行必没有」这条不变式由类型保证，
 * 页面里 `item.segment === 'gone'` 一处判断就能收窄出 `goneReason`。
 */
export type FavoriteItem = FavoriteBase &
  ({ segment: 'sale' } | { segment: 'gone'; goneReason: FavoriteGoneReason })

/** fixture 的原始表：`goneReason` 一给就是失效行（`segment` 由它派生，不可能对不上） */
type RawFavorite = Omit<FavoriteBase, 'avatarUrl' | 'coverUrl' | 'demo'> &
  ({ segment?: 'sale'; goneReason?: undefined } | { goneReason: FavoriteGoneReason }) & {
    /** `AVATAR_BLOCKS` 下标 */
    avatarIndex: number
  }

/** 无图商品的兜底色块：与 `features/listing/adapt.ts` 同一套取法，不新增色值 */
function coverOf(category: ListingCategory): string {
  return LISTING_BLOCKS[category]?.[0] ?? LISTING_BLOCKS.OTHER?.[0] ?? ''
}

/** 稿 `DATA` 表的 8 件（6 有效 + 2 失效），顺序照稿 */
const RAW: RawFavorite[] = [
  {
    id: 'F01',
    category: 'DIGITAL',
    categoryText: '数码',
    title: '索尼 WH-1000XM4 头戴降噪耳机',
    priceCents: 76000,
    seller: '橙子',
    avatarIndex: 0,
    verified: true,
    wants: 34,
    savedLabel: '3 天前收藏',
  },
  {
    id: 'F02',
    category: 'BOOKS',
    categoryText: '书籍',
    title: '东野圭吾小说合集 共 6 本',
    priceCents: 7800,
    seller: '老周',
    avatarIndex: 1,
    verified: false,
    wants: 12,
    savedLabel: '5 天前收藏',
  },
  {
    id: 'F03',
    category: 'TRANSPORT',
    categoryText: '代步',
    title: '捷安特 ATX 山地车 27.5 寸',
    priceCents: 42000,
    seller: '橙子',
    avatarIndex: 0,
    verified: true,
    wants: 41,
    savedLabel: '上周收藏',
  },
  {
    id: 'F04',
    category: 'TRANSPORT',
    categoryText: '代步',
    title: '九号电动滑板车 续航 30km',
    priceCents: 115000,
    seller: '琪琪',
    avatarIndex: 2,
    verified: true,
    wants: 27,
    savedLabel: '上周收藏',
    goneReason: '已下架',
  },
  {
    id: 'F05',
    category: 'SPORTS',
    categoryText: '运动',
    title: '斯伯丁篮球 7 号 室内外通用',
    priceCents: 8900,
    seller: '老周',
    avatarIndex: 1,
    verified: false,
    wants: 11,
    savedLabel: '2 周前收藏',
  },
  {
    id: 'F06',
    category: 'BEAUTY',
    categoryText: '美妆',
    title: '兰蔻小黑瓶精华 50ml 全新未拆',
    priceCents: 52000,
    seller: '苏打水',
    avatarIndex: 3,
    verified: true,
    wants: 19,
    savedLabel: '2 周前收藏',
  },
  {
    id: 'F07',
    category: 'BEAUTY',
    categoryText: '美妆',
    title: '祖玛珑蓝风铃 30ml 余量 80%',
    priceCents: 38000,
    seller: '琪琪',
    avatarIndex: 2,
    verified: true,
    wants: 23,
    savedLabel: '3 周前收藏',
    goneReason: '已卖掉',
  },
  {
    id: 'F08',
    category: 'OTHER',
    categoryText: '其他',
    title: '雅马哈 F310 民谣吉他 41 寸',
    priceCents: 52000,
    seller: '小北',
    avatarIndex: 4,
    verified: false,
    wants: 18,
    savedLabel: '上个月收藏',
  },
]

/** 演示收藏（8 件）。**只给演示构建用**，见文件头 */
export const DEMO_FAVORITES: FavoriteItem[] = RAW.map((row) => {
  const base: FavoriteBase = {
    id: row.id,
    category: row.category,
    categoryText: row.categoryText,
    title: row.title,
    priceCents: row.priceCents,
    seller: row.seller,
    avatarUrl: AVATAR_BLOCKS[row.avatarIndex] ?? '',
    verified: row.verified,
    wants: row.wants,
    savedLabel: row.savedLabel,
    coverUrl: coverOf(row.category),
    demo: true,
  }
  return row.goneReason === undefined
    ? { ...base, segment: 'sale' }
    : { ...base, segment: 'gone', goneReason: row.goneReason }
})

/**
 * 演示数据的一次「读取」。
 *
 * 刻意**模拟一次异步**（延迟与 `@/mock/api` 的 `LATENCY = 120` 同口径）：稿第 04 帧的
 * 骨架屏在演示里要看得见，页面也才有 loading 这一态可走。
 * **它不发任何请求** —— 收藏没有端点（见文件头），这里只是延迟一份内存里的 fixture，
 * 且每次返回新数组，等价于稿里「刷新把 DATA 回滚到快照」。
 */
export const DEMO_LATENCY = 120

export function loadDemoFavorites(): Promise<FavoriteItem[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve([...DEMO_FAVORITES]), DEMO_LATENCY)
  })
}

/** 该行属不属于这一段（两段互斥） */
export function inSegment(item: FavoriteItem, segment: FavoriteSegment): boolean {
  return item.segment === segment
}

/** 当前段要渲染的行 */
export function itemsOf(items: readonly FavoriteItem[], segment: FavoriteSegment): FavoriteItem[] {
  return items.filter((item) => inSegment(item, segment))
}

/** 空态：`icon` 是**图标名**（页面映射到 `ICONS`，本模块不 import 图片资源） */
export type EmptyCopy = {
  icon: 'heart' | 'box'
  title: string
  text: string
  actionLabel: string
  /** 去首页逛逛 / 切回「有效宝贝」段 */
  action: 'browse' | 'backToSale'
}

/**
 * 两段各自的空态文案。
 *
 * **只剩一份了**：端点上线前这里按「演示 / 真实」分两支，真实那支写的是
 * 「收藏还没接后端 / 服务端还没有收藏接口」。端点（#394）上线后两支的前提都不成立 ——
 * 真实构建读的是真接口，空列表就是**用户真的没有收藏**，如实说「还没有收藏的宝贝」即可。
 * 再按构建分叉，只会让真实构建继续宣称一个已经不存在的缺口。
 *
 * 失效段要解释「谁会出现在这里」：用户没见过这一段有过东西，不解释会被读成坏了。
 */
export function emptyCopy(segment: FavoriteSegment): EmptyCopy {
  return segment === 'sale'
    ? {
        icon: 'heart',
        title: '还没有收藏的宝贝',
        text: '逛首页看到喜欢的，点一下 ♡ 就会收在这里',
        actionLabel: '去逛逛',
        action: 'browse',
      }
    : {
        icon: 'box',
        title: '没有失效的收藏',
        text: '被卖家下架、或者被别人买走的宝贝会收在这里',
        actionLabel: '回有效宝贝',
        action: 'backToSale',
      }
}

/* ---------------------------------------------------------------- 契约 → 本页的适配 */

/** 收藏时间的人话（`favoritedAt` → 「3 天前收藏」）；ISO 坏值时兜底成空串，不编一个时间。 */
function savedLabelOf(favoritedAt: string, nowMs: number): string {
  const relative = relativeTimeOf(favoritedAt, nowMs)
  return relative === '' ? '' : `${relative}收藏`
}

/**
 * 契约的 `listing.status` → 本页的两段。
 *
 * `RESERVED`（已被预订）仍进**有效**段：东西还在货架上，详情页对它也是公开可读的
 * （`favorites/schema.ts` 里写明 GET 读状态镜像详情页可见性）。把它算成失效会让用户
 * 以为东西没了，而「预订中」恰恰是还可能买到的信号。只有 `SOLD` / `OFFLINE` 才是真买不到。
 */
function segmentOf(
  status: ListingStatus,
): { segment: 'sale' } | { segment: 'gone'; goneReason: FavoriteGoneReason } {
  if (status === 'SOLD') return { segment: 'gone', goneReason: '已卖掉' }
  if (status === 'OFFLINE') return { segment: 'gone', goneReason: '已下架' }
  return { segment: 'sale' }
}

/**
 * 契约收藏行 → 本页行。
 *
 * `nowMs` 由调用方传入（**不在里面取 `Date.now()`**）：同一屏多行各取一次「现在」，
 * 相邻两行会对同一个时间点给出不同答案（`@/lib/time` 的同一条约定）。
 */
export function toFavoriteItems(
  saved: readonly ContractFavoriteItem[],
  nowMs: number,
): FavoriteItem[] {
  return saved.map(({ listing, favoritedAt }) => {
    const base: FavoriteBase = {
      id: listing.id,
      category: listing.category,
      categoryText: shortCategoryLabel(listing.category),
      title: listing.title,
      priceCents: listing.priceCents,
      seller: listing.seller?.nickname ?? '',
      // 契约的 `avatarUrl` 可为 `null`（库里是无约束 text）。缺图给通用占位色块，
      // 与 `features/listing/adapt.ts` 同一取法 —— 占位图是「这张图没有」的呈现，
      // 不是编造这个人的身份。
      avatarUrl: listing.seller?.avatarUrl ?? AVATAR_BLOCKS[0] ?? '',
      verified: listing.seller?.authStatus === 'VERIFIED',
      // 契约没有「想要」计数（`ListingCardSchema` 无该字段）→ 恒 `null`，页面整块不画
      wants: null,
      savedLabel: savedLabelOf(favoritedAt, nowMs),
      // 无封面图 → 分类基色块（同上，不新增色值）
      coverUrl: listing.coverUrl ?? coverOf(listing.category),
      demo: false,
    }
    return { ...base, ...segmentOf(listing.status) }
  })
}
