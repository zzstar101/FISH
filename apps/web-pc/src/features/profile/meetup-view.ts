/**
 * 面交凭证面板的纯逻辑：核销输入分类 + 错误码文案。
 *
 * 抽出来是因为 web-pc **没有 jsdom**（组件只做 `renderToStaticMarkup` 静态渲染），
 * 交互分支一律放纯函数里测。
 */

import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import type { MeetupTokenStatus, TransactionDto } from '@fish/contracts/transactions/schema'
import { ApiError } from '../../lib/api-client'

export const MEETUP_CODE_LENGTH = 6

export type RedeemInput =
  | { kind: 'code'; code: string }
  | { kind: 'qr'; token: string }
  /** 载荷是本应用的，但指向**另一笔**交易 —— 与「码是错的」不是一回事，文案要分开。 */
  | { kind: 'wrongTransaction' }
  | { kind: 'invalid' }

/**
 * 核销输入分类。
 *
 * PC 买家没有摄像头，所以同一个输入框同时接受 6 位码与对方转来的
 * `fish://meetup/redeem?...` 载荷（真机扫码在小程序侧）。两者都不像就走「无效码」，
 * 不猜测、不静默丢弃。
 */
export function classifyRedeemInput(raw: string, transactionId: string): RedeemInput {
  const value = raw.trim()
  if (new RegExp(`^\\d{${MEETUP_CODE_LENGTH}}$`).test(value)) return { kind: 'code', code: value }
  const payload = parseMeetupQrPayload(value)
  if (payload === null) return { kind: 'invalid' }
  if (payload.transactionId !== transactionId) return { kind: 'wrongTransaction' }
  return { kind: 'qr', token: payload.token }
}

export type MeetupFailure = {
  message: string
  /**
   * 服务端状态可能已经变了：页面必须重新读，而不是把失败当结论留在原地。
   *
   * 没有单独的「终态」标志：终态由订单页的 `status` 决定（`PENDING_MEETUP` 之外
   * 根本不挂载本面板），再加一个只被测试读取的信号是死代码。
   */
  refresh: boolean
}

const NO_REFRESH: Omit<MeetupFailure, 'message'> = { refresh: false }

/**
 * 卖家取码失败。
 *
 * `POST /transactions/:id/meetup-token` 是幂等「确保并读取」：同一笔交易恒定同一枚码，
 * 重复取码不清失败计数以外的任何东西，所以这里的失败都指向「这笔交易当前不该有码」。
 */
export function meetupIssueFailure(error: unknown): MeetupFailure {
  if (error instanceof ApiError) {
    if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
      return { message: '这笔交易已不是待面交状态，正在刷新', refresh: true }
    }
    if (error.code === 'MEETUP_TOKEN_NOT_ALLOWED') {
      return { message: '只有交易的卖家可以出示交易码', ...NO_REFRESH }
    }
    // 取码路径不抛 MEETUP_TOKEN_NOT_FOUND（那是核销与状态查询的码）：参与者/存在性
    // 失败在这里是 404 TRANSACTION_NOT_FOUND，终态是 409（service.ts 的
    // `loadPendingTxForMeetup`）。原先把 404 写成 MEETUP_TOKEN_NOT_FOUND 的分支不可达。
    if (error.code === 'TRANSACTION_NOT_FOUND') {
      return { message: '这笔交易不存在或当前账号无权查看，正在刷新', refresh: true }
    }
    return { message: error.message, ...NO_REFRESH }
  }
  return { message: '交易码获取失败，请重试', ...NO_REFRESH }
}

/** 核销失败。文案逐码对应，不折叠成一句「核销失败」（否则用户无从判断该怎么办）。 */
export function meetupRedeemFailure(error: unknown): MeetupFailure {
  if (error instanceof ApiError) {
    if (error.code === 'MEETUP_TOKEN_INVALID') {
      return {
        message: '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。',
        ...NO_REFRESH,
      }
    }
    if (error.code === 'MEETUP_TOKEN_CONSUMED') {
      return { message: '这个交易码已被使用，不能重复核销。', refresh: true }
    }
    if (error.code === 'MEETUP_TOKEN_LOCKED') {
      return {
        message: '错误次数过多，已临时锁定。请让对方重新打开一次「交易码」页面，再试同一枚码。',
        ...NO_REFRESH,
      }
    }
    if (error.code === 'MEETUP_TOKEN_NOT_FOUND') {
      return { message: '对方还没有出示本单的交易码。', ...NO_REFRESH }
    }
    if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
      return { message: '这笔交易已不是待面交状态，正在刷新', refresh: true }
    }
    if (error.code === 'MEETUP_TOKEN_NOT_ALLOWED') {
      return { message: '这是你自己出示的交易码，需要对方来核销。', ...NO_REFRESH }
    }
    return { message: error.message, ...NO_REFRESH }
  }
  return { message: '核销失败，请检查网络后重试。', ...NO_REFRESH }
}

/** 输入本身的错误（还没发出请求就拦下）。 */
export function redeemInputMessage(input: RedeemInput): string | null {
  if (input.kind === 'invalid') {
    return `请输入对方的 ${MEETUP_CODE_LENGTH} 位交易码，或粘贴对方转来的交易码链接。`
  }
  if (input.kind === 'wrongTransaction') return '这枚交易码属于另一笔订单，请核对后重试。'
  return null
}

const STATUS_LABEL: Record<MeetupTokenStatus, string> = {
  NONE: '尚未取码',
  ISSUED: '已出示，等待对方核销',
  CONSUMED: '已核销',
}

export function meetupStatusLabel(status: MeetupTokenStatus): string {
  return STATUS_LABEL[status]
}

/**
 * 交易里「我这一侧」是否已经确认过面交。
 *
 * 卖家的确认**由核销本身盖上**：服务端在核销成功那一个事务里写 `seller_confirmed_at`
 * —— 契约原话是「展示码即卖家对面交的同意」（`transactions/store.ts` 的 `consumeMeetup`
 * 注释）。所以核销之后卖家不该再被要求点一次「确认完成面交」，那时剩下的只有买家那一侧；
 * 反过来若买家先单侧确认过，核销就是第二侧确认事件，交易当场 COMPLETED。
 */
export function hasConfirmedOwnSide(
  transaction: Pick<TransactionDto, 'role' | 'buyerConfirmedAt' | 'sellerConfirmedAt'>,
): boolean {
  return transaction.role === 'buyer'
    ? transaction.buyerConfirmedAt !== null
    : transaction.sellerConfirmedAt !== null
}
