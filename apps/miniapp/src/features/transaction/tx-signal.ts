import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  type TransactionSystemEvent,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'

/**
 * 会话消息里的交易事件（`tx.*`）解析。
 *
 * 调用方共用这一份规则：`pages/mylist/pending.ts`（卖家「待确认」段）、
 * `features/chat/capsule.ts`（消息页会话行胶囊）与 `pages/chat/list-view.ts`（列表预览）。
 * 三处都在回答同一个问题 ——「这个会话里最后一个交易事件是什么」，口径分叉会让同一笔提案
 * 在一页显示、另一页消失。
 *
 * 关键取舍（`pending.ts` 文件头第 1 条）：取**最后一个事件**而不是最后一条消息。
 * 买家提案之后卖家可能先回了句话（TEXT），提案仍在等点头；只认最后一条消息会漏掉它。
 */

export type TxSignal = { event: TransactionSystemEvent; createdAt: string }

/**
 * 列表 / 会话页用的**宽松**交易事件：只认 `type`，`transactionId` / `amountCents` 有就带。
 *
 * 为什么不能直接用契约的 `transactionSystemEventSchema`：它要求 `tx.accepted` 必带
 * `transactionId`，而 #521 明确要兼容「老数据里没有 id 的 accepted」。严格解析会把这类
 * 历史消息当成不存在，于是「最后一个交易事件」退回更早的 `tx.proposal` —— 已取消的交易
 * 会被显示成「待同意」，预览却写着「交易已取消」，同一行自相矛盾。
 *
 * 写接口仍用严格 schema（缺字段的请求应当 422）；这里只放宽**读**。
 */
export type TxMessageEvent = {
  type: 'tx.proposal' | 'tx.accepted' | 'tx.rejected'
  transactionId?: string
  amountCents?: number
}

/** 读路径的交易事件解析：`type` 必须是已知三元之一，其余字段能取则取。 */
export function txMessageEventOfContent(content: string): TxMessageEvent | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed === null || typeof parsed !== 'object') return null
    const type = (parsed as { type?: unknown }).type
    if (type !== 'tx.proposal' && type !== 'tx.accepted' && type !== 'tx.rejected') return null
    const transactionId = (parsed as { transactionId?: unknown }).transactionId
    const amountCents = (parsed as { amountCents?: unknown }).amountCents
    return {
      type,
      ...(typeof transactionId === 'string' && transactionId.length > 0 ? { transactionId } : {}),
      ...(typeof amountCents === 'number' ? { amountCents } : {}),
    }
  } catch {
    // 非 JSON 的 SYSTEM 消息（例如认证通知）：按普通文本看待
    return null
  }
}

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

/** 会话里**最后一个**交易事件（宽松口径，兼容缺 id 的老 accepted）；顺序扫即可 */
export function lastTxMessageEventOf(messages: readonly MessageDto[]): TxMessageEvent | null {
  let found: TxMessageEvent | null = null
  for (const message of messages) {
    if (message.type !== 'SYSTEM') continue
    const event = txMessageEventOfContent(message.content)
    if (event) found = event
  }
  return found
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
