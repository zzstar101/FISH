import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  type TransactionSystemEvent,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'

/**
 * 会话消息里的交易事件（`tx.*`）解析。
 *
 * 两个调用方共用这一份规则：`pages/mylist/pending.ts`（卖家「待确认」段）与
 * `features/chat/capsule.ts`（消息页会话行胶囊）。两处都在回答同一个问题
 * ——「这个会话里最后一个交易事件是什么」，口径分叉会让同一笔提案在一页显示、另一页消失。
 *
 * 关键取舍（`pending.ts` 文件头第 1 条）：取**最后一个事件**而不是最后一条消息。
 * 买家提案之后卖家可能先回了句话（TEXT），提案仍在等点头；只认最后一条消息会漏掉它。
 */

export type TxSignal = { event: TransactionSystemEvent; createdAt: string }

/** 一条 SYSTEM 消息的 content 是不是交易事件（`tx.*`）；不是就返回 null */
export function txEventOfContent(content: string): TransactionSystemEvent | null {
  try {
    const parsed = transactionSystemEventSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    // 非 JSON 的 SYSTEM 消息（例如认证通知）：按普通文本看待
    return null
  }
}

/** 一条消息是不是交易 SYSTEM 事件；不是就返回 null（TEXT / 其它系统消息） */
export function txSignalOf(message: MessageDto): TxSignal | null {
  if (message.type !== 'SYSTEM') return null
  const event = txEventOfContent(message.content)
  return event ? { event, createdAt: message.createdAt } : null
}

/** 会话里**最后一个**交易事件；一个都没有则 null。消息按 `(createdAt, id)` 升序返回，顺序扫即可 */
export function lastTxSignalOf(messages: readonly MessageDto[]): TxSignal | null {
  let found: TxSignal | null = null
  for (const message of messages) {
    const signal = txSignalOf(message)
    if (signal) found = signal
  }
  return found
}
