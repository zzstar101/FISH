/**
 * 识图失败 → 用户可见提示（Taro-free，可单测）。
 *
 * 为什么单独一个模块：这段映射是**唯一**决定用户看到什么话的地方，而它在页面的 `catch` 里
 * 写就没人能钉住。抽出来才能在不拉起 Taro runtime 的前提下覆盖契约的 5 个错误码
 * （`packages/contracts/src/visual/schema.ts` 的 `VISUAL_SEARCH_ERROR_CODES`）。
 *
 * 调用方负责把异常收窄成 `{ code, message, retryAfterSeconds }`：`@/lib/request` 的
 * `isApiError` 依赖 `@tarojs/taro`，在这里 import 会让测试跑不起来
 * （同 `features/auth/login-messages.ts` / `features/upload/mime.ts` 的拆分理由）。
 */

/** 识图失败的契约错误（`ApiError` 里本页用得上的字段）。 */
export interface VisualSearchFailure {
  code: string
  message: string
  /** 429 的结构化剩余秒数（`packages/contracts/src/system/error.ts`） */
  retryAfterSeconds?: number
}

/**
 * 契约错误码 → 文案。
 *
 * `VISUAL_SEARCH_NO_EMBEDDING` 是**数据没就绪**（回填还没跑过，服务端 503 与"确实没有相似
 * 商品"刻意分开，见 `apps/api/src/modules/visual-search/service.ts:274`），所以文案说"还在准备"
 * 而不是"没找到同款" —— 后者会把运维问题说成商品问题。
 */
const ERROR_COPY: Record<string, string> = {
  VISUAL_SEARCH_IMAGE_INVALID: '这张图没法用来搜索，重新拍一张试试',
  VISUAL_SEARCH_IMAGE_TOO_LARGE: '图片超过大小上限，换一张小一点的试试',
  VISUAL_SEARCH_PROVIDER_UNAVAILABLE: '识图服务暂时不可用，请稍后重试',
  VISUAL_SEARCH_RATE_LIMITED: '识图请求太频繁，请稍后再试',
  VISUAL_SEARCH_NO_EMBEDDING: '识图数据还在准备中，请稍后再试',
}

/**
 * @param failure `isApiError(error)` 为真时传 `{ code, message, retryAfterSeconds }`，否则传 `null`。
 */
export function visualSearchFailureMessage(failure: VisualSearchFailure | null): string {
  if (failure === null) {
    // 抛出来的不是 Error（理论上不会走到）：没有可透传的文案，给一个中性提示
    return '识图失败，请稍后重试'
  }
  const copy = ERROR_COPY[failure.code]
  if (copy === undefined) return failure.message
  // 429：服务端已给出剩余秒数，说清楚用户才知道要等多久（否则只能盲试）
  if (failure.code === 'VISUAL_SEARCH_RATE_LIMITED' && failure.retryAfterSeconds !== undefined) {
    return `识图请求太频繁，请 ${failure.retryAfterSeconds} 秒后再试`
  }
  return copy
}
