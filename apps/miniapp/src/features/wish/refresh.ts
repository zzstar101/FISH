/**
 * 「我的愿望」需要重拉的跨页信号。
 *
 * 为什么需要它：许愿页是 Tab 页，发布页（`pages/wish-publish`）发布成功后
 * `navigateBack` 回来时**不会重新挂载**，不重拉就看不到刚发的愿望。
 * 但 Tab 页每次切回来都无条件重拉会产生 `2 + N` 个请求（N = ACTIVE 且
 * `matchCount > 0` 的愿望数，最多 10），而绝大多数切换并没有任何写操作 ——
 * 本仓其它 Tab 页（消息 / 我的）也都只在登录态变化时取数，不按显示刷新。
 *
 * 所以只由**写操作**置位：发布成功 `markWishesDirty()`，许愿页每次显示时
 * `consumeWishesDirty()` 消费一次。关闭愿望不走这里 —— 它在许愿页内完成后直接重拉。
 *
 * 纯内存标记，不做持久化：重进小程序后愿望页本来就会重新挂载取数。
 */
let dirty = false

/** 置位：下一次许愿页显示时重拉。 */
export function markWishesDirty(): void {
  dirty = true
}

/** 消费标记：返回是否需要重拉，并把标记清掉（只触发一次）。 */
export function consumeWishesDirty(): boolean {
  const next = dirty
  dirty = false
  return next
}
