import type { MediaMessageDto, MessageDto, MessageVisibility } from '@fish/contracts/chat/schema'
import { transactionSystemEventSchema } from '@fish/contracts/transactions/schema'

function parseSystemEvent(content: string): { type: string } | null {
  try {
    const parsed = transactionSystemEventSchema.safeParse(JSON.parse(content))
    return parsed.success ? { type: parsed.data.type } : null
  } catch {
    // 非 JSON 的系统消息按原文渲染。
  }
  return null
}

/** 交易 SYSTEM 事件中文化；解析不了就按原文展示。 */
export function systemMessageText(content: string): string {
  const event = parseSystemEvent(content)
  if (event === null) return content
  if (event.type === 'tx.proposal') return '交易确认待处理'
  if (event.type === 'tx.accepted') return '交易已接受，待面交'
  if (event.type === 'tx.rejected') return '卖家已拒绝这次交易'
  return content
}

export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * 能否撤回这条消息（#359 3c）：发送者是本人、尚未撤回、且仍在窗口内。
 *
 * **窗口只能用客户端时钟近似**：服务端按**数据库时钟**判 `MESSAGE_RECALL_WINDOW_MS`，
 * 端上拿不到那个时钟，只能拿服务端给的 `createdAt` 与本地 `nowMs` 相减（与小程序
 * `pages/conversation/view.ts` 的 `canRecallMessage` 同款）。时钟偏差只会让按钮多显示
 * 一会儿 → 点下去收 409，由服务端定论，**不会造成错误撤回**。
 *
 * 文本与媒体两类 DTO 都有 `senderId` / `recalledAt` / `createdAt`，所以判据共用一份。
 */
export function canRecallMessage(
  message: { senderId: string | null; recalledAt: string | null; createdAt: string },
  viewerId: string | null,
  nowMs: number,
  windowMs: number,
): boolean {
  if (viewerId === null || message.senderId !== viewerId) return false
  if (message.recalledAt !== null) return false
  const created = Date.parse(message.createdAt)
  if (Number.isNaN(created)) return false
  return nowMs - created <= windowMs
}

function excludeCachedById<T extends { id: string }>(local: T[], cached: T[]): T[] {
  const seen = new Set(cached.map((item) => item.id))
  return local.filter((item) => !seen.has(item.id))
}

/** 历史页里已出现的本地消息不再单独渲染，避免同一 id 出现两个气泡。 */
export function excludeCachedMessages(
  localMessages: MessageDto[],
  messages: MessageDto[],
): MessageDto[] {
  return excludeCachedById(localMessages, messages)
}

/** 媒体版同义：断线兜底的本地媒体也不能和历史页里的同一条并存。 */
export function excludeCachedMedia(
  localMedia: MediaMessageDto[],
  media: MediaMessageDto[],
): MediaMessageDto[] {
  return excludeCachedById(localMedia, media)
}

/**
 * 会话页时间线上的一项。文本与媒体来自两个端点 / 两条实时通道
 * （`/messages` 明确排除 `type='MEDIA'`，媒体走 `/media` + `media.new`），
 * 渲染层必须按 (createdAt, id) 重新归并，否则两类气泡会各排一段、顺序错乱。
 */
export type ChatTimelineItem =
  | { kind: 'message'; id: string; createdAt: string; message: MessageDto }
  | { kind: 'media'; id: string; createdAt: string; media: MediaMessageDto }

/** 按 (createdAt, id) 归并文本与媒体，口径与两个历史端点的升序一致。 */
export function buildTimeline(
  messages: MessageDto[],
  mediaMessages: MediaMessageDto[],
): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = []
  for (const message of messages) {
    items.push({ kind: 'message', id: message.id, createdAt: message.createdAt, message })
  }
  for (const media of mediaMessages) {
    items.push({ kind: 'media', id: media.id, createdAt: media.createdAt, media })
  }
  return items.sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt)
    if (byTime !== 0) return byTime
    return a.id.localeCompare(b.id)
  })
}

/**
 * 审核态标签（#694 M4）。三种 visibility 里只有 `PENDING_REVIEW` / `REJECTED` 需要额外说明：
 * 它们**只对发送者可见** —— 接收者视角里服务端根本不下发这些行（未读、摘要、历史、媒体 GET
 * 一律按 `visibility='DELIVERED'` 过滤），所以标签也只给 mine。
 *
 * 非 mine 且非 DELIVERED 属于"不该发生"（例如实时缓存里残留的旧行），返回 null 让气泡
 * 自己兜底隐藏，避免把待审内容读给接收者。
 */
export function reviewStatusLabel(
  visibility: MessageVisibility,
  isMine: boolean,
): '审核中' | '未通过审核' | null {
  if (!isMine) return null
  if (visibility === 'PENDING_REVIEW') return '审核中'
  if (visibility === 'REJECTED') return '未通过审核'
  return null
}

/** 我发出的、仍在审核中的条数（文本 + 媒体），用于输入区顶部提示。 */
export function countPendingReview(
  items: readonly { senderId: string | null; visibility: MessageVisibility }[],
  viewerId: string | null,
): number {
  if (viewerId === null) return 0
  return items.filter((item) => item.senderId === viewerId && item.visibility === 'PENDING_REVIEW')
    .length
}
