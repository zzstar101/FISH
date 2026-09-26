/**
 * 有界重试（#228 §7「有限重试，只重试明确瞬时错误」）。
 *
 * 只对 `ContentModerationError.retryable` 为真的错误重试，次数与退避都由调用方给定常数，
 * 没有「一直重试直到成功」的路径。非审核错误（例如代码 bug 抛出的 TypeError）不重试。
 */
import { ContentModerationError } from './types'

export type BoundedRetryOptions = {
  /** 总尝试次数（含首次）。 */
  attempts: number
  /** 首次退避毫秒数，之后指数翻倍。 */
  baseDelayMs: number
  /** 注入 sleep 以便测试；默认 `Bun.sleep`。 */
  sleep?: (ms: number) => Promise<void>
}

export async function withBoundedRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: BoundedRetryOptions,
): Promise<T> {
  // attempts < 1 时循环体不会执行，`throw lastError` 会抛出 undefined（不是 Error），
  // 调用方按 ContentModerationError 分支就会漏过去。这里直接拒绝这种配置。
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new RangeError('withBoundedRetry 的 attempts 必须是 ≥1 的整数')
  }
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  let lastError: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      lastError = error
      const retryable = error instanceof ContentModerationError && error.retryable
      if (!retryable || attempt >= options.attempts) throw error
      // 腾讯限频不返回可用的 Retry-After（SDK 把响应头丢掉了），固定指数退避即可。
      await sleep(options.baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw lastError
}
