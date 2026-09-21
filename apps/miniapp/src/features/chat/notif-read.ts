/**
 * 通知「逐条已读」的纯逻辑：结果归并与演示兜底口径。
 *
 * 单独放一个不依赖 Taro 运行时的模块，是为了能被 `bun test` 直接覆盖 ——
 * 这里的分支（部分成功 / 真实错误 / 后端不可达的演示兜底）是「谁被标成已读」的
 * 唯一裁决处，写错了会静默改变服务端数据或把红点错误熄灭。
 */

/**
 * 从两种失败形状里取可读文案：`Error.message`，或 `Taro.request` 失败时的
 * `{ errMsg: 'request:fail …' }`（reject 的**不是 `Error`**，见
 * `pages/listing-detail/index.tsx` 的同款处理）。
 */
export function failureText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String((error as { errMsg?: unknown } | null)?.errMsg ?? error)
}

/** `ApiError` 的形状判据（不 import `lib/request`：本模块要能被 `bun test` 直接加载） */
function isApiErrorShape(error: unknown): boolean {
  const shaped = error as { name?: unknown; code?: unknown } | null
  return !!shaped && shaped.name === 'ApiError' && typeof shaped.code === 'string'
}

/**
 * 后端不可达（本地没起 / 网络不通 / 超时）—— 演示兜底只对这种失败成立。
 *
 * 两种形状都要认：Taro 的网络失败 reject 的**不是 `Error`**，而是
 * `{ errMsg: 'request:fail …' }`（见 `pages/listing-detail/index.tsx` 的同款判据）；
 * 超时在部分平台 / 版本的文案是中文（「超时」），一并识别。
 * 结构化接口错误（`ApiError`，4xx/5xx）一律**不算**不可达 —— 它的文案来自服务端，
 * 里面出现 `timeout` / `network` 也不代表「没连上」。
 */
export function isNetworkFailure(error: unknown): boolean {
  if (isApiErrorShape(error)) return false
  return /request:fail|network|timeout|超时/i.test(failureText(error))
}

/** 归并结果：`ok` = 标记成功的 id；`firstError` = 首个失败原因（全成功时为 `null`） */
export type MarkReadOutcome = {
  ok: Set<string>
  firstError: unknown
  /** 演示兜底这次是否真的生效（日志据此说「有没有回退」，不靠猜） */
  demoFallbackApplied: boolean
}

/**
 * 归并 `POST /notifications/:id/read` 的逐条结果。
 *
 * `demoFallback`（演示 / 开发构建）只在**整批都因后端不可达而失败**时生效，
 * 按演示口径视为全部已读 —— 未读态本来就是本地演示数据，本地没起后端时
 * 逐条失败是预期。只要有真实成功、或失败不是「不可达」（401 / 404 / 5xx 等
 * 真实错误），都按真实结果返回，不把「接口坏了」说成「已经读过了」。
 */
export function mergeMarkReadResults(
  ids: string[],
  results: PromiseSettledResult<void>[],
  demoFallback: boolean,
): MarkReadOutcome {
  const ok = new Set<string>()
  let firstError: unknown = null
  ids.forEach((id, index) => {
    const result = results[index]
    if (result?.status === 'fulfilled') {
      ok.add(id)
    } else if (result?.status === 'rejected' && firstError === null) {
      firstError = result.reason
    }
  })
  // 「整批都不可达」是逐条判的，不看 firstError：混合批次（有的超时、有的 401）
  // 走兜底就会把真实失败的那几条也标成已读
  const allUnreachable =
    results.length > 0 &&
    results.every((result) => result.status === 'rejected' && isNetworkFailure(result.reason))
  if (demoFallback && ok.size === 0 && allUnreachable) {
    return { ok: new Set(ids), firstError, demoFallbackApplied: true }
  }
  return { ok, firstError, demoFallbackApplied: false }
}
