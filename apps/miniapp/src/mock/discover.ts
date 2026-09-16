import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { LISTING_BY_ID } from './catalog'
import type { HotSearchItem, MockComment, SearchFilter } from './types'
import { WISHES } from './wishes'

const HOUR = 3600 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function iso(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString()
}

/* ------------------------------------------------------------------ 留言 */

/**
 * 商品详情页留言。**契约里没有 comments 域**（`packages/contracts/src` 无此模块），
 * 所以这块是纯展示 mock，不做「假装有接口」的包装。
 */
export const COMMENTS: MockComment[] = [
  {
    id: 'cm-001',
    listingId: 'l-001',
    authorName: '林一',
    authorInitial: '林',
    isSeller: false,
    content: '键盘还在吗？我在三教上课，下课就能过去拿。',
    timeLabel: '5 分钟前',
  },
  {
    id: 'cm-002',
    listingId: 'l-001',
    authorName: '苏打水',
    authorInitial: '苏',
    isSeller: false,
    content: '这个白色太好看了，和 iPad 摆一起绝配。',
    timeLabel: '18 分钟前',
  },
  {
    id: 'cm-003',
    listingId: 'l-001',
    authorName: '阿岚',
    authorInitial: '岚',
    isSeller: true,
    content: '还在的～今晚我在图书馆一楼自习到九点，随时可以约。',
    timeLabel: '32 分钟前',
  },
  {
    id: 'cm-004',
    listingId: 'l-001',
    authorName: '陈小舟',
    authorInitial: '陈',
    isSeller: false,
    content: '能小刀一点吗？125 我今天就要。',
    timeLabel: '1 小时前',
  },
  {
    id: 'cm-005',
    listingId: 'l-001',
    authorName: '小满',
    authorInitial: '满',
    isSeller: false,
    content: 'K380 可以同时连三台设备吗？',
    timeLabel: '3 小时前',
  },
  {
    id: 'cm-006',
    listingId: 'l-001',
    authorName: '老周',
    authorInitial: '周',
    isSeller: false,
    content: '先收藏了，等发生活费再来看看。',
    timeLabel: '昨天',
  },
]

export function commentsOf(listingId: string): MockComment[] {
  const own = COMMENTS.filter((comment) => comment.listingId === listingId)
  if (own.length > 0) return own
  // 其它商品复用同一批留言（换掉商品 id），保证任何详情页都有内容可看
  return COMMENTS.slice(0, 3).map((comment) => ({ ...comment, listingId }))
}

/* ------------------------------------------------------------------ 通知 */

/**
 * 通知 fixture：**契约形状**（`NotificationDto`）。
 *
 * 契约里没有文案字段（#23：「服务端不存也不返回文案」），也没有 `kind` / `read`；
 * 文案与跳转目标由 `mock/api.ts` 的 `decorateNotification()` 按 `type` + `payload` 组装，
 * 所以这里只放 `type` / `payload` / `readAt` / `createdAt`。
 *
 * P0 契约的 `type` 只有 `MATCH`（`notifications/schema.ts`）。四条 fixture 用不同的
 * `payload` 覆盖三种页面分支：命中在售商品 / 目标已下架 / 没有可跳目标。
 */
export const NOTIFICATIONS: NotificationDto[] = [
  {
    id: 'n-001',
    type: 'MATCH',
    payload: { listingId: 'l-004', wishId: 'w-001' },
    readAt: null,
    createdAt: iso(1),
  },
  {
    id: 'n-002',
    type: 'MATCH',
    payload: { listingId: 'l-001', wishId: 'w-003' },
    readAt: null,
    createdAt: iso(1.2),
  },
  {
    id: 'n-003',
    type: 'MATCH',
    payload: { listingId: 'l-002', wishId: 'w-002' },
    readAt: iso(20),
    createdAt: iso(20),
  },
  {
    // 目标商品已被删除 / 下架：跳转要退回愿望页（与 web 端 decorateNotification 同口径）
    id: 'n-004',
    type: 'MATCH',
    payload: { wishId: 'w-004' },
    readAt: iso(30),
    createdAt: iso(30),
  },
]

/* ------------------------------------------------------------------ 搜索 */

export const HOT_SEARCHES: HotSearchItem[] = [
  { term: '考研教材', count: 1284 },
  { term: '机械键盘', count: 976 },
  { term: '山地车', count: 812 },
  { term: 'Kindle', count: 604 },
  { term: '羽毛球拍', count: 537 },
  { term: '宿舍台灯', count: 449 },
  { term: '民谣吉他', count: 318 },
  { term: '无线鼠标', count: 276 },
]

/** 默认搜索历史（真实实现应持久化到 storage，这里给初始值） */
export const DEFAULT_SEARCH_HISTORY: string[] = [
  '机械键盘',
  '考研教材',
  '山地车',
  'Kindle',
  '羽毛球拍',
  '台灯',
]

export const SEARCH_FILTERS: SearchFilter[] = ['综合', '最新', '价格', '成色']

export const SEARCH_PLACEHOLDER = '搜索「机械键盘」「考研教材」'

/** 校验用：确保 fixture 里的 listingId 都真实存在（防止改数据时留下悬空引用） */
export function assertFixtures(): string[] {
  const problems: string[] = []
  for (const comment of COMMENTS) {
    if (!LISTING_BY_ID[comment.listingId])
      problems.push(`COMMENTS ${comment.id} → ${comment.listingId}`)
  }
  for (const notification of NOTIFICATIONS) {
    // `listingId` 在契约里是 `payload` 的嵌套键；缺省（如 n-004 的容错演示）不算问题
    const id = notification.payload.listingId
    if (id && !LISTING_BY_ID[id]) {
      problems.push(`NOTIFICATIONS ${notification.id} → ${id}`)
    }
  }
  for (const wish of WISHES) {
    if (!wish.id) problems.push('WISH 缺 id')
  }
  return problems
}
