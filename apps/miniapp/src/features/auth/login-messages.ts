/**
 * 微信登录失败 → 用户可见提示（Taro-free，可单测）。
 *
 * 为什么要单独一个模块：`apps/miniapp/src/pages/login/index.tsx` 里这段映射原来内联在
 * `catch` 里，没有任何测试覆盖，而它是**唯一**决定用户看到什么话的地方（学号退路已下线，
 * 提示错了用户就没有别的出口）。抽出来才能在不拉起 Taro runtime 的前提下钉住。
 *
 * 调用方负责把异常收窄成 `{ code, message }`：`@/lib/request` 的 `isApiError` 依赖
 * `@tarojs/taro`，在这里 import 会让测试跑不起来（同 `features/upload/mime.ts` 的拆分理由）。
 */

/** 登录失败的契约错误（`ApiError` 里本页用得上的两个字段）。 */
export interface WechatLoginFailure {
  code: string
  message: string
}

/**
 * @param failure `isApiError(error)` 为真时传 `{ code, message }`，否则传 `null`。
 */
export function wechatLoginFailureMessage(failure: WechatLoginFailure | null): string {
  if (failure === null) {
    // 非 ApiError：`Taro.login()` 失败（用户拒绝授权 / 开发者工具未登录）或请求没到后端。
    // 两种在这里无法区分，给一个能同时覆盖的中性提示。
    return '微信登录失败，请重试'
  }
  // 503：后端没开微信登录（`WECHAT_TRANSPORT=off`，生产未配置凭证）。
  // 学号入口已下线，所以这里**没有**「请使用学号登录」这条退路可指。
  if (failure.code === 'WECHAT_DISABLED') return '登录服务暂未开通，请稍后再试'
  // 401：code 无效 / 过期 / 已用过。重试即可（会拿一个新的 code），不是账号问题。
  if (failure.code === 'WECHAT_CODE_INVALID') return '微信授权已失效，请重试'
  return failure.message
}
