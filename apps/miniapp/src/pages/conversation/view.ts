import type { MessageDto } from '@fish/contracts/chat/schema'

/**
 * 会话页的展示逻辑（#89：从 fixture 改为真实历史 / 发送 / 已读）。
 *
 * 与 `pages/chat/list-view.ts` 同一手法：把「界面上写什么」抽成纯函数，
 * 组件只负责渲染。这里锁的是三类曾经靠人眼复审的判定：
 * 交易 SYSTEM 事件的中文化、时间文案、以及发送失败态。
 */

/** 交易 SYSTEM 事件（`transactions/schema.ts` 的 `tx.*` 协议） */
export type TxEvent = { type: string }

/**
 * 解析交易 SYSTEM 事件的 JSON；非 JSON（普通文本系统消息）返回 null。
 * 与消息列表页的预览降级口径一致：解析不了就按原文渲染。
 */
export function parseTxEvent(content: string): TxEvent | null {
  try {
    const event: unknown = JSON.parse(content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (typeof type === 'string') return { type }
    }
  } catch {
    // 非 JSON：当普通文本
  }
  return null
}

/**
 * 不属于专门卡片的 SYSTEM 消息的胶囊文案。
 *
 * `tx.accepted` 不走这里（它有自己的交易码卡）；`tx.proposal` / `tx.rejected`
 * 翻成中文，其余（含普通文本系统消息）按原文。
 */
export function systemPillText(content: string): string {
  const event = parseTxEvent(content)
  if (!event) return content
  if (event.type === 'tx.proposal') return '待对方同意'
  if (event.type === 'tx.rejected') return '卖家已拒绝这次交易'
  return content
}

/** 商品摘要条的状态文案（与「我的发布」同一口径） */
const LISTING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '在售',
  RESERVED: '已预订',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

export function listingStatusText(status: string | undefined): string {
  if (!status) return '商品已下架'
  return LISTING_STATUS_LABEL[status] ?? status
}

/**
 * 本地乐观消息（正在发送 / 发送失败）。
 *
 * 契约里没有「发送中」，这是纯客户端的临时状态：成功后被服务端返回的那条替换掉
 * （按 id 去重，实时推送送来的同一条也不会重复）。
 */
export type PendingMessage = {
  /** 本地临时 id（只用于渲染 key 与重试定位，不是服务端 id） */
  id: string
  content: string
  status: 'sending' | 'failed'
}

/**
 * 发送失败后是否还能重试同一个临时条目。
 * 组件用它当重试门禁（而不是在组件里再写一遍等价判断）：这样「失败才可重试」
 * 这条规则有测试直接锁在真实调用点上。
 */
export function canRetry(message: PendingMessage): boolean {
  return message.status === 'failed'
}

/**
 * 按契约的 `(createdAt, id)` 升序排。
 *
 * 为什么需要：发送成功是按**响应到达顺序**追加的，连发两条时响应可能乱序回来，
 * 界面上的先后就会与服务端落库顺序（契约的排序键）相反。
 */
export function sortMessages(items: MessageDto[]): MessageDto[] {
  return [...items].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    if (at !== bt) return at - bt
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

/**
 * 会话流里真正按顺序渲染的一条。
 * 服务端消息按 `(createdAt, id)` 升序；本地待发消息永远排在最后（它必然最新）。
 */
export type ChatEntry =
  | { kind: 'message'; keyId: string; message: MessageDto }
  | { kind: 'pending'; keyId: string; pending: PendingMessage }
