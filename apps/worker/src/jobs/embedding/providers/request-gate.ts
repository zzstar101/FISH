/** Backfill/live 验证专用 admission；每个 HTTP attempt 消耗额度，不攒突发 credit。 */
export function createEmbeddingRequestGate(options: {
  requestsPerSecond: number
  maxRequests?: number
  now?: () => number
  sleep?: (ms: number) => Promise<unknown>
}) {
  if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
    throw new Error('requestsPerSecond 必须为有限正数')
  }
  if (
    options.maxRequests !== undefined &&
    (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)
  ) {
    throw new Error('maxRequests 必须为正安全整数')
  }
  const now = options.now ?? (() => performance.now())
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const intervalMs = 1000 / options.requestsPerSecond
  let lastStart: number | null = null
  let requests = 0
  let tail: Promise<void> = Promise.resolve()

  return {
    get requests() {
      return requests
    },
    beforeRequest(): Promise<void> {
      // 串行化 admission（不是串行化网络请求），并发调用和重试共用同一条时钟。
      // 按实际 admission 时间更新 lastStart，避免 event loop 延迟后积攒的预约一起突发。
      const admitted = tail.then(async () => {
        if (options.maxRequests !== undefined && requests >= options.maxRequests) {
          throw new Error(`embedding HTTP request budget exhausted (${options.maxRequests})`)
        }
        if (lastStart !== null) {
          let delay = lastStart + intervalMs - now()
          while (delay > 0) {
            await sleep(delay)
            delay = lastStart + intervalMs - now()
          }
        }
        lastStart = now()
        requests += 1
      })
      // 拒绝某个请求后仍保持队列可用；已耗尽的预算不会因此重置。
      tail = admitted.catch(() => {})
      return admitted
    },
  }
}
