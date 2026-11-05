/**
 * 「我的争议」从子页返回时该不该重拉：一个跨页写标记 + 一道时间闸。
 *
 * ## 为什么需要
 *
 * 纠纷列表是分包页，从详情页 `navigateBack` 回来**不会重新挂载**，而详情页里能做的事
 * （撤回争议、把聊天消息加成证据）都会改变列表上的状态。可「进详情看一眼就返回」是最
 * 常见的动作，每次都完整重拉纯属白打请求。
 *
 * 于是两道判据并排放在这里，因为它们回答的是同一个问题的两半：**这次 show 要不要重拉**。
 *
 * 1. `consumeDisputesDirty()` —— 详情页里**真的改过东西**（撤回 / 加证据 / 新建争议）
 *    就置位，列表显示时先消费它；有标记则无视时间闸直接重拉，「我刚改的那条」立刻变样。
 * 2. `isRecentlyLoaded()` —— 没改过东西时看「刚拉过吗」：30 秒内就静默跳过这一次重拉。
 *
 * 两者必须分开：时间闸只看时间，看不出「你刚在这里撤回过争议」；反过来，只靠 dirty
 * 标记又会把「看一眼就回来」那次也拉一遍。
 *
 * 放在 `features/disputes/` 而不是 `lib/`：目前只有 `pkg-trade/pages/my-disputes`
 * 一个调用方（`git grep isRecentlyLoaded` 可查），按 AGENTS.md 第 4 节「第二个调用方
 * 出现前不抽公共层」，它就是争议列表自己的策略。
 *
 * 纯内存标记，不做持久化：重进小程序后列表本来就会重新挂载取数。
 */
let dirty = false

/** 置位：下一次纠纷列表显示时无视时间闸重拉。 */
export function markDisputesDirty(): void {
  dirty = true
}

/** 消费标记：返回是否需要强制重拉，并把标记清掉（只触发一次）。 */
export function consumeDisputesDirty(): boolean {
  const next = dirty
  dirty = false
  return next
}

/**
 * 丢弃标记：这次进页 / 换账号会全量读一次，标记要表达的那件事已经被覆盖掉了。
 *
 * 不丢的话它会泄漏到别的场景：置位后列表页被销毁（退回订单页再进来），首次 show 靠
 * effect 全量读已经把数据刷新过，可标记还留着 → 下一次「只看一眼就返回」被强行重拉，
 * 这道闸在这一串动作之后就失效了。换账号同理：A 账号的写不该让 B 账号多打一次请求。
 */
export function clearDisputesDirty(): void {
  dirty = false
}

/**
 * 「多久之内算刚拉过」。
 *
 * 只影响「回到本页」这一个动作，而真实的写入都发生在子页面里 —— 用户走完那一趟再回来
 * 通常已超过 30 秒，会照常拉；真的在 30 秒内往返（点错单、看错行），跳过重拉的代价只是
 * 「列表晚 30 秒才反映变化」，下次进入或下拉刷新时立刻就会更新。写操作另有 dirty 兜底。
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
 *
 * 命名注意：本仓各页自己的 `view.ts` 里还有一批 `shouldRefreshOnShow` /
 * `shouldReloadOnShow`（入参是 `{ firstShow, authed, userId }` 之类），它们回答的是
 * **另一个问题**（这次 show 该不该管、身份对不对得上）。这里只回答「刚拉过吗」。
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
