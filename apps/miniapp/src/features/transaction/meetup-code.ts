/**
 * 6 位交易码的**共享口径**（#674）：格式校验 + 后端错误码分派，纯函数、不碰网络。
 *
 * 相机页「输入交易码」浮层（`pkg-vision/pages/scan`）与面交页
 * （`pkg-trade/pages/transaction-meetup`）核销的是同一枚码，服务端也只有一条接口：
 * `POST /transactions/:id/meetup-token/verify-code`（`apps/api/src/modules/transactions/router.ts:234-249`）。
 * 所以**格式校验、后端错误码 → 行内文案**一律取这里，页面里不再各写一份字面量 ——
 * 两处文案一旦分叉，同一笔交易就会出现两种说法。核销链路本身见 `./meetup-verify`。
 */

/** 交易码位数（与后端 `meetupTokenVerifyCodeInputSchema` 的 6 位一致） */
export const MEETUP_CODE_LEN = 6

/** 只留数字并截到 6 位：整串粘贴、输入法带进来的空格与分隔符都在这里归一。 */
export function normalizeMeetupCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, MEETUP_CODE_LEN)
}

/** 提交前的格式校验：合法返回 `null`，否则给行内文案（位数不足、混入非数字都算错）。 */
export function meetupCodeInputError(raw: string): string | null {
  if (normalizeMeetupCode(raw).length === MEETUP_CODE_LEN) return null
  return '交易码是 6 位数字，请输满 6 位。'
}

/**
 * 核销失败的三种落点。分派规则与面交页 `verify` 的 catch 完全一致：
 * 终态要重读交易并撤下核销入口、出示方自核销只是「暂不展示」，其余统一进行内文案。
 */
export type MeetupRedeemFailure =
  /** 交易已离开「待面交」（已完成 / 已取消，409 `TRANSACTION_NOT_IN_PENDING`） */
  | { kind: 'terminal' }
  /** 出示方（卖家）不能核销自己出示的码（403 `MEETUP_TOKEN_NOT_ALLOWED`） */
  | { kind: 'not-allowed' }
  /** 码错 / 已用 / 锁定 / 对方未出码 / 兜底：直接展示这句 */
  | { kind: 'message'; message: string }

/** 没有任何错误码可归因（断网、非错误信封）时的兜底，两处共用这一句 */
export const MEETUP_REDEEM_FALLBACK = '核销失败，请检查网络后重试。'

/** 后端错误码 → 行内文案（四类，逐一对齐 router 的 verify-code 错误） */
const REDEEM_MESSAGES: Record<string, string> = {
  MEETUP_TOKEN_INVALID: '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。',
  MEETUP_TOKEN_CONSUMED: '这个交易码已被使用，不能重复核销。',
  MEETUP_TOKEN_LOCKED:
    '错误次数过多，已临时锁定。请让对方重新打开一次「交易码」页面，再试同一枚码。',
  MEETUP_TOKEN_NOT_FOUND: '对方还没有出示本单的交易码。',
}

/** 核销失败分派（`apiCode === null` = 抛错里没有错误码）。 */
export function meetupRedeemFailure(apiCode: string | null): MeetupRedeemFailure {
  if (apiCode === 'TRANSACTION_NOT_IN_PENDING') return { kind: 'terminal' }
  if (apiCode === 'MEETUP_TOKEN_NOT_ALLOWED') return { kind: 'not-allowed' }
  const message = apiCode === null ? undefined : REDEEM_MESSAGES[apiCode]
  return { kind: 'message', message: message ?? MEETUP_REDEEM_FALLBACK }
}
