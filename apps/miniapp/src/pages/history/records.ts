/**
 * 「历史浏览」的数据口径与文案（**纯逻辑，无 Taro / 无请求**，供 `tests/history-records.test.ts` /
 * `tests/history-real.test.ts` 直接 import）。
 *
 * ## 三档的数据源现状（2026-10 核对）
 *
 * | 能力 | 现状 | 证据 |
 * | --- | --- | --- |
 * | 浏览足迹 | ✅ 已接（#415 M1） | `packages/contracts/src/view-history/` 的 GET / DELETE `/me/view-history`；本模块的 `goneLabelOf` / `recordCellOf` / `historyDaysOf` 是它的纯适配层 |
 * | 收藏 | ⚠️ 端点与端上「我的收藏」页都已上线（#394），**本页这一档还没接** | `@/features/favorites/api` 的 `fetchMyFavorites`；本页收藏档仍走演示数据 / 缺口空态 |
 * | 「我发过的留言」聚合 | ⚠️ `GET /me/comments` 已上线（#195，PR1 只含商品留言）；端上聚合页在 #405（PR）；**本页这一档还没接** | `packages/contracts/src/comments/routes.ts` 的 `myComments` |
 *
 * 所以本模块里的 `DEMO_*` 只服务**演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，
 * 见 `index.tsx`）：真实构建下浏览档读真接口，收藏 / 留言两档仍渲染如实的缺口空态
 * （「这一页还没接」），**不摆这些演示数据**。
 *
 * ## 条数必须与「我的」页数字栏对得上
 *
 * `features/fetchers.ts` 的 `demoProfile()` 给的是收藏 8 / 足迹 24 / 关注 5，
 * 本模块的演示条数照稿就是 24（4 天 × 6 件）/ 8 / 8 —— 否则演示时会出现
 * 「数字栏写 8、点进来 5 件」这种自相矛盾。`tests/history-records.test.ts` 锁住这三个数。
 * **真实构建**下「我的」页的足迹数读 `GET /me/view-history` 的 `total`
 * （`features/fetchers.ts` 的 `loadProfile`），与本页列表同源。
 *
 * ## 演示数据下**不做**的两件事
 *
 * 1. **不做 N+1 拼装**：不遍历自己的商品逐个拉 `GET /listings/:id/comments` 过滤作者来假装
 *    「我发过的留言」汇总 —— 它既慢又不完整（漏掉我在别人商品下的留言），比空态更糟。
 * 2. **不假装服务端写成功**：顶部「清空」在**演示构建**下清掉的是本页自己的演示数组
 *    （页面上那份记录真的没了、并切到「已清空」空态），不涉及任何服务端写；
 *    **真实构建**下浏览档的清空是**真写**（`DELETE /me/view-history`，见
 *    `@/features/view-history/api`），以服务端为准；收藏 / 留言两档没有写端点，
 *    只给一句说明、不做本地翻转 —— 见 `canClearTab` / `clearBlockedOf`。
 */
import type { ListingCategory, ListingStatus } from '@fish/contracts/listings/schema'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
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
}

/** 全部浏览：一天一组 */
export type HistoryDay = {
  /** 记录日期（稿决策⑦：日期来自**足迹记录**，不是商品发布时间） */
  date: string
  items: RecordCell[]
}

/** 我留言的：整宽行（刻意不显示价格，稿决策④） */
export type MessageRecord = {
  id: string
  category: ListingCategory
  title: string
  kind: MessageKind
  /** 我写的那句话 */
  text: string
  timeLabel: string
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

/* ---------------------------------------------------------------- 真实数据适配（#415 M1） */

/**
 * 商品状态 → 失效角标。**与收藏页同源**（`pages/favorites/list.ts` 的 `toFavoriteItems`）：
 * `OFFLINE` → 「已下架」、`SOLD` → 「已卖掉」；`ACTIVE` / `RESERVED`（已预定）都还在货架上，
 * 不进失效档 —— 同一件商品在历史页与收藏页的角标必须一致。
 */
export function goneLabelOf(status: ListingStatus): GoneLabel | null {
  if (status === 'OFFLINE') return '已下架'
  if (status === 'SOLD') return '已卖掉'
  return null
}

/**
 * 契约的一行浏览记录 → 本页三列格。缩略图仍是分类色块（`blockUrlOf`，不引入真实封面，
 * 保持稿面版式）—— 契约的 `coverUrl` 留给后续换真封面时再接。
 */
export function recordCellOf(item: ViewHistoryItem): RecordCell {
  const { listing } = item
  return {
    id: listing.id,
    category: listing.category,
    title: listing.title,
    priceCents: listing.priceCents,
    gone: goneLabelOf(listing.status),
  }
}

/** 本地日历日的键（`2026-10-02`）；跨时区比较必须按**本地日**，不能用 UTC。 */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** 组标题：今天 / 昨天 / M月D日（跨年带年份）。 */
function dayLabelOf(date: Date, now: Date): string {
  const key = localDayKey(date)
  if (key === localDayKey(now)) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === localDayKey(yesterday)) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * 契约的一页浏览记录 → 按**本地日**分组。
 *
 * - 日期取 `viewedAt`（稿决策⑦：日期来自足迹记录，不是商品发布时间）；
 * - 组内保持输入顺序（服务端已按 `last_viewed_at DESC` 下发，不再二次排序）；
 * - 同一天只出一组，跨页拼接时也要先合并成一份 `items` 再调本函数（见 `index.tsx` 的
 *   `loadMore`），否则同一天会被切成两组、React 的 `key={day.date}` 还会撞车。
 */
export function historyDaysOf(items: readonly ViewHistoryItem[], now: number): HistoryDay[] {
  const nowDate = new Date(now)
  const days: HistoryDay[] = []
  let current: HistoryDay | null = null
  let currentKey: string | null = null
  for (const item of items) {
    const viewed = new Date(item.viewedAt)
    const key = localDayKey(viewed)
    if (current === null || key !== currentKey) {
      current = { date: dayLabelOf(viewed, nowDate), items: [] }
      currentKey = key
      days.push(current)
    }
    current.items.push(recordCellOf(item))
  }
  return days
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
 * 演示构建下清掉的是本页自己的演示数据（不是「假装删掉了服务端的记录」—— 清完列表真的
 * 空了、并切到「已清空」空态）；真实构建下浏览档是**真写** `DELETE /me/view-history`，
 * 这句话在服务端回 `deleted` 之后才说（见 `index.tsx` 的 `clearTab`）。
 */
export function clearDoneOf(tab: HistoryTab): string {
  return `已清空${RECORD_NAME[tab]}`
}

/**
 * 清空暂时做不了。
 *
 * **真实构建**下收藏 / 留言两档没有写端点（收藏只有**单品**取消 `/listings/:id/favorite`、
 * 留言只有**单条**删除 `/comments/:id`，都不是「清空我这一档」的语义），所以这里只给说明、
 * **不做任何本地状态翻转**（本地删掉几行再回滚是假接线，会让用户以为删成功了）。
 * 这与 Owner 的「如果是因为后端没有的原因就保持不变」是同一口径。
 */
export function clearBlockedOf(tab: HistoryTab): string {
  return `后端未开放，暂时不能清空${RECORD_NAME[tab]}`
}

/**
 * 这一档能不能真的清。
 *
 * - **演示构建**：三档都能清 —— 那份「记录」就是本页从 `records.ts` 读进来的演示数组，
 *   清空它 = 把页面上显示的这份数据真的去掉（列表变空 + 切到「已清空」空态）。
 * - **真实构建**：只有浏览档能清 —— `DELETE /me/view-history` 已上线（#415 M1），
 *   清的是服务端那份记录，以服务端返回为准；收藏 / 留言两档的「清空」写端点仍不存在，
 *   由页面走 `clearBlockedOf` 的说明，不做本地翻转。
 */
export function canClearTab(demo: boolean, tab: HistoryTab): boolean {
  return demo || tab === 'history'
}

/* ---------------------------------------------------------------- 空态 / 加载 / 说明 */

export type EmptyCopy = { title: string; text: string; action: string }

/**
 * 空态的三种来由，**含义互不相同、必须分开说**：
 *
 * - `noBackend`：真实构建 —— 后端根本没有这条数据（不是「你恰好没有记录」）；
 * - `demoEmpty`：演示构建、还没清过 —— 演示口径下这份记录恰好是空的；
 * - `cleared`：演示构建、刚点了清空 —— 记录是**你刚清掉的**，不是「本来就没有」。
 *
 * 三种混成一句就会出现「我明明清空的，怎么说是没有后端」这种自相矛盾。
 */
export type EmptyKind = 'noBackend' | 'demoEmpty' | 'cleared'

export function emptyKindOf(demo: boolean, cleared: boolean): EmptyKind {
  // 传进来的 cleared 只可能是演示构建的清空标记（真实浏览档的清空以服务端为准，
  // 页面单独判定，不走这里）；真到了「清过」这一态，它比其它两种解释都更具体
  if (cleared) return 'cleared'
  return demo ? 'demoEmpty' : 'noBackend'
}

/**
 * 三种空态的文案（**每档 × 每种来由各一支**）。
 *
 * `noBackend` 说的是「这一档还读不到服务端数据」（后端还没有这条数据 / 这一页还没接上），
 * 而不是「你还没有浏览记录 / 没有收藏」：后者是我们**不知道**的事，写成事实就是假话 ——
 * 这与 `components/load-error` 和空态之间那条界线同一口径（「加载不出来」≠「恰好没有内容」）。
 *
 * ⚠️ 收藏那一支（#397）：收藏接口已上线（#394），小程序也有了真读它的「我的收藏」页，
 * 所以这里**不能再写**「服务端还没有收藏接口 / 只记在这台设备上」—— 两句现在都是假话。
 * 本页的收藏档还没接端点，如实说「这一页还没接」，并把用户引到能看的那个页面。
 * 浏览档同理（#415 M1 后 `noBackend` 已退役，那一支与 `demoEmpty` 同文案）。
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

  if (kind === 'demoEmpty') {
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

  if (tab === 'history') {
    /*
      浏览档的 `noBackend` 文案随 #415 M1 退役：`GET /me/view-history` 已上线，真实构建里
      「接口成功但列表为空」确实等于「你还没有浏览过」，页面已改用 `demoEmpty` 那一支
      （见 `index.tsx` 的 `emptyKind`）。这里仍与 `demoEmpty` 保持**同一句话**，
      免得哪天有人再走回这一支时又说出「浏览足迹还没有后端」这种现在已经是假话的文案。
    */
    return {
      title: '还没有浏览记录',
      text: '看过的商品会按天收在这里，方便回头再找',
      action: '去逛逛',
    }
  }
  if (tab === 'favs') {
    return {
      title: '这一页还没接后端',
      text: '收藏接口已经上线，只是这一页还没接上 —— 你的收藏在「我的收藏」页可以看。',
      action: '去逛逛',
    }
  }
  return {
    title: '留言汇总还没有后端',
    text: '契约里没有「按作者取留言」的接口，所以这里暂时没有内容可看；上线后你发过的商品留言与交易评价都会收在这里。',
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

/** 真实构建下拉刷新时的说明（一个后端接口都没有，没有任何东西可刷） */
export const NO_BACKEND_REFRESH_TIP = '接口未接入，暂时没有可刷新的数据'

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
  /** 数据属于哪个登录用户：换账号后迟到的结果必须被丢弃（见 `index.tsx` 的 `cancellable`） */
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
 * **真实构建下 `cleared` 恒为全 false**（演示清空之外没有别的写入者，`canClearTab` 对
 * 收藏 / 留言为假；真实浏览档的清空直接以服务端为准、不走这份标记），这个函数是恒等变换。
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
