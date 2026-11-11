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

/** 核销一枚 6 位交易码，并按 `nextAction` 收尾；返回收尾后的交易（已可判终态）。 */
export async function consumeMeetupCode(
  transactionId: string,
  code: string,
): Promise<TransactionDto> {
  const verified = await verifyMeetupCode(transactionId, code)
  return AFTER_VERIFY[verified.nextAction](transactionId)
}
