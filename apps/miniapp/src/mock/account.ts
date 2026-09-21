/**
 * A/B/C 组 14 张设计稿新增域的 fixture：订单 / 交易码 / 想要的人 / 他人主页 /
 * 我的发布 / 认证 / 设置。
 *
 * 与契约的边界（每条都标注在上方类型定义里，这里再集中说明一次）：
 * - `transactions` 有契约（`TransactionDto`），字段已对齐；
 * - 交易码是**短期一次性 token**，真实实现由后端签发，这里固定 6 位码做静态演示；
 * - 「谁想要我的商品」`watchers`、公开用户资料 `userProfile` 契约里没有端点（P1），
 *   属于纯展示 mock，将来接真实接口时替换本文件即可，页面不动。
 *
 * 金额一律**整数分**，时间一律 ISO 字符串（与既有 fixture 同源：NOW = 2026-09-14 12:00Z）。
 */
import { watcherStatsOf } from '@/features/watchers/stats'
import { getListing, LISTINGS } from './catalog'
import { AVATARS } from './images'
import type {
  MockMeetupCode,
  MockMyListing,
  MockSettings,
  MockTransaction,
  MockUserProfile,
  MockWatcher,
  MyListingStatusKey,
  TransactionStatus,
} from './types'
import { getUser, ME } from './users'

const HOUR = 3600 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

/* ------------------------------------------------------------------ 订单 */

type TxSpec = {
  id: string
  listingId: string
  role: 'buyer' | 'seller'
  counterpartId: string
  /** 单位：元，×100 成整数分 */
  amount: number
  status: TransactionStatus
  /** 创建时间距今多少毫秒 */
  agoMs: number
  /**
   * 到达终态（完成 / 取消）距今多少毫秒。**必须小于 `agoMs`**（结果晚于创建）。
   * 只有 COMPLETED / CANCELLED 需要给；不给则该行的 `completedAt` / `cancelledAt` 为 `null`。
   */
  settledAgoMs?: number
}

/**
 * 11 笔交易，**买卖两个视角各自都能看到三种状态**（Owner 定版：演示时要一次看全
 * 「待面交 / 已完成 / 已取消」三种卡，所以两侧都补了数据）：
 * - 我买到的 6 笔：待面交 3 · 已完成 2 · 已取消 1
 * - 我卖出的 5 笔：待面交 2 · 已完成 2 · 已取消 1
 *
 * 两处刻意的取舍，都为了让**页面内部自洽**（设计稿自述「示例数据为占位」）：
 * 1. 买入侧的 `counterpartId` 一律取自商品 fixture 的 `sellerId`，而不是照抄稿子里的
 *    占位昵称——否则头像首字 / 昵称 / 商品归属会对不上（例如稿子里「高数」写张屿，
 *    而 fixture 里这本书属于苏苏，且会话 c-003 也一直是苏苏在聊）。
 *    卖出侧的对方是买家，商品里没有这个字段，按 fixture 里既有的用户 id 写。
 * 2. **交易不带 `conversationId`**：契约的 `TransactionDto` 没有这个字段，会话由
 *    (listingId, 对方) 定位（`openConversation()`，口径同 #72 / PR #82）。
 */
const TX_SPECS: TxSpec[] = [
  /* —— 我买到的 —— */
  {
    id: 't-101',
    listingId: 'l-047', // 《高等数学》第七版 上册 含习题册（卖家：张屿）
    role: 'buyer',
    counterpartId: 'u-zhangyu',
    amount: 18,
    status: 'PENDING_MEETUP',
    agoMs: 5 * HOUR,
  },
  {
    id: 't-102',
    listingId: 'l-026', // 罗技 M590 静音无线鼠标（卖家：林知遥）
    role: 'buyer',
    counterpartId: 'u-lin',
    amount: 85,
    status: 'PENDING_MEETUP',
    agoMs: 20 * HOUR,
  },
  {
    id: 't-103',
    listingId: 'l-031', // 佳能 EOS 700D 单反套机（卖家：苏亦然）
    role: 'buyer',
    counterpartId: 'u-suyiran',
    amount: 1050,
    status: 'PENDING_MEETUP',
    agoMs: 30 * 24 * HOUR,
  },
  /* —— 我买到的（已完成 / 已取消，让买入视角也能看全三种状态）—— */
  {
    id: 't-107',
    listingId: 'l-001', // 索尼 WH-1000XM4 头戴降噪耳机（卖家：橙子）
    role: 'buyer',
    counterpartId: 'u-chengzi',
    amount: 720,
    status: 'COMPLETED',
    agoMs: 12 * 24 * HOUR,
    settledAgoMs: 11 * 24 * HOUR,
  },
  {
    id: 't-108',
    listingId: 'l-004', // 高等数学 同济第七版 上下册（卖家：苏苏）
    role: 'buyer',
    counterpartId: 'u-susu',
    amount: 40,
    status: 'COMPLETED',
    agoMs: 18 * 24 * HOUR,
    settledAgoMs: 17 * 24 * HOUR,
  },
  {
    id: 't-109',
    listingId: 'l-013', // 斯伯丁篮球 7 号 室内外通用（卖家：周舟）
    role: 'buyer',
    counterpartId: 'u-zhou',
    amount: 80,
    status: 'CANCELLED',
    agoMs: 22 * 24 * HOUR,
    settledAgoMs: 22 * 24 * HOUR - 8 * HOUR,
  },
  /* —— 我卖出的 —— */
  {
    id: 't-104',
    listingId: 'l-037', // 米家 LED 护眼台灯（我卖的）
    role: 'seller',
    counterpartId: 'u-zhouyan',
    amount: 45,
    status: 'COMPLETED',
    agoMs: 27 * 24 * HOUR,
    settledAgoMs: 26 * 24 * HOUR, // 创建后一天完成面交
  },
  {
    id: 't-105',
    listingId: 'l-038', // 达尔优 A87 机械键盘（我卖的）
    role: 'seller',
    counterpartId: 'u-hexu',
    amount: 120,
    status: 'CANCELLED',
    agoMs: 31 * 24 * HOUR,
    settledAgoMs: 31 * 24 * HOUR - 6 * HOUR, // 创建后六小时取消
  },
  {
    id: 't-106',
    listingId: 'l-039', // 尤尼克斯 羽毛球拍（我卖的）
    role: 'seller',
    counterpartId: 'u-xuche',
    amount: 160,
    status: 'COMPLETED',
    agoMs: 34 * 24 * HOUR,
    settledAgoMs: 33 * 24 * HOUR,
  },
  /* —— 我卖出的（待面交，让卖出视角也能看全三种状态）—— */
  {
    id: 't-110',
    listingId: 'l-002', // 联想 ThinkPad X280 轻薄本（我卖的）
    role: 'seller',
    counterpartId: 'u-lin',
    amount: 1500,
    status: 'PENDING_MEETUP',
    agoMs: 3 * 24 * HOUR,
  },
  {
    id: 't-111',
    listingId: 'l-012', // 电动车头盔 3C 认证（我卖的）
    role: 'seller',
    counterpartId: 'u-qiqi',
    amount: 40,
    status: 'PENDING_MEETUP',
    agoMs: 9 * 24 * HOUR,
  },
]

export const TRANSACTIONS: MockTransaction[] = TX_SPECS.map((spec) => {
  // 结果时间：只有终态才有，且与 status 一一对应（镜像契约 `transactionDtoSchema`
  // 的两条 refine：COMPLETED ⟺ completedAt、CANCELLED ⟺ cancelledAt）
  const settledAt = spec.settledAgoMs === undefined ? null : isoAgo(spec.settledAgoMs)
  return {
    id: spec.id,
    listingId: spec.listingId,
    role: spec.role,
    counterpartId: spec.counterpartId,
    amountCents: Math.round(spec.amount * 100),
    status: spec.status,
    createdAt: isoAgo(spec.agoMs),
    completedAt: spec.status === 'COMPLETED' ? settledAt : null,
    cancelledAt: spec.status === 'CANCELLED' ? settledAt : null,
  }
})

export const TRANSACTION_BY_ID: Record<string, MockTransaction> = Object.fromEntries(
  TRANSACTIONS.map((tx) => [tx.id, tx]),
)

export function transactionsOf(role: 'buyer' | 'seller'): MockTransaction[] {
  return TRANSACTIONS.filter((tx) => tx.role === role).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
}

/* ---------------------------------------------------------------- 交易码 */

/**
 * 交易码 fixture。
 *
 * 设计稿 A2 画了 4 个状态：待面交（ACTIVE）/ 已完成 / 码错误 / 已过期。
 * 「码错误」「非参与者」不是某笔交易的属性，而是**交互结果**，由页面在
 * 手动输入后自行判定（见 transaction-meetup 页的实现），这里只给每笔
 * 挂着 ACTIVE / COMPLETED 两种静态态。
 */
export function meetupCodeOf(transactionId: string): MockMeetupCode {
  const tx = TRANSACTION_BY_ID[transactionId]
  if (!tx) return { code: '000000', state: 'NOT_PARTICIPANT', expiresInSec: 0 }
  if (tx.status === 'COMPLETED') return { code: '000000', state: 'COMPLETED', expiresInSec: 0 }
  if (tx.status === 'CANCELLED') return { code: '000000', state: 'EXPIRED', expiresInSec: 0 }
  // 固定 6 位码：真实实现由后端签发短期一次性 token
  return { code: '836214', state: 'ACTIVE', expiresInSec: 272 }
}

/** 「刷新」后的新码（演示用：换一组数字并重置倒计时） */
export function rotateMeetupCode(seed: number): string {
  const base = 100000 + ((seed * 7919) % 899999)
  return String(base)
}

/* ------------------------------------------------------- 想要的人（C5，无契约） */

type WatcherSpec = {
  id: string
  nickname: string
  avatarIndex: number
  department: string | null
  /** 单位：元；null = 未填预算（不计入中位数） */
  budget: number | null
  verified: boolean
  chattedCount: number
  timeLabel: string
  deactivated?: boolean
}

/**
 * C5「想要的人」。稿子里的对象是「罗技 MX Keys 无线键盘」，对应 `digital-mxkeys`。
 * 稿子第 02 帧的四种行状态（已聊 / 长昵称 / 未公开校区 / 已注销）都在这里各有一条，
 * 保证实现侧能逐一对照。
 */
const WATCHER_SPECS: WatcherSpec[] = [
  {
    id: 'w-01',
    nickname: '林小满',
    avatarIndex: 0,
    department: '计算机学院',
    budget: 350,
    verified: true,
    chattedCount: 0,
    timeLabel: '刚刚',
  },
  {
    id: 'w-02',
    nickname: '周予安',
    avatarIndex: 1,
    department: '外国语学院',
    budget: 300,
    verified: true,
    chattedCount: 0,
    timeLabel: '2 小时前',
  },
  {
    id: 'w-03',
    nickname: '陈屿',
    avatarIndex: 2,
    department: '数学学院',
    budget: null,
    verified: false,
    chattedCount: 0,
    timeLabel: '昨天 21:04',
  },
  {
    id: 'w-04',
    nickname: '苏晚',
    avatarIndex: 3,
    department: '设计学院',
    budget: 320,
    verified: true,
    chattedCount: 0,
    timeLabel: '3 天前',
  },
  /* —— 第 02 帧的四种行状态 —— */
  {
    id: 'w-05',
    nickname: '何知遥',
    avatarIndex: 4,
    department: '经济学院',
    budget: 300,
    verified: true,
    chattedCount: 3,
    timeLabel: '4 天前',
  },
  {
    id: 'w-06',
    nickname: '沐橙不是橙子也不吃橙子皮',
    avatarIndex: 5,
    department: null, // 未公开校区 / 院系
    budget: 280,
    verified: true,
    chattedCount: 0,
    timeLabel: '5 天前',
  },
  {
    id: 'w-07',
    nickname: '赵一鸣',
    avatarIndex: 6,
    department: '物理学院',
    budget: 400,
    verified: true,
    chattedCount: 1,
    timeLabel: '上周',
  },
  {
    id: 'w-08',
    nickname: '已注销用户',
    avatarIndex: 7,
    department: null,
    budget: 300,
    verified: false,
    chattedCount: 0,
    timeLabel: '上周',
    deactivated: true,
  },
]

/** 想要的人挂在「罗技 MX Keys 无线键盘」上（C5 稿子的那件商品，归属当前用户） */
export const WATCHER_LISTING_ID = 'l-044'

export const WATCHERS: MockWatcher[] = WATCHER_SPECS.map((spec) => ({
  id: spec.id,
  listingId: WATCHER_LISTING_ID,
  deactivated: spec.deactivated ?? false,
  nickname: spec.nickname,
  avatarUrl: spec.deactivated ? '' : (AVATARS[spec.avatarIndex % AVATARS.length] ?? ''),
  department: spec.department,
  budgetCents: spec.budget === null ? null : Math.round(spec.budget * 100),
  authStatus: spec.verified ? 'VERIFIED' : 'UNVERIFIED',
  chattedCount: spec.chattedCount,
  timeLabel: spec.timeLabel,
}))

/**
 * 统计：共 N 人想要 + **预算中位**。算法与页面共用 `watcherStatsOf()`
 * （见 `@/features/watchers/stats` 的口径说明），避免两处各算一套。
 *
 * ⚠️ 页面**不再调用**它（改为对已加载的列表现算）：mock 侧这份数永远成功，
 * 列表失败时页面拿它会出现「共 7 人想要 + 列表加载失败」（#139 review P1）。
 * 保留给「不经过加载流程」的调用方（如商品卡只要一个总数时用 `watcherCount`）。
 */
export function watcherStats(listingId: string = WATCHER_LISTING_ID) {
  return watcherStatsOf(WATCHERS.filter((w) => w.listingId === listingId))
}

/** 某商品有多少人想要（C4 列表行、商品详情「N 人想要」共用） */
export function watcherCount(listingId: string): number {
  if (listingId === WATCHER_LISTING_ID) return WATCHERS.length
  return getListing(listingId)?.wants ?? 0
}

/* ------------------------------------------------------ 他人主页（C2，无契约） */

type ProfileSpec = {
  userId: string
  joinedDays: number
  following: boolean
  hiddenCampus: boolean
}

const PROFILE_SPECS: ProfileSpec[] = [
  { userId: 'u-lin', joinedDays: 128, following: false, hiddenCampus: false },
  { userId: 'u-suyiran', joinedDays: 12, following: false, hiddenCampus: false },
  { userId: 'u-hexu', joinedDays: 210, following: false, hiddenCampus: false },
  { userId: 'u-zhouyan', joinedDays: 96, following: true, hiddenCampus: false },
  { userId: 'u-zhangyu', joinedDays: 64, following: false, hiddenCampus: true },
]

export function userProfile(userId: string): MockUserProfile {
  const user = getUser(userId)
  const spec = PROFILE_SPECS.find((item) => item.userId === userId)
  // 在售数按 fixture 实际统计，避免「写了 12 件结果列表只有 3 件」的穿帮
  const active = LISTINGS.filter((l) => l.sellerId === userId && l.status === 'ACTIVE')
  const listed = LISTINGS.filter((l) => l.sellerId === userId)
  return {
    user,
    joinedDays: spec?.joinedDays ?? 100,
    activeCount: active.length,
    listedCount: listed.length + (user.soldCount ?? 0),
    // mock fixture 一定带这两项；`??` 只是为了「真实数据没有这两项」时类型成立
    goodRate: user.goodRate ?? 0,
    following: spec?.following ?? false,
    hiddenCampus: spec?.hiddenCampus ?? false,
  }
}

/* ------------------------------------------------------ 我的发布（C4） */

const STATUS_META: Record<MyListingStatusKey, { label: string; editable: boolean }> = {
  sale: { label: '在售', editable: true },
  reserved: { label: '已预订', editable: false },
  sold: { label: '已售出', editable: false },
  off: { label: '已下架', editable: true },
}

/** C4 的「全部 7 件 · 在售 3 · 已预订 1 · 已售出 2 · 已下架 1」 */
const MY_LISTING_SPECS: { listingId: string; key: MyListingStatusKey }[] = [
  { listingId: 'l-044', key: 'sale' }, // 罗技 MX Keys 无线键盘（C5 也用它）
  { listingId: 'l-041', key: 'sale' }, // 绿联 USB-C 扩展坞
  { listingId: 'l-042', key: 'sale' }, // 小米 20W 无线充电器
  { listingId: 'l-043', key: 'reserved' }, // iPad 磁吸保护壳
  { listingId: 'l-040', key: 'sold' }, // 罗技 C920 摄像头
  { listingId: 'l-026', key: 'sold' }, // 罗技 M590 鼠标
  { listingId: 'l-030', key: 'off' }, // 樱桃 MX 3.0S 机械键盘
]

/**
 * 我的发布列表：**以 fixture 里 sellerId = 我 的商品为准**，
 * 再按上面的清单指定展示状态；清单里没有的我的在售商品按「在售」附带进来，
 * 这样「我的发布」永远和商品库一致，不会出现「列表里少了一件」的穿帮。
 */
export const MY_LISTINGS: MockMyListing[] = (() => {
  const listed = MY_LISTING_SPECS.flatMap((spec) => {
    const listing = getListing(spec.listingId)
    if (!listing) return []
    const meta = STATUS_META[spec.key]
    return [
      {
        listing,
        editable: meta.editable,
        statusLabel: meta.label,
        statusKey: spec.key,
        wants: watcherCount(spec.listingId),
      },
    ]
  })
  const seen = new Set(listed.map((item) => item.listing.id))
  const extra = LISTINGS.filter(
    (listing) => listing.sellerId === ME.id && listing.status === 'ACTIVE' && !seen.has(listing.id),
  ).map((listing) => ({
    listing,
    editable: true,
    statusLabel: STATUS_META.sale.label,
    statusKey: 'sale' as MyListingStatusKey,
    wants: watcherCount(listing.id),
  }))
  return [...listed, ...extra]
})()

export function myListingCounts() {
  const counts: Record<MyListingStatusKey, number> = { sale: 0, reserved: 0, sold: 0, off: 0 }
  MY_LISTINGS.forEach((item) => {
    counts[item.statusKey] += 1
  })
  return { all: MY_LISTINGS.length, ...counts }
}

/* ------------------------------------------------------------ 认证（B3） */

export const VERIFY: {
  state: 'UNVERIFIED' | 'VERIFIED'
  email: string | null
  verifiedAt: string | null
} = {
  // 当前用户阿岚是 VERIFIED（与个人页已有的认证徽章一致）
  state: ME.authStatus === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
  email: 'a***n@stu.edu.cn',
  verifiedAt: '2026-05-06',
}

/** 教育邮箱格式校验（B3：仅支持 @stu.edu.cn 与 @edu.cn 结尾） */
export function isEduEmail(email: string): boolean {
  return /@(([a-z0-9-]+\.)*stu\.edu\.cn|([a-z0-9-]+\.)*edu\.cn)$/i.test(email.trim())
}

/* ------------------------------------------------------------ 设置（B4） */

export const SETTINGS: MockSettings = {
  theme: 'system',
  notifyChat: true,
  notifyWish: true,
  notifyDeal: true,
  notifyNews: false,
  commentPolicy: '已认证用户',
  publicCampus: false,
}

export const THEME_OPTIONS: { key: MockSettings['theme']; label: string; desc: string }[] = [
  { key: 'system', label: '跟随系统', desc: '随手机「深色模式」设置自动切换' },
  { key: 'light', label: '亮色', desc: '始终使用冰蓝亮色主题' },
  { key: 'dark', label: '暗色', desc: '始终使用深色主题，夜间浏览更省电' },
]

export const APP_VERSION = '1.4.0'
export const APP_BUILD = '20260916'
