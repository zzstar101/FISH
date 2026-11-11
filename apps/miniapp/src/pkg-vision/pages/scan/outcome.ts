/**
 * 扫一扫的**结果分派**（纯逻辑，可单测）。相机识码与相册识码走同一个函数（#583）。
 *
 * 扫一扫**只认交易码**：`parseMeetupQrPayload` 做形状 gate —— 只有鱼小应的交易码
 * （`fish://meetup/redeem?tx=…&t=…`）放行去面交页核销；其余一律落「这不是鱼小应的交易码」。
 * 过期 / 已用 / 权限等业务校验归后端与面交页 —— 这里不解析 transactionId / token / expiry。
 *
 * ```text
 * rawValue === null（相册图里没解出二维码） → 'no-qr'
 * 不是交易码                                  → 'invalid'
 * 是交易码                                    → navigateTo meetup?code=<rawValue>
 * ```
 */
import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'

/** 「扫码没成功」面板的两种原因（Owner 拍板：只留这两条） */
export type ScanFailure = 'invalid' | 'no-qr'

export type ScanOutcome = { kind: 'meetup'; url: string } | { kind: 'failure'; reason: ScanFailure }

/** 面交页（交易码在那里消费：解析出 `{ transactionId, token }` 后 redeem） */
const MEETUP_PAGE = '/pkg-trade/pages/transaction-meetup/index'

export function scanOutcome(rawValue: string | null): ScanOutcome {
  if (rawValue === null) return { kind: 'failure', reason: 'no-qr' }
  // 解析兜底（#536）：解析器本身已是全量函数，但扫码回调没有外层 try/catch，
  // 这里仍按防御口径兜住 —— 任何解析异常都必须落「无效」面板，不得静默中断回调。
  let matched = false
  try {
    matched = parseMeetupQrPayload(rawValue) !== null
  } catch {
    matched = false
  }
  if (!matched) return { kind: 'failure', reason: 'invalid' }
  return { kind: 'meetup', url: `${MEETUP_PAGE}?code=${encodeURIComponent(rawValue)}` }
}

/**
 * 现在能不能处理一条新的扫码结果（相机识码与相册识码共用这一个闸门）。
 *
 * 四条闸的来由：
 * - `processing`：上一枚码已经发起导航 / 已弹面板，`onScanCode` 对准期间会连续触发；
 * - `busy`：相册识码、拍照上传在途；
 * - `failureShown`：「扫码没成功」面板正显示，用户得先处理它；
 * - `codeOpen`：「输入交易码」浮层开着。浮层只是**盖在**相机上，`Camera` 仍在识别
 *   （#674 审查 P2）—— 不挡的话，用户在输码 / 成功屏上顺手把镜头对准对方的码，
 *   就会被 `navigateTo` 拽到面交页，正在输入的码当场丢了。
 */
export function scanBlockedBy(input: {
  codeOpen: boolean
  processing: boolean
  busy: boolean
  failureShown: boolean
}): boolean {
  return input.codeOpen || input.processing || input.busy || input.failureShown
}
