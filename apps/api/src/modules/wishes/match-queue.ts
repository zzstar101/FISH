/**
 * 愿望 → 匹配的解耦层（Issue #7 设计方案 §5）。
 * matching 模块与 worker 归 Dev A；本模块只投递事件。
 * Dev A 提供稳定投递接口（如 enqueueWishMatch(wishId)）后，替换 defaultWishMatchQueue 即可。
 */
export interface WishMatchQueue {
  enqueue(wishId: string): Promise<void>
}

export function createNoopWishMatchQueue(): WishMatchQueue {
  return {
    async enqueue(wishId: string) {
      console.log(`[wishes] match job not enqueued (noop queue, waiting for #2 jobs): ${wishId}`)
    },
  }
}
