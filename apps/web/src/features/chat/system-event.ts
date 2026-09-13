import type { Message } from '../../lib/mock/types'
import { formatPrice } from '../../lib/format'

/**
 * #11 的 SYSTEM 消息内容协议:提案/接受/拒绝以 SYSTEM 消息进会话,content 是 JSON
 * 判别联合(`packages/contracts/src/transactions/schema.ts` 的
 * `transactionSystemEventSchema`,分支 feat/11-tx)。契约分支未合并,这里手写同形状的
 * 收窄,合并后可换成 @fish/contracts 的 schema。
 *
 * 解析失败必须返回 null、调用方降级为普通文本渲染——这是契约里冻结的「优雅降级」,
 * 协议演化不破坏聊天,残缺/异构的 SYSTEM 消息不能把页面炸掉。
 */
export type SystemEvent =
  | { type: 'tx.proposal'; amountCents: number }
  | { type: 'tx.accepted'; transactionId: string; amountCents: number }
  | { type: 'tx.rejected' }

export function parseSystemEvent(content: string): SystemEvent | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const event = value as Record<string, unknown>
  if (event.type === 'tx.proposal' || event.type === 'tx.accepted') {
    // 金额范围对齐 #6 的 PriceCentsSchema（0–¥100,000）：负数或天文数字都按
    // 解析失败处理，降级为原文，而不是渲染出「¥-450.00」这类可信的假价格。
    if (
      typeof event.amountCents !== 'number' ||
      !Number.isInteger(event.amountCents) ||
      event.amountCents < 0 ||
      event.amountCents > 10_000_000
    )
      return null
    if (event.type === 'tx.accepted') {
      if (typeof event.transactionId !== 'string') return null
      return { type: 'tx.accepted', transactionId: event.transactionId, amountCents: event.amountCents }
    }
    return { type: 'tx.proposal', amountCents: event.amountCents }
  }
  if (event.type === 'tx.rejected') return { type: 'tx.rejected' }
  return null
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

/** 聊天气泡与会话列表预览共用的渲染文案:SYSTEM 先解析协议,失败降级原文。 */
export function formatMessageBody(message: Message): string {
  if (message.kind !== 'SYSTEM') return message.text
  const event = parseSystemEvent(message.text)
  return event ? systemEventText(event) : message.text
}
