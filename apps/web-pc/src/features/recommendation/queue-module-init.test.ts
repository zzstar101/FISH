import { describe, expect, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 「模块加载**不**丢没有身份标记的队列」（#323 R1 复审第 6 轮审查 F1 的回归）。
 *
 * 这个文件单独存在，是因为它必须在**导入 `queue.ts` 之前**把 `localStorage` 预置成
 * 「有事件、没有身份标记」，而模块缓存决定了一个测试文件里只能验证一次加载行为。
 *
 * 背景：早先版本在模块顶层调用 `dropUnattributableQueue()`，认为那一刻队列里的事件只可能来自
 * 旧版本客户端。实际上 `loadMe` 只在成功 / 401 时写标记，**非 401 失败（离线 / 5xx）整段会话
 * 都不写标记** —— 于是本客户端自己攒的离线事件会在下次启动时被这条规则整批删掉。
 * 现在改为「身份不明 → 只入队不投递」，队列原样保留，等身份解析出来再定归属。
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

// 预置「身份未知的队列」：有事件、**没有**身份标记（VIEWER_STORAGE_KEY 不存在）
const queued = [legacyEvent(), legacyEvent()]
localStorageStub.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queued))

await import('./queue')

describe('队列模块加载', () => {
  test('导入时不丢没有身份标记的队列，也不替用户写标记', () => {
    // 模块加载只读不写：事件留着（等身份解析出来再决定归属），标记仍缺（身份仍未解析）。
    expect(localStorageStub.getItem(VIEWER_STORAGE_KEY)).toBeNull()
    const raw = localStorageStub.getItem(QUEUE_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(
      (JSON.parse(raw ?? '[]') as RecommendationEventInput[]).map((item) => item.eventId),
    ).toEqual(queued.map((item) => item.eventId))
  })
})
