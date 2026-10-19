import type { DisputeUserSummary } from '@fish/contracts/disputes/schema'
import {
  DISPUTE_WINDOW_DAYS,
  type DisputeStatus,
  MAX_DISPUTE_ATTACHMENTS,
} from '@fish/contracts/disputes/schema'
import type { TransactionStatus } from '@fish/contracts/transactions/schema'
import { systemMessageText } from '../chat/view'

/**
 * 争议域的纯展示逻辑：不 import React / 查询层，`view.test.ts` 直接测。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 与服务端 `DISPUTE_WINDOW_DAYS` 同源的发起窗口。 */
export const DISPUTE_WINDOW_MS = DISPUTE_WINDOW_DAYS * DAY_MS

/** 发起争议判定所需的交易字段（`TransactionDto` / 争议内联交易摘要都满足）。 */
export type DisputableTransaction = {
  status: TransactionStatus
  completedAt: string | null
  cancelledAt: string | null
}

/**
 * 能否对这笔交易发起争议。**镜像服务端规则**（`isWindowClosed`）：
 * `PENDING_MEETUP` 没有时限；终态时间（`completedAt ?? cancelledAt`）起 30 天内可发起
 * （服务端以 `now - closedAt > 窗口` 拒绝，所以恰好第 30 天仍在窗口内）。
 *
 * 终态时间缺失时**放行**：服务端 `isWindowClosed` 对 `!closedAt` 直接返回 false（窗口开放），
 * 端上擅自关窗口会挡掉服务端本会受理的请求。契约的 status↔timestamp refine 已让这种 DTO
 * 不可达，这里只防御契约外输入，语义与后端保持一致（无法解析的时间同理，交给服务端判定）。
 */
export function canStartDispute(transaction: DisputableTransaction, now: number): boolean {
  if (transaction.status === 'PENDING_MEETUP') return true
  // 与服务端同源：completedAt ?? cancelledAt，而不是按 status 二选一。
  const closedAt = transaction.completedAt ?? transaction.cancelledAt
  if (closedAt === null) return true
  const closedMs = Date.parse(closedAt)
  if (Number.isNaN(closedMs)) return true
  return now - closedMs <= DISPUTE_WINDOW_MS
}

/** 订单详情上争议入口旁的一句解释：为什么可发起 / 为什么不可发起。 */
export function disputeWindowHint(transaction: DisputableTransaction, now: number): string {
  if (canStartDispute(transaction, now)) {
    return transaction.status === 'PENDING_MEETUP'
      ? '面交进行中的交易可以随时发起争议。'
      : `交易结束后 ${DISPUTE_WINDOW_DAYS} 天内可以发起争议。`
  }
  return `交易已结束超过 ${DISPUTE_WINDOW_DAYS} 天，无法再发起争议。`
}

/** 操作判定只看争议主体字段；`Dispute` 与 `DisputeDetail` 都满足。 */
export type DisputeActionSubject = {
  status: DisputeStatus
  initiator: DisputeUserSummary
}

/** 当前查看者是否是发起人（服务端对非发起人的撤回 / 补材料一律 404）。 */
export function isDisputeInitiator(dispute: DisputeActionSubject, viewerId: string): boolean {
  return dispute.initiator.id === viewerId
}

/** 发起人可在 `PENDING` 时撤回（终态不可复活）。 */
export function canWithdrawDispute(dispute: DisputeActionSubject, viewerId: string): boolean {
  return dispute.status === 'PENDING' && isDisputeInitiator(dispute, viewerId)
}

/**
 * 发起人可在 `PENDING` 时补材料 / 选聊天证据；被诉方只读
 * （服务端写入方只有发起人，被诉方会被 404）。
 */
export function canSupplementDispute(dispute: DisputeActionSubject, viewerId: string): boolean {
  return dispute.status === 'PENDING' && isDisputeInitiator(dispute, viewerId)
}

/** 附件配额判定：已达到 `MAX_DISPUTE_ATTACHMENTS` 时不再给上传入口。 */
export function canAddDisputeAttachment(
  dispute: DisputeActionSubject,
  viewerId: string,
  attachmentCount: number,
): boolean {
  return canSupplementDispute(dispute, viewerId) && attachmentCount < MAX_DISPUTE_ATTACHMENTS
}

/** 争议里的「对方」：查看者是发起人时显示被诉方，反之显示发起人。 */
export function disputeCounterpart(
  dispute: { initiator: DisputeUserSummary; respondent: DisputeUserSummary },
  viewerId: string,
): DisputeUserSummary {
  return dispute.initiator.id === viewerId ? dispute.respondent : dispute.initiator
}

/** 查看者在这条争议里的角色（详情页展示「你是发起人 / 你是被诉方」）。 */
export function disputeViewerRole(
  dispute: DisputeActionSubject,
  viewerId: string,
): 'initiator' | 'respondent' {
  return isDisputeInitiator(dispute, viewerId) ? 'initiator' : 'respondent'
}

/**
 * 争议相关操作失败的用户可见文案，按 `ApiError.code` 给固定文案。
 *
 * **不透传服务端 `message`**：那是给排查用的，既可能泄露内部信息、也不保证是中文。
 * `null` 覆盖非 `ApiError`（网络层失败 / 契约解析失败），统一给「稍后再试」。
 */
export function disputeFailureText(code: string | null): string {
  switch (code) {
    case 'DISPUTE_TRANSACTION_NOT_FOUND':
      return '订单不存在，或你不是这笔交易的买卖双方'
    case 'DISPUTE_NOT_FOUND':
      return '争议不存在，或你无权查看'
    case 'DISPUTE_MESSAGE_NOT_FOUND':
      return '这条消息不属于本交易的会话，无法作为证据'
    case 'DISPUTE_CONFLICT':
      return '争议状态刚发生变化，请刷新后再试'
    case 'DISPUTE_WINDOW_CLOSED':
      return `交易结束已超过 ${DISPUTE_WINDOW_DAYS} 天，无法再发起争议`
    case 'DISPUTE_ATTACHMENT_LIMIT':
      return `最多上传 ${MAX_DISPUTE_ATTACHMENTS} 张图片`
    case 'DISPUTE_ATTACHMENT_INVALID':
      return '图片校验失败，请重新选择后上传'
    case 'DISPUTE_NOT_PENDING':
      return '争议已处理或已撤回，不能再补充材料'
    case 'VALIDATION_FAILED':
      return '填写的内容不合法，请检查后重试'
    case 'UNAUTHENTICATED':
      return '登录已过期，请重新登录'
    default:
      return '操作失败，请稍后再试'
  }
}

/** 列表 / 页头的编号截断：`dsp_01J8ZQ3XK7M2` → `dsp_01J8…K7M2`。 */
export function shortDisputeId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 9)}…${id.slice(-4)}`
}

/** 证据 / 候选消息的单行预览：SYSTEM 正文是交易事件 JSON，复用会话页的中文映射。 */
export function disputeMessagePreview(message: {
  type: string
  content: string
  recalledAt: string | null
}): string {
  if (message.recalledAt !== null) return '（消息已撤回）'
  if (message.type === 'SYSTEM') {
    const text = systemMessageText(message.content)
    // 证据投影（`disputes` 服务）直接读 messages 行，没走 `projectSystemContent`：
    // 历史 `tx.accepted` 正文可能带裸 UUID，解析不了中文事件。此时不把协议 JSON
    // 当用户文案展示（正文仍是「已接受的交易」这个事实），后端投影问题另行上报。
    return text.startsWith('{') ? '系统消息（交易状态更新）' : text
  }
  if (message.type === 'MEDIA') return '[图片或视频]'
  if (message.type === 'LISTING') return '[商品卡片]'
  return message.content.trim() === '' ? '（无文字内容）' : message.content
}
