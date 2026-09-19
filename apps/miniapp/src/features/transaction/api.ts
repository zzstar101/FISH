/**
 * 交易域 API（#114 与 #70 的联调层）。
 *
 * `/transactions` 整条挂在 `requireAuth` 之下，必须登录。面交码（meetup token）
 * 的路径常量与响应形状都冻结在 `@fish/contracts/transactions`：
 * - 签发是**卖家**的端点（明文码与 qrPayload 只在 201 响应出现一次）；
 * - 核销是**买家**的端点（redeem 出示 QR token / verify-code 出示 6 位码），
 *   成功响应的 `nextAction` 固定为 `CONFIRM_DELIVERY` —— 由客户端接着调 confirm；
 * - 扫码页交付的 QR 原文由契约包 `meetup-qr` 解析（transactionId + token），
 *   meetup 页据此调 redeem；6 位码只在面交页输入，走 verify-code。
 */

import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import {
  type MeetupTokenResponse,
  type MeetupTokenStatusResponse,
  type MeetupVerificationResponse,
  meetupTokenResponseSchema,
  meetupTokenStatusResponseSchema,
  meetupVerificationResponseSchema,
  type TransactionDto,
  transactionDtoSchema,
} from '@fish/contracts/transactions/schema'
import { apiRequest } from '@/lib/request'

export async function fetchTransaction(id: string): Promise<TransactionDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.detail(id))
  return transactionDtoSchema.parse(payload)
}

/** 卖家签发/刷新面交码（重复调用即刷新：旧码立即作废）。 */
export async function issueMeetupToken(id: string): Promise<MeetupTokenResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.issueMeetupToken(id), { method: 'POST' })
  return meetupTokenResponseSchema.parse(payload)
}

/** 当前面交凭证状态（无明文；NONE 表示还没有签发过）。 */
export async function fetchMeetupTokenStatus(id: string): Promise<MeetupTokenStatusResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.meetupTokenStatus(id))
  return meetupTokenStatusResponseSchema.parse(payload)
}

/** 买家出示二维码核销（qrToken 是 payload `t` 参数的原始 token）。 */
export async function redeemMeetupToken(
  id: string,
  qrToken: string,
): Promise<MeetupVerificationResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.redeemMeetupToken(id), {
    method: 'POST',
    body: { qrToken },
  })
  return meetupVerificationResponseSchema.parse(payload)
}

/** 买家手动输入 6 位码核销。 */
export async function verifyMeetupCode(
  id: string,
  code: string,
): Promise<MeetupVerificationResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.verifyMeetupCode(id), {
    method: 'POST',
    body: { code },
  })
  return meetupVerificationResponseSchema.parse(payload)
}

/** 双方确认面交（核销成功后的 nextAction；幂等，第二侧确认触发 COMPLETED + 商品 SOLD）。 */
export async function confirmTransaction(id: string): Promise<TransactionDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.confirm(id), { method: 'POST' })
  return transactionDtoSchema.parse(payload)
}
