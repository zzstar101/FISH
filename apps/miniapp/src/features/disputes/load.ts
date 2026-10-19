/**
 * 争议域取数包装（#497）。
 *
 * ## 口径：先试真实接口，失败就落错误态
 *
 * 与举报（`features/reports/load.ts`）不同，争议**没有演示数据**：拿 fixture 顶替会凭空造出
 * 「管理员已处理」的结论，所以失败一律 `failed`，页面给重试按钮。
 */
import type { MessageDto } from '@fish/contracts/chat/schema'
import type { DisputeDetail } from '@fish/contracts/disputes/schema'
import { fetchMessagePage } from '@/features/chat/api'
import { reportFailure } from '@/features/load-failure'
import { fetchTransaction } from '@/features/transaction/api'
import { isApiError } from '@/lib/request'
import { fetchDisputeDetail, fetchMyDisputePage } from './api'
import { type DisputeRecord, disputeToRecord } from './map'
import type { DisputeRef } from './view'

/** 订单详情页找「这笔交易有没有我的争议」时最多翻的页数（5 × 20 = 100 条）。 */
const MY_DISPUTES_MAX_SCAN_PAGES = 5

export type DisputePageLoad = {
  items: DisputeRecord[]
  nextCursor: string | null
  failed: boolean
}

/**
 * 一页「我的争议」（我发起的 + 我被诉的，服务端按时间倒序）。
 *
 * 交给列表页自己累计 —— 它是触底加载，不是一次拉齐：cursor 由页面的 `nextCursor` 状态持有，
 * 这里只负责把一页翻译成行 + 把失败收成 `failed`。
 */
export async function loadDisputePage(
  cursor: string | undefined,
  viewerId: string | null,
  nowMs: number = Date.now(),
): Promise<DisputePageLoad> {
  try {
    const parsed = await fetchMyDisputePage(cursor)
    return {
      items: parsed.items.map((dispute) => disputeToRecord(dispute, viewerId, nowMs)),
      nextCursor: parsed.nextCursor,
      failed: false,
    }
  } catch (error) {
    reportFailure('我的争议读取', error, false)
    return { items: [], nextCursor: null, failed: true }
  }
}

export type DisputeDetailLoad =
  | { state: 'ok'; detail: DisputeDetail }
  | { state: 'notFound' }
  | { state: 'failed' }

/**
 * 详情。404（含「非参与人」与「不存在」两种服务端语义）单独返回 `notFound`，
 * 页面据此给「看不到这条争议」的友好提示，而不是「加载失败 + 重试」。
 */
export async function loadDisputeDetail(disputeId: string): Promise<DisputeDetailLoad> {
  try {
    return { state: 'ok', detail: await fetchDisputeDetail(disputeId) }
  } catch (error) {
    if (isApiError(error) && (error.code === 'DISPUTE_NOT_FOUND' || error.status === 404)) {
      return { state: 'notFound' }
    }
    reportFailure('争议详情读取', error, false)
    return { state: 'failed' }
  }
}

export type DisputeEntryLoad = {
  mine: DisputeRef | null
  other: DisputeRef | null
  /** 请求失败：入口按「不确定」处理（不显示入口，也不谎称可发起） */
  failed: boolean
}

/**
 * 这笔交易上「我可见的争议」—— 订单详情页的入口依据。
 *
 * 契约没有「按交易查争议」的端点，所以从 `/disputes/mine` 翻页找（命中通常在前几页）。
 * 该接口同时返回「我发起的」与「我被诉的」，按 `initiator.id === viewerId` 分成 mine / other：
 * 入口矩阵要区分二者（后端的唯一约束只管同一发起人的未决争议，对方有争议不阻碍本人发起）。
 *
 * 本人 PENDING 命中即可收工；否则继续翻，既为了「终态之后又开了一条未决」不漏，也为了把
 * 对方那条可见争议捞出来给「查看对方争议」入口（列表按时间倒序，先到的就是最新的）。
 */
export async function findDisputeForTransaction(
  transactionId: string,
  viewerId: string | null,
): Promise<DisputeEntryLoad> {
  let mine: DisputeRef | null = null
  let other: DisputeRef | null = null
  try {
    let cursor: string | undefined
    for (let page = 0; page < MY_DISPUTES_MAX_SCAN_PAGES; page += 1) {
      const parsed = await fetchMyDisputePage(cursor)
      for (const dispute of parsed.items) {
        if (dispute.transaction.id !== transactionId) continue
        const ref: DisputeRef = { id: dispute.id, status: dispute.status }
        if (viewerId !== null && dispute.initiator.id === viewerId) {
          if (dispute.status === 'PENDING') return { mine: ref, other, failed: false }
          mine ??= ref
        } else {
          other ??= ref
        }
      }
      const next = parsed.nextCursor
      if (next === null || next === cursor) return { mine, other, failed: false }
      cursor = next
    }
    return { mine, other, failed: false }
  } catch (error) {
    reportFailure('订单争议入口读取', error, false)
    return { mine: null, other: null, failed: true }
  }
}

/** 详情页选证据前要的会话 id（争议 DTO 刻意不含会话 id，只投影单条消息）。 */
export async function loadDisputeConversationId(transactionId: string): Promise<string | null> {
  try {
    const transaction = await fetchTransaction(transactionId)
    return transaction.conversationId
  } catch (error) {
    reportFailure('争议关联会话读取', error, false)
    return null
  }
}

export type EvidenceCandidatesLoad = {
  messages: MessageDto[]
  /** `null` = 已经翻到最早一页；否则原样作为下一次 `before` 回传（契约要求不解析游标）。 */
  nextCursor: string | null
  failed: boolean
}

/**
 * 可关联为证据的候选消息：该交易会话的一页消息（升序返回，页面倒序展示）。
 *
 * 第一页就是最近的消息；`before` 传上一页的 `nextCursor` 可以继续「加载更早」（#497 审查 N9）。
 * 页面只把其中**文字 / 系统**消息列为候选 —— 契约的证据消息本身没有媒体地址，聊天图片
 * 证据待 #500（媒体消息读接口当前不返回地址）。
 */
export async function loadEvidenceCandidates(
  conversationId: string,
  before?: string,
): Promise<EvidenceCandidatesLoad> {
  try {
    const page = await fetchMessagePage(conversationId, before)
    return { messages: page.items, nextCursor: page.nextCursor, failed: false }
  } catch (error) {
    reportFailure('争议证据候选读取', error, false)
    return { messages: [], nextCursor: null, failed: true }
  }
}
