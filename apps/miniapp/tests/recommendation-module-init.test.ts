import { describe, expect, mock, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 「模块加载时丢弃身份不明的遗留队列」（#323 R1 复审 blocker 的兜底）。
 *
 * 这个文件单独存在，是因为它必须在**导入 `queue.ts` 之前**把存储预置成「有事件、没有身份标记」，
 * 而模块缓存决定了一个测试文件里只能验证一次加载行为。它是整份身份归属设计里唯一
 * 「不在函数调用里」的动作：没有这个文件，把 `queue.ts` 顶层那行 `dropUnattributableQueue()`
 * 删掉不会有任何用例变红（其余用例都是显式调用该函数）。
 *
 * 为什么用 `mock.module`：`queue.ts` 必须 `import Taro`，而 Bun 下加载真 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`（手法同 `tests/recommendation-queue.test.ts`）。
 */
const QUEUE_KEY = 'fish.recommendation.queue'
const VIEWER_KEY = 'fish:recommendation:viewer'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

const store = new Map<string, unknown>()

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => store.get(key) ?? '',
    setStorageSync: (key: string, data: unknown) => {
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
    onAppShow: () => undefined,
    onNetworkStatusChange: () => undefined,
  },
}))

function legacyEvent(): RecommendationEventInput {
  return {
    eventId: crypto.randomUUID(),
    listingId: LISTING_ID,
    eventType: 'DETAIL_VIEW',
    anonymousSessionId: crypto.randomUUID(),
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
}

// 预置「旧版本客户端留下的队列」：有事件、**没有**身份标记（VIEWER_KEY 不存在）
store.set(QUEUE_KEY, [legacyEvent(), legacyEvent()])

await import('../src/features/recommendation/queue')

describe('队列模块加载', () => {
  test('导入时丢弃没有身份标记的遗留队列', () => {
    expect(store.get(VIEWER_KEY)).toBeUndefined()
    expect(store.get(QUEUE_KEY)).toBeUndefined()
  })
})
