import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 埋点队列的冲刷循环（#323 R1 review 应修项 P1，与
 * `apps/web-pc/src/features/recommendation/queue.test.ts` 同族）。
 *
 * 要拦住的缺陷：写回本地存储失败时，队列内容一个字都没变 —— `for (;;)` 下一轮读到同一批，
 * 再 POST 一次，再写失败……循环永不退出，`flushRecommendationQueue()` 的 promise 永不
 * settle，之后所有入队与定时器都吊在这个死 promise 上。
 *
 * 为什么用 `mock.module`：`queue.ts` 必须 `import Taro`，而 Bun 下加载真 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`（手法同 `tests/signature.test.ts`）。这里用内存 Map
 * 顶替同步存储，并让写入按需失败 —— 失败开关本身就是这个用例的输入。
 */
const QUEUE_KEY = 'fish.recommendation.queue'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

const store = new Map<string, unknown>()
let throwOnWrite = false

function throwStorageWriteFailed(): never {
  throw new Error('storage write failed')
}

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => store.get(key) ?? '',
    setStorageSync: (key: string, data: unknown) => {
      if (throwOnWrite) throwStorageWriteFailed()
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      if (throwOnWrite) throwStorageWriteFailed()
      store.delete(key)
    },
    onAppShow: () => undefined,
    onNetworkStatusChange: () => undefined,
  },
}))

type PostCall = { events: RecommendationEventInput[] }

let calls: PostCall[] = []
/** 模拟网络异常 / 非 2xx：投递失败时这一批必须整体保留 */
let failPost = false

/**
 * 投递次数上限：**只为让「修复前」的无限循环变成断言失败**。
 * 没有它，那个循环每次都会立刻 resolve，测试不是变红而是把测试进程转死。
 */
const MAX_POST_CALLS = 5

mock.module('../src/features/recommendation/api', () => ({
  postRecommendationEvents: async (events: RecommendationEventInput[]) => {
    if (failPost) throw new Error('network down')
    calls.push({ events })
    if (calls.length > MAX_POST_CALLS) throw new Error('post called too many times')
  },
}))

const { flushRecommendationQueue, enqueueRecommendationEvent, syncRecommendationViewer } =
  await import('../src/features/recommendation/queue')

function event(): RecommendationEventInput {
  return {
    eventId: crypto.randomUUID(),
    listingId: LISTING_ID,
    eventType: 'DETAIL_VIEW',
    anonymousSessionId: crypto.randomUUID(),
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 直接写存储（绕过被顶替的 Taro），模拟「上一次成功落盘的队列」 */
function seedQueue(events: RecommendationEventInput[]): void {
  store.set(QUEUE_KEY, events)
}

function queuedEvents(): RecommendationEventInput[] {
  const raw = store.get(QUEUE_KEY)
  return Array.isArray(raw) ? (raw as RecommendationEventInput[]) : []
}

function eventIds(call: PostCall | undefined): string[] {
  return (call?.events ?? []).map((item) => item.eventId)
}

/** 跑一段会触发 `console.warn` 的逻辑，但不把告警打到测试输出里 */
async function withoutWarnings(run: () => Promise<void>): Promise<void> {
  const original = console.warn
  console.warn = () => undefined
  try {
    await run()
  } finally {
    console.warn = original
  }
}

beforeEach(() => {
  store.clear()
  calls = []
  failPost = false
  throwOnWrite = false
  // 模块级身份跨用例存活，必须显式重置：`null` = 已建立「未登录」身份。
  // 身份标记是冲刷的前置条件（身份未知时事件留在队列里不投递），这里先把闸门打开。
  syncRecommendationViewer(null)
})

describe('flushRecommendationQueue', () => {
  test('写回失败时不会无限重发同一批，且 flush 一定 settle', async () => {
    const seeded = [event(), event(), event()]
    seedQueue(seeded)
    throwOnWrite = true

    await withoutWarnings(() => flushRecommendationQueue())

    // 只投递一轮：写回失败后必须退出循环，而不是把同一批再 POST 下去
    expect(calls).toHaveLength(1)
    expect(calls[0]?.events).toHaveLength(3)
    // 事件留在本地，下次（写成功时）连原 eventId 一起补发
    expect(queuedEvents().map((item) => item.eventId)).toEqual(seeded.map((item) => item.eventId))
  })

  test('存储恢复正常后，积压的事件照原 eventId 补发并出队', async () => {
    const seeded = [event(), event()]
    seedQueue(seeded)
    throwOnWrite = true
    await withoutWarnings(() => flushRecommendationQueue())

    throwOnWrite = false
    await flushRecommendationQueue()

    expect(eventIds(calls[1])).toEqual(seeded.map((item) => item.eventId))
    expect(queuedEvents()).toEqual([])
  })

  test('成功后按 eventId 出队，超过单批上限时继续分批', async () => {
    const seeded = Array.from({ length: 51 }, () => event())
    seedQueue(seeded)

    await flushRecommendationQueue()

    expect(calls.map((call) => call.events.length)).toEqual([50, 1])
    expect(queuedEvents()).toEqual([])
  })

  test('投递失败时整批保留，重试沿用同一个 eventId', async () => {
    const queued = event()
    seedQueue([queued])
    failPost = true

    await flushRecommendationQueue()

    expect(calls).toHaveLength(0)
    expect(queuedEvents().map((item) => item.eventId)).toEqual([queued.eventId])

    failPost = false
    await flushRecommendationQueue()

    expect(eventIds(calls[0])).toEqual([queued.eventId])
    expect(queuedEvents()).toEqual([])
  })

  test('本地队列里不合契约的事件被丢弃，不会连带同批合法事件', async () => {
    const valid = event()
    seedQueue([
      {
        eventId: 'not-a-uuid',
        listingId: LISTING_ID,
        eventType: 'DETAIL_VIEW',
      } as RecommendationEventInput,
      valid,
    ])

    await withoutWarnings(() => flushRecommendationQueue())

    expect(eventIds(calls[0])).toEqual([valid.eventId])
    expect(queuedEvents()).toEqual([])
  })
})

describe('enqueueRecommendationEvent', () => {
  test('队列上限 500 条，超出丢最旧的', async () => {
    // 让投递失败，队列才会留在本地供断言
    failPost = true
    const seeded = Array.from({ length: 500 }, () => event())
    seedQueue(seeded)
    const oldest = seeded[0]?.eventId

    enqueueRecommendationEvent(event())

    const queued = queuedEvents()
    expect(queued).toHaveLength(500)
    expect(queued.some((item) => item.eventId === oldest)).toBe(false)

    await flushRecommendationQueue()
  })
})
