/**
 * 「按住说话」录音期反馈的纯逻辑（#535）。
 *
 * 从页面里抽出来单独放，是因为这三件事都要在真机上才对，但判断本身是纯函数：
 * 上滑取消的阈值、已录秒数、计时文案。页面只负责把它们接到 state 与触摸事件上。
 */

/**
 * 手指上滑超过这个距离（逻辑 px）进入「松开取消」态。
 *
 * 60px ≈ 微信语音的手感：太小学生误触取消，太大在矮屏上够不到。
 */
export const VOICE_CANCEL_DISTANCE_PX = 60

/**
 * 是否进入取消态。约定「上滑为负」：`deltaY = 当前 Y - 起始 Y`。
 * 非有限数（触点丢失）一律不取消 —— 宁可发送也不静默丢弃用户刚录的一段。
 */
export function isVoiceCancelArmed(deltaY: number): boolean {
  if (!Number.isFinite(deltaY)) return false
  return deltaY <= -VOICE_CANCEL_DISTANCE_PX
}

/**
 * 已录秒数（向下取整）。
 * 起点无效（页面还没起录）或时间倒退一律按 0 处理，不让面板显示负数或 NaN。
 */
export function voiceElapsedSeconds(startedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0 || !Number.isFinite(nowMs)) return 0
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
}

/**
 * 录制面板的计时文案 `mm:ss`。
 *
 * 录音上限是 `MEDIA_MAX_VOICE_DURATION_MS`（分钟级），分钟不做进位保护以外的事：
 * 非法输入收敛成 `00:00`，避免面板出现 `NaN:NaN`。
 */
export function voiceRecordingClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const mm = String(Math.floor(safe / 60)).padStart(2, '0')
  const ss = String(safe % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
