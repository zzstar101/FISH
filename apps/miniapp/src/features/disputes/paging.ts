/**
 * 「我的争议」触底加载的两个小守卫（纯函数，#497 审查）。
 *
 * 竞态形态：用户往下拉 → 请求在途 → 返回本页触发 `useDidShow` 的重读（刷新第一页）→
 * 旧请求这才回来。旧实现会在完成回调里无条件清 `loadingMoreRef` 并追加第二页，
 * 既可能把上一份快照的行拼进新列表（重复 id），也会把**别人**（刷新后新一轮加载）
 * 持有的锁提前放掉，于是两次触底能发出两个请求。
 *
 * 这里只回答两个问题：这次响应还算不算数、追加时怎么去重；页面负责持锁与发请求。
 */

export type DisputeLoadMoreRequest = { epoch: number; token: symbol }

export type DisputeLoadMoreState = {
  epoch: number
  lock: DisputeLoadMoreRequest | null
}

/**
 * 响应回来时是否还能落地：期间没刷新/换号（epoch 未变），且锁仍由本次请求持有。
 * 任一条不满足就整段丢弃 —— 包括**不要**去清锁：那可能是刷新后新一轮加载的锁。
 */
export function canApplyLoadMore(
  request: DisputeLoadMoreRequest,
  state: DisputeLoadMoreState,
): boolean {
  return request.epoch === state.epoch && state.lock?.token === request.token
}

/**
 * 追加一页并按键去重。刷新后的第一页可能已经包含第二页的行（服务端列表按时间倒序，
 * 刷新期间新增/变更会让分页边界滑动），直接 `[...prev, ...next]` 会出现重复卡片。
 */
export function appendDisputePage<T extends { id: string }>(
  prev: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(prev.map((item) => item.id))
  return [...prev, ...incoming.filter((item) => !seen.has(item.id))]
}
