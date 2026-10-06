import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { getListing, LISTING_BY_ID } from './catalog'
import { mockPublicId } from './public-id'
import type { MockComment } from './types'
import { WISHES } from './wishes'

const HOUR = 3600 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function iso(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString()
}

/* ------------------------------------------------------------------ 留言 */

/**
 * 商品详情页留言 fixture。真实读路径是 #111 的 `GET /listings/:id/comments`
 * （契约 `@fish/contracts/comments/schema`）；这份 mock 只在演示构建（`TARO_APP_MOCK=1`）退回时用。
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
    id: mockPublicId('ntf', 'n-001'),
    type: 'MATCH',
    payload: { listingId: mockPublicId('lst', 'l-004'), wishId: mockPublicId('wsh', 'w-001') },
    readAt: null,
    createdAt: iso(1),
  },
  {
    id: mockPublicId('ntf', 'n-002'),
    type: 'MATCH',
    payload: { listingId: mockPublicId('lst', 'l-001'), wishId: mockPublicId('wsh', 'w-003') },
    readAt: null,
    createdAt: iso(1.2),
  },
  {
    id: mockPublicId('ntf', 'n-003'),
    type: 'MATCH',
    payload: { listingId: mockPublicId('lst', 'l-002'), wishId: mockPublicId('wsh', 'w-002') },
    readAt: iso(20),
    createdAt: iso(20),
  },
  {
    // 目标商品已被删除 / 下架：跳转要退回愿望页（与 web 端 decorateNotification 同口径）
    id: mockPublicId('ntf', 'n-004'),
    type: 'MATCH',
    payload: { wishId: mockPublicId('wsh', 'w-004') },
    readAt: iso(30),
    createdAt: iso(30),
  },
]

/* ------------------------------------------------------------------ 搜索 */

// 搜索页默认文案已挪到 `@/lib/search-defaults`（页面运行期常量，不是演示数据；
// 页面不该为了几行文案静态 import 整包 fixture）。这里 re-export 保持既有路径。
export {
  DEFAULT_SEARCH_HISTORY,
  HOT_SEARCHES,
  SEARCH_FILTERS,
  SEARCH_PLACEHOLDER,
} from '@/lib/search-defaults'

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
    if (id && !getListing(id)) {
      problems.push(`NOTIFICATIONS ${notification.id} → ${id}`)
    }
  }
  for (const wish of WISHES) {
    if (!wish.id) problems.push('WISH 缺 id')
  }
  return problems
}
