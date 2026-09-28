import { describe, expect, mock, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 「模块加载**不**丢没有身份标记的队列」（#323 R1 复审第 6 轮审查 F1 的回归）。
 *
 * 这个文件单独存在，是因为它必须在**导入 `queue.ts` 之前**把存储预置成「有事件、没有身份标记」，
 * 而模块缓存决定了一个测试文件里只能验证一次加载行为。
 *
 * 背景：早先版本在模块顶层调用 `dropUnattributableQueue()`，认为那一刻队列里的事件只可能来自
 * 旧版本客户端。实际上 `bootstrapAuth` 的 catch 分支**对任何错误都广播未登录**、`/me` 只在
 * 成功 / 401 时才写标记 —— 于是本客户端自己攒的离线事件会在下次冷启动时被这条规则整批删掉。
 * 现在改为「身份不明 → 只入队不投递」，队列原样保留，等身份解析出来再定归属。
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

// 预置「身份未知的队列」：有事件、**没有**身份标记（VIEWER_KEY 不存在）
const queued = [legacyEvent(), legacyEvent()]
store.set(QUEUE_KEY, queued)

await import('../src/features/recommendation/queue')

describe('队列模块加载', () => {
  test('导入时不丢没有身份标记的队列，也不替用户写标记', () => {
    // 模块加载只读不写：事件留着（等身份解析出来再决定归属），标记仍缺（身份仍未解析）
    expect(store.get(VIEWER_KEY)).toBeUndefined()
    const raw = store.get(QUEUE_KEY)
    expect(Array.isArray(raw)).toBe(true)
    expect((raw as RecommendationEventInput[]).map((item) => item.eventId)).toEqual(
      queued.map((item) => item.eventId),
    )
  })
})
