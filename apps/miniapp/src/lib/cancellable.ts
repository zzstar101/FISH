/**
 * 把一次异步取数包成「可取消」：`cancel()` 之后，迟到的结果一律按 `null` 丢弃。
 *
 * ## 为什么需要它
 *
 * 页面 effect 会因登录态变化（换账号 / 退出）而重跑，但**上一轮的请求已经发出去了**。
 * 只在响应侧比对「响应里的 user.id === 发请求时的 user.id」**不够**：那只证明响应属于
 * 发请求时的那个用户，不能证明现在登录的还是同一个人 —— A 的响应在 B 登录之后回来时，
 * 上面那条同样成立，于是 B 会短暂看到 A 的昵称、商品、愿望与统计（#105 的 P1）。
 *
 * 唯一可靠的做法是**由生命周期显式取消**：effect 重跑 / 卸载时 `cancel()`，
 * 旧响应即使到达也不会再写状态。
 *
 * ## 用法
 *
 * ```ts
 * useEffect(() => {
 *   setData(null)
 *   if (!ready) return
 *   const load = cancellable(() => fetchData(), (next) => next !== null && next.ownerId === id)
 *   void load.promise.then((next) => { if (next) setData(next) })
 *   return load.cancel
 * }, [id, ready])
 * ```
 */

export type Cancellable<T> = {
  /** 结果：被取消或 `accept` 不通过时为 `null` */
  promise: Promise<T | null>
  /** 取消：之后到达的结果一律丢弃。可直接作为 effect 的 cleanup 返回 */
  cancel: () => void
  /** 是否已取消（便于测试与调试） */
  isCancelled: () => boolean
}

/**
 * @param load 真正发请求的函数
 * @param accept 结果是否可接受（例如「响应里的用户就是当前用户」）
 */
export function cancellable<T>(
  load: () => Promise<T>,
  accept: (value: T) => boolean,
): Cancellable<T> {
  let cancelled = false
  const promise = load().then((value) => (cancelled || !accept(value) ? null : value))
  return {
    promise,
    cancel: () => {
      cancelled = true
    },
    isCancelled: () => cancelled,
  }
}
