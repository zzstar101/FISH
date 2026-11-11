/**
 * 交易码核销链路（#674）：`POST /transactions/:id/meetup-token/verify-code` → 按响应
 * `nextAction` 收尾。相机页浮层的提交走这里；面交页因为要和代次锁、核验动效、
 * confirm 失败重试交织，仍自行串联这两步 —— 但两边调的是**同一对客户端函数**（`./api`）
 * 与同一份错误分派（`./meetup-code`），不存在第二份接口调用。
 *
 * 与 `./meetup-code` 分开：那边是纯函数（单测直接 import），这边要碰网络客户端。
 */
import type {
  MeetupVerificationResponse,
  TransactionDto,
} from '@fish/contracts/transactions/schema'
import { isApiError } from '@/lib/request'
import { confirmTransaction, verifyMeetupCode } from './api'

/**
 * 核销成功后的 `nextAction` → 收尾动作。契约目前只有 `CONFIRM_DELIVERY`（确认面交，幂等）。
 * 用 `Record` 而不是 `if`：契约加值时编译期就会拦住，不会静默少做一步。
 */
const AFTER_VERIFY: Record<
  MeetupVerificationResponse['nextAction'],
  (transactionId: string) => Promise<TransactionDto>
> = {
  CONFIRM_DELIVERY: (transactionId) => confirmTransaction(transactionId),
}

/**
 * 一次核销的分阶段结果。
 *
 * 为什么要分阶段：`verify-code` 通过那一刻**码就已经用掉了**（服务端置 CONSUMED），后面
 * `confirm` 失败再笼统报「核销失败」，用户拿着这枚已失效的码重试只会得到
 * 「这个交易码已被使用」。所以 confirm 阶段失败必须作为**数据**返回，让调用点给出
 * 「重试确认」的出口，而不是混进核销错误里（审查 P1）。
 *
 * `verify` 阶段的失败仍按原样抛错：那是真的没核销成功，错误码由调用点用
 * `./meetup-code` 的 `meetupRedeemFailure` 分派。
 */
export type MeetupConsumeResult =
  /** 码被接受且 `nextAction` 已收尾成功：拿到收尾后的交易（已可判终态） */
  | { kind: 'confirmed'; transaction: TransactionDto }
  /** 码已核销，但收尾的 confirm 失败：`apiCode` 交给 `classifyConfirmFailure` 分派 */
  | { kind: 'confirm-failed'; apiCode: string | null }

/** 核销一枚 6 位交易码，并按 `nextAction` 收尾；返回分阶段结果。 */
export async function consumeMeetupCode(
  transactionId: string,
  code: string,
): Promise<MeetupConsumeResult> {
  const verified = await verifyMeetupCode(transactionId, code)
  try {
    const transaction = await AFTER_VERIFY[verified.nextAction](transactionId)
    return { kind: 'confirmed', transaction }
  } catch (error) {
    // 走到这里码一定已经 CONSUMED：这是「确认面交」那一步没成，不是核销失败
    return { kind: 'confirm-failed', apiCode: isApiError(error) ? error.code : null }
  }
}
