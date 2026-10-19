/**
 * 交易争议的界面判定（纯函数，不 import Taro，可在 bun 里单测）。
 *
 * 与 `features/reports/view.ts` 同一分工：这里只回答「该显示什么、能不能点」，
 * 真正的权限仍由服务端判定；这里的 false 只用于**提前隐藏**必然失败的入口。
 */

import type { Dispute, DisputeStatus } from '@fish/contracts/disputes/schema'
import { DISPUTE_WINDOW_DAYS, MAX_DISPUTE_ATTACHMENTS } from '@fish/contracts/disputes/schema'
import type { TransactionStatus } from '@fish/contracts/transactions/schema'

/** 我在这条争议里的身份；`observer` = 非参与人（服务端会直接 404，这里只用于渲染防御）。 */
export type DisputeRole = 'initiator' | 'respondent' | 'observer'

export function disputeRoleOf(
  dispute: Pick<Dispute, 'initiator' | 'respondent'>,
  viewerId: string | null,
): DisputeRole {
  if (viewerId === null) return 'observer'
  if (viewerId === dispute.initiator.id) return 'initiator'
  if (viewerId === dispute.respondent.id) return 'respondent'
  return 'observer'
}

/** 撤回：仅发起人 + 仅 PENDING（服务端同一口径，终态返回 409 `DISPUTE_NOT_PENDING`）。 */
export function canWithdrawDispute(
  dispute: Pick<Dispute, 'initiator' | 'respondent' | 'status'>,
  viewerId: string | null,
): boolean {
  return disputeRoleOf(dispute, viewerId) === 'initiator' && dispute.status === 'PENDING'
}

/** 补附件 / 加证据：仅发起人 + 仅 PENDING。被诉方全程只读（额度归发起人）。 */
export function canAddDisputeMaterial(
  dispute: Pick<Dispute, 'initiator' | 'respondent' | 'status'>,
  viewerId: string | null,
): boolean {
  return disputeRoleOf(dispute, viewerId) === 'initiator' && dispute.status === 'PENDING'
}

/** 还剩几个附件额度（0 时前端直接不打开选图，省一次必然 422 的请求）。 */
export function attachmentSlotsLeft(attachmentCount: number): number {
  return Math.max(0, MAX_DISPUTE_ATTACHMENTS - attachmentCount)
}

/** 交易里与发起窗口相关的字段（列表 DTO 与 `TransactionDto` 都有这三项）。 */
export type DisputeWindowTransaction = {
  status: TransactionStatus
  completedAt: string | null
  cancelledAt: string | null
}

/**
 * 发起窗口是否已关闭 —— 与后端 `disputes/service.ts` 的 `isWindowClosed` 同一算法：
 * 终态交易从 `completedAt ?? cancelledAt` 起算 30 天；`PENDING_MEETUP` 期间没有时限。
 * 端上算一次只为**提前隐藏入口**，服务端仍会再判（409 `DISPUTE_WINDOW_CLOSED`）。
 */
export function disputeWindowClosed(tx: DisputeWindowTransaction, nowMs: number): boolean {
  const closedAt = tx.completedAt ?? tx.cancelledAt
  if (closedAt === null) return false
  const closedMs = Date.parse(closedAt)
  if (Number.isNaN(closedMs)) return false
  return nowMs - closedMs > DISPUTE_WINDOW_DAYS * 86_400_000
}

export type DisputeRef = { id: string; status: DisputeStatus }

export type DisputeEntry =
  | { kind: 'view'; dispute: DisputeRef }
  | { kind: 'file' }
  | { kind: 'closed' }

/**
 * 订单详情页的争议入口：
 * - 这笔交易已有我可见的争议 → 查看（终态争议也能看）；
 * - 否则窗口内 → 可发起；窗口外 → 只提示不再给入口。
 */
export function disputeEntryOf(
  tx: DisputeWindowTransaction,
  existing: DisputeRef | null,
  nowMs: number,
): DisputeEntry {
  if (existing !== null) return { kind: 'view', dispute: existing }
  if (disputeWindowClosed(tx, nowMs)) return { kind: 'closed' }
  return { kind: 'file' }
}

/**
 * 从「我的争议」列表里挑出这笔交易的那条：优先未决（列表按时间倒序，先到的是最新的），
 * 没有未决就取最新一条终态。同一交易在终态后可以再发起新争议，所以可能不止一条。
 */
export function pickDisputeForTransaction<T extends DisputeRef & { transaction: { id: string } }>(
  items: readonly T[],
  transactionId: string,
): T | null {
  const matches = items.filter((item) => item.transaction.id === transactionId)
  if (matches.length === 0) return null
  return matches.find((item) => item.status === 'PENDING') ?? matches[0] ?? null
}

/** 「补附件」按钮文案：额度用完时直接写清楚，避免用户点了才被 422 挡下。 */
export function attachmentActionLabel(attachmentCount: number): string {
  return attachmentSlotsLeft(attachmentCount) > 0 ? '补附件' : '附件已满（6 张）'
}

/** 详情页按场景给不同的「查不到」文案：非参与人 404 不能写成系统故障。 */
export function disputeNotFoundCopy(scene: 'detail' | 'create'): {
  title: string
  text: string
} {
  if (scene === 'create') {
    return { title: '无法发起争议', text: '这笔交易不存在，或你不是交易参与人。' }
  }
  return { title: '看不到这条争议', text: '它可能已被删除，或你不是这笔交易的参与人。' }
}
