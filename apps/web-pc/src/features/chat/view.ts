import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
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
