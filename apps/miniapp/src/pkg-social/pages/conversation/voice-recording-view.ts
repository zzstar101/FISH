/**
 * 「按住说话」录音期反馈的纯逻辑（#535）。
 *
 * 从页面里抽出来单独放，是因为这几件事都要在真机上才对，但判断本身是纯函数：
 * 上滑取消的阈值、已录秒数、计时文案、计时节拍、录音自停的取舍。
 * 页面只负责把它们接到 state 与触摸事件上。
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

/** 面板计时的节拍间隔（毫秒）。250ms 一跳：秒数不会跳格，也不至于每帧 setState。 */
export const VOICE_PANEL_TICK_MS = 250

export type RecordingTickerOptions = {
  /** 取当前时刻（用例注入假时钟） */
  now?: () => number
  /** 挂节拍（用例注入假调度器）；返回值原样交给 `cancel` */
  schedule?: (tick: () => void) => unknown
  /** 撤节拍 */
  cancel?: (handle: unknown) => void
}

/**
 * 录音计时节拍：每 `VOICE_PANEL_TICK_MS` 用当前时刻**重算**一次已录秒数交给 `onTick`。
 * 返回停表函数（幂等；停表之后的迟到节拍一律丢弃，面板卸载后不再 setState）。
 *
 * 秒数由「当前时刻 - 起点」算出而不是自增累加：长时间录音不会越走越慢。
 * 时钟/调度都能注入，是为了让「每次节拍真的刷新了显示」这件事能用假时钟钉住 ——
 * 只搜 `setInterval(` 的话，把节拍回调换成空函数照样能过，面板会一直停在 00:00。
 */
export function startRecordingTicker(
  onTick: (seconds: number) => void,
  options: RecordingTickerOptions = {},
): () => void {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ?? ((tick: () => void) => setInterval(tick, VOICE_PANEL_TICK_MS))
  const cancel =
    options.cancel ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const startedAt = now()
  let stopped = false
  const handle = schedule(() => {
    if (stopped) return
    onTick(voiceElapsedSeconds(startedAt, now()))
  })
  return () => {
    if (stopped) return
    stopped = true
    cancel(handle)
  }
}

/**
 * 录音器**自己停了**（没人松手）时怎么处置。
 *
 * - `cancelled`：用户已经滑到「松开 取消」，他表达的是丢弃 —— 停录一律不发；
 * - `capped=false`：被系统打断（来电 / 切后台），不该把没说完的半句发出去；
 * - `capped=true`：真录到时长上限，提示并**发送**这一整段（与微信「到时自动发送」一致，
 *   也避免用户刚录满的一分钟凭空消失）。
 *
 * 副作用全部经 `effect` 注入，是为了把「只有录满且未取消才发送」钉进行为用例：
 * 这段判定留在页面的内联分支里，只能搜源码字符串 —— 把发送挪进取消分支照样能过。
 */
export function applyVoiceAutoStop(
  input: { cancelled: boolean; capped: boolean },
  effect: { toast: (title: string) => void; send: () => void },
): void {
  if (input.cancelled) {
    effect.toast('录音已取消')
    return
  }
  if (!input.capped) {
    effect.toast('录音已中断，请重试')
    return
  }
  effect.toast('已达最长录音时长，已发送')
  effect.send()
}

/**
 * 用户松手时怎么处置这一段（#549 收口判据 2）。
 *
 * `interrupted` 是**松手这一刻**是否仍处于中断态（来电 / 视频通话把录音暂停了）：
 * - 仍在中断态：这一段音频是截断的，不能当正常语音发出去 —— 丢弃并明确告诉用户重录。
 *   静默发出去的话，对方只会听到半句话，而用户以为发的是完整的一段。
 * - 中断已经结束（或从未中断）：照常发送。**「中断发生过」不是状态** —— 拿历史标记去拦
 *   会把一次已经恢复、正常录满的录音吃掉。
 *
 * 与 `applyVoiceAutoStop` 一样，副作用全部经 `effect` 注入：发送只可能发生在「当前未处于
 * 中断态」这一支，这一点必须由行为用例钉住，而不是靠源码里搜字符串。
 */
export function applyVoiceRelease(
  input: { interrupted: boolean },
  effect: { toast: (title: string) => void; send: () => void },
): void {
  if (input.interrupted) {
    effect.toast('录音已被来电打断，请稍后再按住重录')
    return
  }
  effect.send()
}
