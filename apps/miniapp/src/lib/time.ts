/**
 * 时间文案的公共部分。
 *
 * 为什么单独抽出来：会话列表（`pages/chat/list-view.ts`）与会话页
 * （`pages/conversation/view.ts`）都要「按本地日历日」判断今天 / 昨天，
 * 两处各写一遍必然漂移（一处用日历日、一处用 24 小时差，就会出现 23:00 的消息
 * 在次日 01:00 被叫「今天」）。
 */

/** 星期几的中文单字，下标与 `Date.getDay()` 对齐（0 = 周日） */
export const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 本地日历日序号。
 *
 * 必须按**本地日历日**算，不能用「距今多少小时 / 24」：否则 23:00 的消息在次日
 * 01:00 只差 2 小时，会被算成「今天」，而用户认知里已经是昨天。
 */
export function localDayIndex(ms: number): number {
  const date = new Date(ms)
  return Math.floor((ms - date.getTimezoneOffset() * 60_000) / 86_400_000)
}

/** 气泡下方的时间戳：HH:mm */
export function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 「多久以前」的相对时间：`刚刚` / `12 分钟前` / `3 小时前` / `昨天` / `2 天前`。
 *
 * 与 `conversationTimeLabel` 的分工：那个是**会话列表**的粗粒度文案（一周内只说到「周X」），
 * 这里是「等了多久」这种需要精确到分钟的场景（我的发布的待确认行）。两者共用同一个
 * `nowMs` 约定。
 *
 * ⚠️ `pages/chat/index.tsx` 里还有一个**私有**的 `relativeTime(iso)`，它自己取
 * `Date.now()`、且把「不足 1 分钟」的分钟数钳到 1（`Math.max(1, …)`）。两者目前并存，
 * 没有同源——本函数是给「一屏多行、必须共用同一个现在」的场景用的。
 *
 * `nowMs` 由调用方传入：否则没法测，而且同一屏里各取一次「现在」会算出矛盾结果。
 * 未来时间戳（两端时钟偏差）夹到 0，走「刚刚」，不出现「-3 分钟前」。
 */
export function relativeTimeOf(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.max(0, (nowMs - then) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = localDayIndex(nowMs) - localDayIndex(then)
  if (days <= 1) return '昨天'
  return `${days} 天前`
}

/**
 * 日期分隔条文案：`今天 12:00` / `昨天 09:30` / `9 月 14 日 20:15`。
 *
 * `nowMs` 由调用方传入：否则没法测，而且同一屏里各取一次「现在」会算出矛盾结果。
 */
export function dayLabelOf(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const time = clockTime(iso)
  const days = localDayIndex(nowMs) - localDayIndex(then)
  if (days <= 0) return `今天 ${time}`
  if (days === 1) return `昨天 ${time}`
  const date = new Date(then)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}
