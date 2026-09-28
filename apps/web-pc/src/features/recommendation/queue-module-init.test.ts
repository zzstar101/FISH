import { describe, expect, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 「模块加载时丢弃身份不明的遗留队列」（#323 R1 复审 blocker 的兜底）。
 *
 * 这个文件单独存在，是因为它必须在**导入 `queue.ts` 之前**把 `localStorage` 预置成
 * 「有事件、没有身份标记」，而模块缓存决定了一个测试文件里只能验证一次加载行为。
 * 它是整份身份归属设计里唯一「不在函数调用里」的动作：没有这个文件，把 `queue.ts`
 * 顶层那行 `dropUnattributableQueue()` 删掉不会有任何用例变红（其余用例都是显式调用）。
 */
const QUEUE_STORAGE_KEY = 'fish.recommendation.queue'
const VIEWER_STORAGE_KEY = 'fish.recommendation.viewer'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

function createStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    getItem(key) {
      return entries.get(key) ?? null
    },
    key(index) {
      return [...entries.keys()][index] ?? null
    },
    removeItem(key) {
      entries.delete(key)
    },
    setItem(key, value) {
      entries.set(key, value)
    },
  }
}

const localStorageStub = createStorage()
// 队列只依赖 `window.localStorage`；这里给一个最小可用的 window（手法同 `queue.test.ts`）。
Object.assign(globalThis, {
  window: { localStorage: localStorageStub, sessionStorage: createStorage() },
})

function legacyEvent(): RecommendationEventInput {
  return {
    eventId: crypto.randomUUID(),
    listingId: LISTING_ID,
    eventType: 'DETAIL_VIEW',
    anonymousSessionId: crypto.randomUUID(),
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
}

// 预置「旧版本客户端留下的队列」：有事件、**没有**身份标记（VIEWER_STORAGE_KEY 不存在）
localStorageStub.setItem(QUEUE_STORAGE_KEY, JSON.stringify([legacyEvent(), legacyEvent()]))

await import('./queue')

describe('队列模块加载', () => {
  test('导入时丢弃没有身份标记的遗留队列', () => {
    expect(localStorageStub.getItem(VIEWER_STORAGE_KEY)).toBeNull()
    expect(localStorageStub.getItem(QUEUE_STORAGE_KEY)).toBeNull()
  })
})
