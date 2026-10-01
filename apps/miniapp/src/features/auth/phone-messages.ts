/**
 * 手机号绑定失败 → 用户可见提示（Taro-free，可单测）。
 *
 * 与 `login-messages.ts` 同一拆分理由：这段映射是**唯一**决定用户看到什么话的地方，
 * 内联在页面 `catch` 里就没有测试覆盖；而 `@/lib/request` 的 `isApiError` 依赖
 * `@tarojs/taro`，在这里 import 会让单测跑不起来。调用方负责把异常收窄成
 * `{ code, message }` 或 `null`。
 */

/** 绑定失败的契约错误（`ApiError` 里本流程用得上的两个字段）。 */
export interface PhoneBindFailure {
  code: string
  message: string
}

/**
 * @param failure `isApiError(error)` 为真时传 `{ code, message }`，否则传 `null`。
 */
export function phoneBindFailureMessage(failure: PhoneBindFailure | null): string {
  if (failure === null) {
    // 非 ApiError：请求没到后端（超时 / 断网 / 小程序层拒绝）。与后端故障不是一回事，
    // 但对用户是同一句「稍后再试」。
    return '手机号绑定失败，请稍后重试'
  }
  switch (failure.code) {
    // 422：上游判定这枚 code 不可用（无效 / 过期 / 已用）。用户要做的**不是**等，
    // 而是再点一次授权拿新 code —— 文案必须给出这个动作。
    case 'PHONE_CODE_INVALID':
      return '手机号授权已失效，请重新授权'
    // 502：平台侧故障（凭证失效 / 超时 / 上游 5xx / 频控 / 能力未开通）。重试同一枚
    // code 无意义，只能等 —— 与上面那句必须区分开，否则用户会反复点同一个必然失败的按钮。
    case 'PHONE_UPSTREAM_UNAVAILABLE':
      return '手机号服务暂时不可用，请稍后再试'
    // 503：后端 `WECHAT_TRANSPORT=off`，能力未开通（与 502 的上游故障不是一回事）。
    case 'WECHAT_DISABLED':
      return '手机号绑定暂未开通'
    // 409：号码已被其他账号占用。换号或联系客服，重试无用。
    case 'PHONE_ALREADY_BOUND':
      return '该手机号已绑定其他账号'
    case 'UNAUTHENTICATED':
      return '登录已过期，请重新登录'
    default:
      // 其余码（VALIDATION_FAILED 等）后端 message 已经是可读中文，透传。
      return failure.message
  }
}
