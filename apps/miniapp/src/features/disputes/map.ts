/**
 * 争议 DTO → 列表行（#497）。
 *
 * 与 `features/reports/map.ts` 同一分工：把契约里「列表 + 详情共用的主体」压成页面直接能画的
 * 结构，时间文案只在这里算一次（`nowMs` 由调用方传入，同一屏共用一个「现在」）。
 */
import type { Dispute, DisputeStatus, DisputeType } from '@fish/contracts/disputes/schema'
import { formatAmount } from '@/lib/money'
import { relativeTimeOf } from '@/lib/time'
import { DISPUTE_STATUS_META, DISPUTE_TYPE_META, type DisputeTone } from './meta'

export type DisputeRecord = {
  id: string
  type: DisputeType
  typeLabel: string
  status: DisputeStatus
  statusLabel: string
  tone: DisputeTone
  /** 我发起 / 我被诉 */
  roleLabel: string
  counterpartNickname: string
  listingTitle: string
  /** 千分位金额（不带 ¥，页面自己拼） */
  amountText: string
  timeLabel: string
}

/** 列表行。`viewerId` 只决定「对方是谁」与角色文案，不影响可见范围（服务端已筛过）。 */
export function disputeToRecord(
  dispute: Dispute,
  viewerId: string | null,
  nowMs: number,
): DisputeRecord {
  const isInitiator = viewerId !== null && dispute.initiator.id === viewerId
  const counterpart = isInitiator ? dispute.respondent : dispute.initiator
  const statusMeta = DISPUTE_STATUS_META[dispute.status]
  return {
    id: dispute.id,
    type: dispute.type,
    typeLabel: DISPUTE_TYPE_META[dispute.type].label,
    status: dispute.status,
    statusLabel: statusMeta.label,
    tone: statusMeta.tone,
    roleLabel: isInitiator ? '我发起' : '我被诉',
    counterpartNickname: counterpart.nickname,
    listingTitle: dispute.transaction.listingTitle,
    amountText: formatAmount(dispute.transaction.amountCents),
    timeLabel: relativeTimeOf(dispute.createdAt, nowMs),
  }
}
