/**
 * 「历史浏览」的数据口径与文案（纯逻辑与演示 fixture；真实取数在 `../features/*` 的
 * api 模块，页面层只编排）。
 *
 * ## 三档的数据源（#415 / #190 / #195 落地后的现状）
 *
 * | 档 | 读端点 | 写端点 |
 * | --- | --- | --- |
 * | 全部浏览 | `GET /me/view-history`（30 天窗口，按最近浏览倒序） | `DELETE /me/view-history`（清空，幂等） |
 * | 我收藏的 | `GET /me/favorites` | 无批量清空（只有逐条取消，在收藏页做） |
 * | 我留言的 | `GET /me/comments?kind=all`（留言 ∪ 评价合并时间线） | 无批量清空（逐条删除在「我的评论」页做） |
 *
 * 所以「清空」在真实构建只对**浏览档**成立；收藏 / 留言档没有批量写端点，
 * 顶栏按钮只在该档隐藏（不是摆一个点了没反应的死按钮）。演示构建（双开关，
 * 见 `index.tsx`）仍读下面的 `DEMO_*` fixture，清空语义照旧（清本页演示数组）。
 *
 * ## 条数必须与「我的」页数字栏对得上
 *
 * `features/fetchers.ts` 的 `demoProfile()` 给的是收藏 8 / 足迹 24 / 关注 5，
 * 本模块的演示条数照稿就是 24（4 天 × 6 件）/ 8 / 8 —— 否则演示时会出现
 * 「数字栏写 8、点进来 5 件」这种自相矛盾。`tests/history-records.test.ts` 锁住这三个数。
 * （真实构建的条数以服务端为准，与「我的」页的接真计数同源同值。）
 */

import type { MyCommentItem } from '@fish/contracts/comments/schema'
import type { FavoriteItem } from '@fish/contracts/favorites/schema'
import type { ListingCategory, ListingStatus } from '@fish/contracts/listings/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import { dayLabelOf } from '@/lib/time'
import { LISTING_BLOCKS } from '@/mock/blocks'

/* ---------------------------------------------------------------- 档位 */

export const TAB_KEYS = ['history', 'favs', 'msgs'] as const

/** 三档下划线 tab（稿决策②：三份**不同**的数据 → tab，不是分段胶囊） */
export type HistoryTab = (typeof TAB_KEYS)[number]

export const TABS: { key: HistoryTab; label: string }[] = [
  { key: 'history', label: '全部浏览' },
  { key: 'favs', label: '我收藏的' },
  { key: 'msgs', label: '我留言的' },
]

/* ---------------------------------------------------------------- 类型 */

/** 失效角标：与收藏页同源（稿决策⑥ —— 同一件商品在两页上的角标必须一致） */
export type GoneLabel = '已下架' | '已卖掉'

/** 「我留言的」一行的类型：商品留言 / 交易评价（稿决策⑤：两类都算「我发出去的话」） */
export type MessageKind = 'comment' | 'review'

export const MESSAGE_KIND_LABEL: Record<MessageKind, string> = {
  comment: '商品留言',
  review: '交易评价',
}

/** 三列格的一格（全部浏览 / 我收藏的共用） */
export type RecordCell = {
  id: string
  category: ListingCategory
  title: string
  /** 整数分（金额一律整数分，与契约同口径） */
  priceCents: number
  /** 非 null 时缩略图压遮罩、边框降级 */
  gone: GoneLabel | null
  /** 商品封面（真实数据才有；缺省退回品类色块 —— 演示 fixture 不带它） */
  coverUrl?: string | null
}

/** 全部浏览：一天一组 */
export type HistoryDay = {
  /** 记录日期（稿决策⑦：日期来自**足迹记录**，不是商品发布时间） */
  date: string
  items: RecordCell[]
}

/** 留言行的跳转目标（真实数据才有；演示 fixture 不带它 → 页面给演示说明 toast）。 */
export type MessageTarget = { kind: 'listing' | 'transaction'; id: string }

/** 我留言的：整宽行（刻意不显示价格，稿决策④） */
export type MessageRecord = {
  id: string
  /**
   * 品类。**评价行可能是 null**：交易 DTO 内嵌的商品摘要（`transactionListingSchema`）
   * 没有分类字段 —— 为 null 时不画品类小字、色块退回 OTHER（有 `coverUrl` 时用封面）。
   */
  category: ListingCategory | null
  title: string
  kind: MessageKind
  /** 我写的那句话。评价行可能是空串（「只打分没写字」是契约明说的正常形态）。 */
  text: string
  timeLabel: string
  /** 商品封面（真实数据才有；缺省退回品类色块） */
  coverUrl?: string | null
  /** 跳转目标（真实数据才有）：留言 → 商品详情；评价 → 面交/订单页。 */
  target?: MessageTarget
}

/* ---------------------------------------------------------------- 展示用派生 */

/**
 * 格子里的品类小字（稿 `.gcard__ph .tag` / `.rrow__thumb span`）。
 *
 * 刻意**不用** `mock/api` 的 `categoryLabel`：那是「数码电子 / 教材书籍」这类 4 字段落，
 * 稿的标签位是 106pt 方块里的一行 9.5pt 小字，只在稿里给的就是这两个字（数码 / 书籍 / …）。
 * 真实数据接进来时这一格要跟着真实分类口径走，届时再决定要不要换成 `categoryLabel`。
 */
const SHORT_LABEL: Record<ListingCategory, string> = {
  DIGITAL: '数码',
  BOOKS: '书籍',
  BEAUTY: '美妆',
  DAILY: '日用',
  SPORTS: '运动',
  APPAREL: '服饰',
  TRANSPORT: '代步',
  OTHER: '其他',
}

export function shortLabelOf(category: ListingCategory): string {
  return SHORT_LABEL[category]
}

const FALLBACK_BLOCK: [string, string, string] = LISTING_BLOCKS.OTHER as [string, string, string]

/**
 * 缩略图色块：1×1 纯色 PNG 的 data URI（`src/mock/blocks.ts`，由设计令牌派生，非新增色值）。
 * 与 `features/listing/adapt.ts` 的 `coverPlaceholder` 同一套取法：取第 0 档明度，
 * 分类缺失时退 `OTHER`。
 */
export function blockUrlOf(category: ListingCategory): string {
  return (LISTING_BLOCKS[category] ?? FALLBACK_BLOCK)[0]
}

/* ---------------------------------------------------------- 真实数据适配器 */

/** 失效角标：与收藏页同一口径（OFFLINE = 已下架、SOLD = 已卖掉，其余在售）。 */
export function goneLabelOf(status: ListingStatus): GoneLabel | null {
  if (status === 'OFFLINE') return '已下架'
  if (status === 'SOLD') return '已卖掉'
  return null
}

/** 足迹一行 `{ listing, viewedAt }` → 三列格。 */
export function viewHistoryCell(item: ViewHistoryItem): RecordCell {
  return {
    id: item.listing.id,
    category: item.listing.category,
    title: item.listing.title,
    priceCents: item.listing.priceCents,
    gone: goneLabelOf(item.listing.status),
    coverUrl: item.listing.coverUrl,
  }
}

/** 收藏一行 `{ listing, favoritedAt }` → 三列格（失效口径与足迹一致）。 */
export function favoriteCell(item: FavoriteItem): RecordCell {
  return {
    id: item.listing.id,
    category: item.listing.category,
    title: item.listing.title,
    priceCents: item.listing.priceCents,
    gone: goneLabelOf(item.listing.status),
    coverUrl: item.listing.coverUrl,
  }
}

/**
 * 「我留言的」一行：`/me/comments` 的判别联合 → 整宽行。
 * 刻意**不显示价格**（稿决策④：这一档找的是「我当时说了什么」）。
 */
export function messageRow(
  item: MyCommentItem | TransactionReviewItem,
  nowMs: number,
): MessageRecord {
  if ('comment' in item) {
    return {
      id: item.comment.id,
      category: item.listing.category,
      title: item.listing.title,
      kind: 'comment',
      text: item.comment.content,
      timeLabel: dayLabelOf(item.comment.createdAt, nowMs),
      coverUrl: item.listing.coverUrl,
      target: { kind: 'listing', id: item.comment.listingId },
    }
  }
  return {
    id: item.review.id,
    category: null,
    title: item.transaction.listing.title,
    kind: 'review',
    text: item.review.body ?? '',
    timeLabel: dayLabelOf(item.review.createdAt, nowMs),
    coverUrl: item.transaction.listing.coverUrl,
    target: { kind: 'transaction', id: item.transaction.id },
  }
}

/** 本地日期键（分组用，不渲染）。 */
function dayKeyOf(iso: string): string {
  const at = new Date(iso)
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`
}

/** 分组条的日期文案：今天 / 昨天 / M 月 D 日（本地时区；不含时间）。 */
function dayGroupLabel(iso: string, nowMs: number): string {
  const at = new Date(iso)
  const dayMs = 24 * 60 * 60 * 1000
  const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
  const diff = Math.round((startOfDay(nowMs) - startOfDay(at.getTime())) / dayMs)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  return `${at.getMonth() + 1} 月 ${at.getDate()} 日`
}

/**
 * 按浏览日分组（`HistoryDay.date` 在演示里是 ISO 日期、在真实数据里是「今天 / 昨天 /
 * M 月 D 日」文案 —— 稿决策⑦：日期来自足迹记录，不是商品发布时间）。组内保持服务端
 * 顺序（最近在前），组间按首次出现的顺序（服务端已按最近浏览倒序）。
 */
export function groupByDay(
  rows: readonly (RecordCell & { viewedAt: string })[],
  nowMs: number,
): HistoryDay[] {
  const groups = new Map<string, { label: string; items: RecordCell[] }>()
  for (const row of rows) {
    const key = dayKeyOf(row.viewedAt)
    const found = groups.get(key)
    if (found) {
      found.items.push(row)
      continue
    }
    groups.set(key, { label: dayGroupLabel(row.viewedAt, nowMs), items: [row] })
  }
  return Array.from(groups.values(), ({ label, items }) => ({ date: label, items }))
}

/* ---------------------------------------------------------------- 顶部动作（清空） */

/**
 * 顶栏右端的动作文案。**三档统一是「清空」**（Owner 2026-09-23 拍板）：
 * 原来只有浏览档是「清空」、收藏与留言是「管理」，但「管理」在本页没有任何下游 ——
 * 既没有批量选择的端点、也没做批量态，点下去只能给一句「待接入」，等于摆一个假按钮。
 * 三档都是「把你自己的这份记录清掉」，语义本来就是同一件事。
 */
export const CLEAR_LABEL = '清空'

/** 三档各自的记录名（清空 toast 与空态文案共用，只在这里写一遍） */
const RECORD_NAME: Record<HistoryTab, string> = {
  history: '浏览记录',
  favs: '收藏',
  msgs: '留言',
}

/**
 * 清空成功了。
 *
 * ⚠️ 这个动作**只在演示构建下真的清**（见 `canClear` 的说明）：被清掉的是本页自己的
 * 演示数据，不是「假装删掉了服务端的记录」—— 清完列表真的空了、并切到「已清空」空态，
 * 所以这句话说的是事实。
 */
export function clearDoneOf(tab: HistoryTab): string {
  return `已清空${RECORD_NAME[tab]}`
}

/**
 * 清空暂时做不了。
 *
 * 真实构建下「清空」只对浏览档成立（`DELETE /me/view-history`）；收藏 / 留言档没有
 * 批量写端点，顶栏按钮在该档隐藏 —— 本函数只剩兜底用途（防御性调用），文案说清
 * 「这一档暂时不能一键清空」，不做任何本地状态翻转（本地删掉几行是假接线）。
 */
export function clearBlockedOf(tab: HistoryTab): string {
  return `这一档暂时不能一键清空${RECORD_NAME[tab]}`
}

/**
 * 这一档能不能真的清。
 *
 * - 演示构建：三档都行 —— 那份「记录」就是本页从 `records.ts` 读进来的演示数组，
 *   清空它 = 把页面上显示的这份数据真的去掉（列表变空 + 切到「已清空」空态）。
 * - 真实构建：只有浏览档有批量写端点（`DELETE /me/view-history`）；收藏 / 留言档
 *   恒 `false`，顶栏按钮在该档直接隐藏。
 */
export function canClear(demo: boolean, tab: HistoryTab): boolean {
  return demo || tab === 'history'
}

/* ---------------------------------------------------------------- 空态 / 加载 / 说明 */

export type EmptyCopy = { title: string; text: string; action: string }

/**
 * 空态的两种来由，**含义互不相同、必须分开说**：
 *
 * - `empty`：这一档真的没有记录（演示与真实构建同义 —— 真实数据下空了就是真的没有；
 *   #415/#190/#195 之前真实构建「后端没有这条数据」的那三支缺口说明已随接线删除）；
 * - `cleared`：演示构建、刚点了清空 —— 记录是**你刚清掉的**，不是「本来就没有」。
 *
 * 两种混成一句就会出现「我明明清空的，怎么说是没有记录」这种自相矛盾。
 */
export type EmptyKind = 'empty' | 'cleared'

export function emptyKindOf(cleared: boolean): EmptyKind {
  // 「清过」这一态比「本来就没有」更具体，优先说它
  return cleared ? 'cleared' : 'empty'
}

/**
 * 两种空态的文案（**每档 × 每种来由各一支**）。
 *
 * 「empty」说的是「这一档真的没有记录」（真实数据下空了就是真的没有 —— 早期版本
 * 「后端还没有这条数据」的三支缺口说明已随 #415/#190/#195 接线删除）。
 */
export function emptyCopyOf(tab: HistoryTab, kind: EmptyKind): EmptyCopy {
  if (kind === 'cleared') {
    if (tab === 'history') {
      return { title: '浏览记录已清空', text: '再看过的商品会重新按天收在这里', action: '去逛逛' }
    }
    if (tab === 'favs') {
      return {
        title: '收藏已清空',
        text: '逛首页看到喜欢的，点一下 ♡ 会重新收在这里',
        action: '去逛逛',
      }
    }
    return {
      title: '留言已清空',
      text: '之后发的商品留言与交易评价会重新收在这里',
      action: '去逛逛',
    }
  }

  if (tab === 'history') {
    return {
      title: '还没有浏览记录',
      text: '看过的商品会按天收在这里，方便回头再找',
      action: '去逛逛',
    }
  }
  if (tab === 'favs') {
    return {
      title: '还没有收藏的宝贝',
      text: '逛首页看到喜欢的，点一下 ♡ 就会收在这里',
      action: '去逛逛',
    }
  }
  return {
    title: '还没有留过言',
    text: '在商品下留言、或交易完成后给对方评价，都会收在这里',
    action: '去逛逛',
  }
}

/** 骨架屏提示行（稿 `LOADING` 表，三档各一句） */
export function loadingTextOf(tab: HistoryTab): string {
  if (tab === 'history') return '正在读取浏览记录…'
  if (tab === 'favs') return '正在读取收藏…'
  return '正在读取留言…'
}

/**
 * 列表底部说明。空串 = 这一档没有说明行（收藏档原有一条「带『已降价』角标的是…」，
 * 角标按 Owner 决策④删掉之后这句话也不成立了 —— 不要加回来）。
 *
 * ⚠️ **留档给 Owner（尚未拍板，不要顺手「修」）**：第一档叫「全部浏览」，
 * 而这行写「最近 30 天」，字面上是打架的（既然「全部」，为什么只有 30 天）。
 * 设计稿 `小程序1版history.html` 文件头决策②给了三种收法：
 *   a) 保留 30 天保留期，把文案改成「近 30 天」—— 说清它是**范围**不是「全部」；
 *   b) 去掉保留期，真给全部历史（后端要支持全量分页）；
 *   c) 「全部浏览」只表示「未筛选」这个状态，保留期照旧。
 * 本轮按方案 `D:\FISH\四页面并行-收藏历史评论关注.md` §3.2 的要求**只留档、不改保留期**，
 * 文案照稿原样保留。改这里之前先看 Owner 怎么定。
 */
export function noteOf(tab: HistoryTab): string {
  return tab === 'history' ? '浏览记录只保留最近 30 天，更早的会自动清掉。' : ''
}

/** 到底提示（列表非空才渲染）：`已显示全部 24 件` / `… 8 条` */
export function tailTextOf(tab: HistoryTab, count: number): string {
  return `已显示全部 ${count} ${tab === 'msgs' ? '条' : '件'}`
}

/** 演示构建里点格子 / 留言行的说明（演示 id 在库里不存在，跳过去必然 404，不假装跳成功） */
export const DEMO_OPEN_TIP = '演示数据，暂不能打开商品详情'

/* ---------------------------------------------------------------- 演示数据（照稿） */

/**
 * 全部浏览：24 件 · 4 天（与「我的」页数字栏的足迹数 24 对齐），组内顺序 = 浏览顺序（最近的在前）。
 * 其中 2 件的「失效」是稿件本身的演示设定（商品在 catalog 里仍在售），见稿的同段说明。
 */
export const DEMO_HISTORY: HistoryDay[] = [
  {
    date: '2026-09-14',
    items: [
      {
        id: 'h-01',
        category: 'DIGITAL',
        title: '索尼 WH-1000XM4 头戴降噪耳机',
        priceCents: 76000,
        gone: null,
      },
      {
        id: 'h-02',
        category: 'DIGITAL',
        title: '小米 12 8+128 全网通',
        priceCents: 89000,
        gone: null,
      },
      {
        id: 'h-03',
        category: 'TRANSPORT',
        title: '捷安特 ATX 山地车 27.5 寸',
        priceCents: 42000,
        gone: null,
      },
      {
        id: 'h-04',
        category: 'OTHER',
        title: '雅马哈 F310 民谣吉他 41 寸',
        priceCents: 52000,
        gone: null,
      },
      {
        id: 'h-05',
        category: 'APPAREL',
        title: '耐克 Air Force 1 白 42 码',
        priceCents: 26000,
        gone: null,
      },
      {
        id: 'h-06',
        category: 'BEAUTY',
        title: '兰蔻小黑瓶精华 50ml 全新未拆',
        priceCents: 52000,
        gone: null,
      },
    ],
  },
  {
    date: '2026-09-13',
    items: [
      {
        id: 'h-07',
        category: 'BOOKS',
        title: '灌篮高手 完全版 1-24 全集',
        priceCents: 46000,
        gone: null,
      },
      {
        id: 'h-08',
        category: 'TRANSPORT',
        title: '九号电动滑板车 续航 30km',
        priceCents: 115000,
        gone: '已下架',
      },
      {
        id: 'h-09',
        category: 'SPORTS',
        title: '斯伯丁篮球 7 号 室内外通用',
        priceCents: 8900,
        gone: null,
      },
      {
        id: 'h-10',
        category: 'DAILY',
        title: '米家台灯 Pro 护眼版',
        priceCents: 12000,
        gone: null,
      },
      {
        id: 'h-11',
        category: 'BOOKS',
        title: '东野圭吾小说合集 共 6 本',
        priceCents: 7800,
        gone: null,
      },
      {
        id: 'h-12',
        category: 'DAILY',
        title: '双肩背包 大容量 通勤上课',
        priceCents: 8800,
        gone: null,
      },
    ],
  },
  {
    date: '2026-09-11',
    items: [
      {
        id: 'h-13',
        category: 'BOOKS',
        title: '高等数学 同济第七版 上下册',
        priceCents: 4500,
        gone: null,
      },
      {
        id: 'h-14',
        category: 'DAILY',
        title: '宿舍电热水壶 1.5L 保温款',
        priceCents: 5500,
        gone: null,
      },
      {
        id: 'h-15',
        category: 'APPAREL',
        title: '通勤单肩包 牛皮 米白色',
        priceCents: 16800,
        gone: null,
      },
      {
        id: 'h-16',
        category: 'SPORTS',
        title: '加厚瑜伽垫 10mm 防滑',
        priceCents: 3900,
        gone: null,
      },
      {
        id: 'h-17',
        category: 'OTHER',
        title: '宜家小熊玩偶 60cm 干净',
        priceCents: 4500,
        gone: null,
      },
      {
        id: 'h-18',
        category: 'BEAUTY',
        title: '彩妆套装 唇釉 / 眼影 九成新',
        priceCents: 9600,
        gone: null,
      },
    ],
  },
  {
    date: '2026-09-08',
    items: [
      {
        id: 'h-19',
        category: 'APPAREL',
        title: '冲锋衣 男 L 码 三合一',
        priceCents: 32000,
        gone: null,
      },
      {
        id: 'h-20',
        category: 'BEAUTY',
        title: '祖玛珑蓝风铃 30ml 余量 80%',
        priceCents: 38000,
        gone: '已卖掉',
      },
      {
        id: 'h-21',
        category: 'SPORTS',
        title: '可调节哑铃 20kg 一对',
        priceCents: 18000,
        gone: null,
      },
      {
        id: 'h-22',
        category: 'DIGITAL',
        title: '联想 ThinkPad X280 轻薄本',
        priceCents: 158000,
        gone: null,
      },
      {
        id: 'h-23',
        category: 'OTHER',
        title: '桌游 狼人杀 / 大富翁 组合出',
        priceCents: 6800,
        gone: null,
      },
      {
        id: 'h-24',
        category: 'TRANSPORT',
        title: '电动车头盔 3C 认证 带护目镜',
        priceCents: 4500,
        gone: null,
      },
    ],
  },
]

/**
 * 我收藏的：8 件（与「我的」页数字栏的收藏数 8 对齐）。
 * 与全部浏览是同一份商品、同一套失效判据（稿决策⑥）—— 两处的「已下架 / 已卖掉」必须一致。
 * 刻意**没有**「降价多少」这个字段：不做降价提醒，见稿决策④。
 */
export const DEMO_FAVS: RecordCell[] = [
  {
    id: 'f-01',
    category: 'DIGITAL',
    title: '索尼 WH-1000XM4 头戴降噪耳机',
    priceCents: 76000,
    gone: null,
  },
  {
    id: 'f-02',
    category: 'BOOKS',
    title: '东野圭吾小说合集 共 6 本',
    priceCents: 7800,
    gone: null,
  },
  {
    id: 'f-03',
    category: 'TRANSPORT',
    title: '捷安特 ATX 山地车 27.5 寸',
    priceCents: 42000,
    gone: null,
  },
  {
    id: 'f-04',
    category: 'TRANSPORT',
    title: '九号电动滑板车 续航 30km',
    priceCents: 115000,
    gone: '已下架',
  },
  {
    id: 'f-05',
    category: 'SPORTS',
    title: '斯伯丁篮球 7 号 室内外通用',
    priceCents: 8900,
    gone: null,
  },
  {
    id: 'f-06',
    category: 'BEAUTY',
    title: '兰蔻小黑瓶精华 50ml 全新未拆',
    priceCents: 52000,
    gone: null,
  },
  {
    id: 'f-07',
    category: 'BEAUTY',
    title: '祖玛珑蓝风铃 30ml 余量 80%',
    priceCents: 38000,
    gone: '已卖掉',
  },
  {
    id: 'f-08',
    category: 'OTHER',
    title: '雅马哈 F310 民谣吉他 41 寸',
    priceCents: 52000,
    gone: null,
  },
]

/**
 * 我留言的：8 条 = 4 条商品留言 + 4 条交易评价（稿决策⑤）。
 * 与「我的评论」页（另一条并行线）是同一份数据的两个取用场景：这里只读、不做管理。
 * **刻意不带价格**：这一档找的是「我当时说了什么」，不是价格。
 */
export const DEMO_MESSAGES: MessageRecord[] = [
  {
    id: 'm-01',
    category: 'DIGITAL',
    title: '索尼 WH-1000XM4 头戴降噪耳机',
    kind: 'comment',
    text: '还在吗？我今晚下课顺路，能帮我留到八点吗',
    timeLabel: '2 小时前',
  },
  {
    id: 'm-02',
    category: 'SPORTS',
    title: '斯伯丁篮球 7 号 室内外通用',
    kind: 'comment',
    text: '球是室内打过还是室外打的？气还足吗',
    timeLabel: '昨天 19:40',
  },
  {
    id: 'm-03',
    category: 'TRANSPORT',
    title: '捷安特 ATX 山地车 27.5 寸',
    kind: 'comment',
    text: '车在哪栋楼？周末方便试骑一下吗',
    timeLabel: '3 天前',
  },
  {
    id: 'm-04',
    category: 'DAILY',
    title: '米家台灯 Pro 护眼版',
    kind: 'comment',
    text: '色温有几档？宿舍桌面用会不会太亮',
    timeLabel: '上周',
  },
  {
    id: 'm-05',
    category: 'DAILY',
    title: '米家 LED 护眼台灯 可调色温',
    kind: 'review',
    text: '准时到了面交点，验完直接确认，很好沟通的一位同学。',
    timeLabel: '5 月 12 日',
  },
  {
    id: 'm-06',
    category: 'SPORTS',
    title: '尤尼克斯 羽毛球拍 双拍装',
    kind: 'review',
    text: '验货很仔细，但确认得很爽快，全程没有压价。',
    timeLabel: '5 月 6 日',
  },
  {
    id: 'm-07',
    category: 'BOOKS',
    title: '灌篮高手 完全版 1-24 全集',
    kind: 'review',
    text: '书收到啦，包得很仔细，成色比描述的还好。',
    timeLabel: '5 月 20 日',
  },
  {
    id: 'm-08',
    category: 'BEAUTY',
    title: '兰蔻小黑瓶精华 50ml 全新未拆',
    kind: 'review',
    text: '瓶身完好、日期也新，就是见面时间来回改了两遍。',
    timeLabel: '4 月 28 日',
  },
]

/* ---------------------------------------------------------------- 演示取数 */

/** 演示构建里这一页「拿到」的三份数据 + 它们属于哪个账号 */
export type DemoRecords = {
  /** 数据属于哪个登录用户：换账号后迟到的结果必须被丢弃（判据在 `index.tsx` 的请求代次 + 身份比对） */
  ownerId: string
  days: HistoryDay[]
  favs: RecordCell[]
  msgs: MessageRecord[]
}

/** 演示「网络往返」：与 `@/mock/api` 的 `LATENCY` 同一用意，让骨架屏在演示里真的看得见 */
export const DEMO_LATENCY_MS = 300

/**
 * 演示构建的取数（**没有网络**，只是一个定时器）。
 *
 * 为什么把它写成 Promise：本页唯一会「跨账号迟到」的东西就是它 —— 用
 * `@/lib/cancellable` 包住（先例 `pages/profile` / `pages/orders-buy`），
 * 换账号 / 退出时迟到的结果不会写进新身份的页面。
 */
export function fetchDemoRecords(ownerId: string): Promise<DemoRecords> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ ownerId, days: DEMO_HISTORY, favs: DEMO_FAVS, msgs: DEMO_MESSAGES })
    }, DEMO_LATENCY_MS)
  })
}

/* ---------------------------------------------------------------- 清空 */

/** 三档各自的「已清空」标记 */
export type ClearedMap = Record<HistoryTab, boolean>

export const NOTHING_CLEARED: ClearedMap = { history: false, favs: false, msgs: false }

/**
 * 「清空过哪几档」+ **它属于哪个账号**。
 *
 * `ownerId` 与 `DemoRecords.ownerId` 同一用意：Tab 页实例跨登录态存活，换账号后
 * 上一个账号「清过了」的记忆必须作废 —— 否则新账号一进来就看到空列表，
 * 而它其实只是没被清过。`clearedOf` 就是这条判据。
 */
export type ClearedState = ClearedMap & { ownerId: string | null }

/** 取当前账号的「已清空」标记：账号对不上（还没登录 / 换过账号）一律按「没清过」读 */
export function clearedOf(state: ClearedState, userId: string | null): ClearedMap {
  if (userId === null || state.ownerId !== userId) return NOTHING_CLEARED
  // 只回三个标记，不带 `ownerId`：调用方拿到的是「这一档清没清」，账号归属是上一层的判据
  return { history: state.history, favs: state.favs, msgs: state.msgs }
}

export function withCleared(state: ClearedState, userId: string, tab: HistoryTab): ClearedState {
  return { ownerId: userId, ...clearedOf(state, userId), [tab]: true }
}

/**
 * 把「已清空」施加到刚取回的数据上。
 *
 * 为什么**刷新之后仍然是空的**：清空模拟的是「服务端那份记录被删了」，重新取一次也该
 * 是空的 —— 若刷新把数据变回来，用户会看到「刚清空的东西自己长回来」，比不做清空更糟。
 * 所以在**渲染期**用这份标记过滤（不改 `fetchDemoRecords` 的返回值），刷新后自然仍然为空。
 *
 * **真实构建下 `cleared` 恒为全 false**（`canClear` 为假、清不掉），这个函数是恒等变换。
 */
export function applyCleared(records: DemoRecords, cleared: ClearedMap): DemoRecords {
  if (!cleared.history && !cleared.favs && !cleared.msgs) return records
  return {
    ownerId: records.ownerId,
    days: cleared.history ? [] : records.days,
    favs: cleared.favs ? [] : records.favs,
    msgs: cleared.msgs ? [] : records.msgs,
  }
}
