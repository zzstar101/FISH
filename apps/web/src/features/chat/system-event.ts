import {
  type TransactionSystemEvent,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'
import { formatPrice } from '../../lib/format'

/**
 * #11 的 SYSTEM 消息内容协议：提案/接受/拒绝以 SYSTEM 消息进会话，content 是 JSON
 * 判别联合。解析直接用 `@fish/contracts/transactions/schema` 的
 * `transactionSystemEventSchema`（#41 前手工镜像已随契约合并退役）。
 *
 * 解析失败必须返回 null、调用方降级为普通文本渲染——这是契约里冻结的「优雅降级」，
 * 协议演化不破坏聊天，残缺/异构的 SYSTEM 消息不能把页面炸掉。
 */
type SystemEvent = TransactionSystemEvent

export type { SystemEvent }

export function parseSystemEvent(content: string): SystemEvent | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  const result = transactionSystemEventSchema.safeParse(value)
  return result.success ? result.data : null
}

/** SYSTEM 消息的气泡文案。文案刻意不区分查看者是买方还是卖方(SENDER 为空)。 */
function systemEventText(event: SystemEvent): string {
  switch (event.type) {
    case 'tx.proposal':
      return `发起了交易确认 · ${formatPrice(event.amountCents)},等待卖家接受`
    case 'tx.accepted':
      return `卖家已接受交易 · ${formatPrice(event.amountCents)},待面交`
    case 'tx.rejected':
      return '卖家拒绝了本次交易确认'
  }
}

/** SYSTEM 消息（契约 MessageDto）的渲染文案：先解析协议，失败降级原文。 */
export function formatSystemMessageBody(content: string): string {
  const event = parseSystemEvent(content)
  return event ? systemEventText(event) : content
}

/** 会话列表预览与气泡共用：TEXT 直出，SYSTEM 先解析。 */
export function formatMessageBody(message: { type: 'TEXT' | 'SYSTEM'; content: string }): string {
  return message.type === 'SYSTEM' ? formatSystemMessageBody(message.content) : message.content
}

/**
 * 会话里「最后一条交易事件」：从尾部往前找第一条能解析的 SYSTEM 消息。
 * 卖家的 接受/拒绝 按钮只对「最后事件是 proposal」的会话出现——
 * 契约没有「提案」实体（不落库），消息流就是它的唯一事实来源。
 */
export function lastTransactionEvent(
  messages: { type: 'TEXT' | 'SYSTEM'; content: string }[],
): SystemEvent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type: 'TEXT' | 'SYSTEM'; content: string }
    if (message.type !== 'SYSTEM') continue
    const event = parseSystemEvent(message.content)
    if (event) return event
  }
  return null
}
