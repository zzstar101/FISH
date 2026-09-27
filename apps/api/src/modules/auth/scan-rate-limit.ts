/**
 * 建票端点的进程内限流（#197）。
 *
 * 为什么只做这一个端点、且只做进程内：扫码建票是**唯一「匿名且会消耗上游额度」**的入口
 * （微信 `getwxacunlimit` 限 5000 次/分钟，而任何人都能匿名调它）。为它引一套全局限流
 * 基础设施不划算。
 *
 * 局限写在明处：进程内计数在**多实例**部署下不准（每个实例各算一份）。当前是单实例拓扑
 * （同 `jobs` 表的取舍），将来扩多实例要换成共享存储。
 */
export const SCAN_TICKET_RATE_LIMIT = 10
export const SCAN_TICKET_RATE_WINDOW_MS = 60_000

/** 超过这么多不同 key 时顺手清一次，避免攻击者用海量 IP 把 Map 撑爆。 */
const SWEEP_THRESHOLD = 1000

export function createScanTicketRateLimiter(
  deps: { limit?: number; windowMs?: number; now?: () => number } = {},
) {
  const limit = deps.limit ?? SCAN_TICKET_RATE_LIMIT
  const windowMs = deps.windowMs ?? SCAN_TICKET_RATE_WINDOW_MS
  const now = deps.now ?? (() => Date.now())
  /** key → 窗口内的命中时刻（升序）。 */
  const hits = new Map<string, number[]>()

  function sweep(cutoff: number): void {
    for (const [key, times] of hits) {
      const kept = times.filter((time) => time > cutoff)
      if (kept.length === 0) hits.delete(key)
      else hits.set(key, kept)
    }
  }

  return {
    /** `true` = 放行；`false` = 超限。key 用服务端解析出的客户端标识（IP）。 */
    take(key: string): boolean {
      const at = now()
      const cutoff = at - windowMs
      if (hits.size > SWEEP_THRESHOLD) sweep(cutoff)

      const recent = (hits.get(key) ?? []).filter((time) => time > cutoff)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return false
      }
      recent.push(at)
      hits.set(key, recent)
      return true
    },
  }
}

export type ScanTicketRateLimiter = ReturnType<typeof createScanTicketRateLimiter>
