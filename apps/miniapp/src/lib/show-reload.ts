/**
 * 「切回本页时还要不要再拉一次」的统一判据。
 *
 * ## 为什么需要
 *
 * 订单 / 纠纷这类列表页都写成「`useDidShow` 里无条件重拉」：用户点进某一单、看一眼、
 * 返回，页面就又走一遍完整请求（订单页还要游标翻页把整份列表取全）。而这一来一回
 * 往往只有几秒，服务端不可能给出不同的东西 —— 用户为此付的代价是转圈、卡顿、偶尔
 * 还会看到列表闪一下。
 *
 * 这里把「多久之内算刚拉过」抽成一个可测的纯函数，各页在 `useDidShow` 里问它一次：
 * 刚拉过就**静默跳过这一次重拉**。下拉刷新、首次进页、错误态重试都不经过这条判据，
 * 用户主动要新数据时永远真的去拉。
 *
 * 命名注意：本仓各页自己的 `view.ts` 里还有一批 `shouldRefreshOnShow` /
 * `shouldReloadOnShow`（入参是 `{ firstShow, authed, userId }` 之类），它们回答的是
 * **另一个问题**（这次 show 该不该管、身份对不对得上）。这里只回答「刚拉过吗」，
 * 所以叫 `isRecentlyLoaded`，不与那些同名。
 *
 * ## 为什么是 30 秒
 *
 * 判据只影响「回到本页」这一个动作，而真实的写入都发生在子页面里（面交核销、撤回投诉、
 * 补材料）—— 用户走完那一趟再回来，通常已超过 30 秒，会照常拉；真的在 30 秒内往返
 * （点错面、看错单），跳过重拉的代价只是「列表晚 30 秒才反映变化」，而它在下次进入
 * 或下拉刷新时立刻就会更新。这条窗可以是常量而不是配置：它不需要按页面调，
 * 调小了等于没优化，调大了才开始让用户等数据。
 */
export const SHOW_RELOAD_MIN_INTERVAL_MS = 30_000

/**
 * 距 `lastLoadedAt`（**最近一次成功加载**的时刻，`0` = 本次进页还没成功过）是不是
 * 还没到 `minIntervalMs`。
 *
 * - 从来没成功加载过 → `false`（首次进页、上次失败，都该真拉一次）；
 * - 距上次成功不足窗口 → `true`（刚拉过，跳过）；
 * - 刚好到点 → `false`（窗口是「至少隔这么久」而不是「不超过这么久」）；
 * - 时钟被回拨（`lastLoadedAt` 在未来）→ `false`：算不出隔了多久时宁可拉一次。
 *
 * 只认**成功**的依据是：失败的那次什么都没拿到，把它当成「刚拉过」会让用户在错误态里
 * 反复进出却一直看不到重试。
 */
export function isRecentlyLoaded(
  lastLoadedAt: number,
  nowMs: number,
  minIntervalMs: number = SHOW_RELOAD_MIN_INTERVAL_MS,
): boolean {
  if (!(lastLoadedAt > 0)) return false
  const elapsed = nowMs - lastLoadedAt
  if (elapsed < 0) return false
  return elapsed < minIntervalMs
}
