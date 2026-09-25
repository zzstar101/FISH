/** 扫码状态轮询的起步间隔。 */
export const SCAN_POLL_INITIAL_DELAY_MS = 1_000

/** 扫码状态轮询的最大间隔：1s → 2s → 3s，之后保持 3s。 */
export const SCAN_POLL_MAX_DELAY_MS = 3_000

/** `attempt = 0` 返回首次轮询间隔，后续按 2 倍退避并在 3s 封顶。 */
export function nextScanPollDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error('attempt 必须是非负整数')
  }
  return Math.min(SCAN_POLL_INITIAL_DELAY_MS * 2 ** attempt, SCAN_POLL_MAX_DELAY_MS)
}
