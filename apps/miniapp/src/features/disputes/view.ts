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

/** 这笔交易上「我可见的争议」，按是不是本人发起分开（列表接口同时返回我发起 + 我被诉）。 */
export type DisputeEntryExisting = {
  mine: DisputeRef | null
  other: DisputeRef | null
}

/**
 * 订单详情页的争议入口。
 *
 * 后端只拦「**同一发起人**在同一交易上的第二条 PENDING」——部分唯一索引
 * `packages/db/src/schema/disputes.ts` 的 `disputes_pending_transaction_initiator_uq`
 * 建在 `(transaction_id, initiator_id) where status='PENDING'` 上，注释写得很明确：
 * 终态（RESOLVED / WITHDRAWN）行不占该约束，所以「被驳回 / 撤回后可以重新发起」天然成立；
 * `apps/api/src/modules/disputes/store.ts` 的 `findPendingDisputeId` + `ON CONFLICT … WHERE
 * status='PENDING'` 是同一口径。也就是说：对方有 PENDING **不阻碍**本人发起，双方可以各自持有一条。
 *
 * 因此入口矩阵（单测逐条覆盖）：
 * 1. 本人 PENDING → `view`（撤回 / 补材料都在详情里）；
 * 2. 本人无 PENDING 且窗口开放 → `file`（可发起；本人有终态争议时同时给「查看这条争议」，
 *    对方有可见争议时同时给「查看对方争议」）；
 * 3. 本人无 PENDING 且窗口关闭 → 有可见争议就 `view`（只读回看），否则 `closed`；
 * 4. 本人仅有终态争议且窗口开放 → `file`（可重新发起，`refileFrom` 指向那条终态争议）。
 *
 * 窗口是唯一门禁：`DISPUTE_WINDOW_DAYS = 30`，终态交易从 `completedAt ?? cancelledAt` 起算，
 * `PENDING_MEETUP` 不限（与 `apps/api/src/modules/disputes/service.ts` 的 `isWindowClosed` 同公式）。
 */
export type DisputeEntry =
  | { kind: 'view'; dispute: DisputeRef }
  | { kind: 'file'; refileFrom: DisputeRef | null; other: DisputeRef | null }
  | { kind: 'closed' }

export function disputeEntryOf(
  tx: DisputeWindowTransaction,
  existing: DisputeEntryExisting | null,
  nowMs: number,
): DisputeEntry {
  const mine = existing?.mine ?? null
  const other = existing?.other ?? null
  // 1) 本人未决：主卡是「查看」（撤回 / 补材料都在详情里）
  if (mine !== null && mine.status === 'PENDING') return { kind: 'view', dispute: mine }
  // 2) 窗口开放：本人还能发起（包括本人已有终态争议、对方已有争议的情况）
  if (!disputeWindowClosed(tx, nowMs)) return { kind: 'file', refileFrom: mine, other }
  // 3) 窗口关闭：不能发起，但可见的争议仍可回看（优先本人那条）
  if (mine !== null) return { kind: 'view', dispute: mine }
  if (other !== null) return { kind: 'view', dispute: other }
  return { kind: 'closed' }
}

/**
 * 入口卡旁边的次要入口：「发起」与「查看已有争议」可以同时存在。
 *
 * 只给**一条**：本人终态争议优先（`refileFrom`），否则对方那条。两条同时存在时把两个
 * 「查看」并排摆会让入口区变成操作面板，也分不清该点哪个 —— 页面注释同样写明这一点。
 */
export type DisputeSecondaryEntry = { dispute: DisputeRef; label: string }

export function disputeSecondaryOf(entry: DisputeEntry): DisputeSecondaryEntry | null {
  if (entry.kind !== 'file') return null
  if (entry.refileFrom !== null) return { dispute: entry.refileFrom, label: '查看这条争议' }
  if (entry.other !== null) return { dispute: entry.other, label: '查看对方争议' }
  return null
}

/** 「补附件」按钮文案：额度用完时直接写清楚，避免用户点了才被 422 挡下。 */
export function attachmentActionLabel(attachmentCount: number): string {
  return attachmentSlotsLeft(attachmentCount) > 0 ? '补附件' : '附件已满（6 张）'
}

export type DisputeEntryCopy = {
  title: string
  sub: string
  /** 右侧动作词；`off` 时它是一句不可点的说明 */
  act: string
  /** true = 只读提示，整行不可点 */
  off: boolean
}

/**
 * 订单页争议入口卡的全部文案。三种形态在这里穷尽（`switch` 对联合类型收敛），
 * 页面只负责摆版式；窗口判定仍然只在 `disputeEntryOf` 里做一次。
 *
 * `file` 分两句：本人已有终态争议时说「重新发起」（后端允许），否则是普通发起。
 */
export function disputeEntryCopyOf(entry: DisputeEntry): DisputeEntryCopy {
  switch (entry.kind) {
    case 'view':
      return {
        title: '这笔交易有一条争议',
        sub: '查看处理进度与材料',
        act: '查看争议',
        off: false,
      }
    case 'file':
      if (entry.refileFrom !== null) {
        return {
          title: '之前的争议已结束',
          sub: '问题仍未解决？可以重新发起争议',
          act: '重新发起',
          off: false,
        }
      }
      return {
        title: '交易出了问题？',
        sub: '发起争议，由管理员介入核查，结论为最终结论',
        act: '发起争议',
        off: false,
      }
    case 'closed':
      return {
        title: '交易结束已超过 30 天',
        sub: '无法再发起争议；如仍有纠纷，请联系客服处理',
        act: '不可发起',
        off: true,
      }
  }
}

/**
 * 证据里那条消息的正文：已撤回的消息只剩撤回碑，不能把撤回前的正文再摆出来
 * （服务端撤回后 `content` 可能仍保留原文，契约允许 `recalledAt` 与正文同时存在）。
 */
export function evidenceMessageText(message: {
  content: string
  recalledAt: string | null
}): string {
  return message.recalledAt === null ? message.content : '消息已撤回'
}

/**
 * 静默刷新失败（409 重同步、回前台签名过期重读）时的取舍：手上已有详情就不要切到错误屏。
 *
 * 这类刷新是「补一次」，用户并没有主动重试；断网时把已经读到的详情换成「加载失败」，
 * 等于把一个能看的内容页砸掉。非静默（用户点重试/首次进入）或还没有内容时才落错误态。
 */
export function keepDetailOnSilentFailure(silent: boolean, hasDetail: boolean): boolean {
  return silent && hasDetail
}

/** 详情页按场景给不同的「查不到」文案：非参与人 404 不能写成系统故障。 */
export function disputeNotFoundCopy(scene: 'detail' | 'create'): {
  title: string
  text: string
} {
  if (scene === 'create') {
    return { title: '无法发起争议', text: '这笔交易不存在，或你不是交易参与人。' }
  }
  // 争议没有删除端点，所以只剩一种原因：不是参与人（服务端对非参与人返回 404，不泄漏存在性）
  return { title: '看不到这条争议', text: '你不是这笔交易的参与人，看不到这条争议。' }
}
