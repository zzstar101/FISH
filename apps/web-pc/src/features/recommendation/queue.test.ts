import { beforeEach, describe, expect, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'
import { enqueueRecommendationEvent, flushRecommendationQueue } from './queue'

const QUEUE_STORAGE_KEY = 'fish.recommendation.queue'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

/** 模拟配额写满：置为 true 后 `setItem` 抛错，`getItem` 仍能读到已写入的内容。 */
let failWrites = false
/** 模拟静默失败：`setItem` 不抛错也不落盘（某些浏览器 / 隐私模式下的 `localStorage`）。 */
let silentWriteDrops = false

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
      if (failWrites) throw new Error('QuotaExceededError')
      if (silentWriteDrops) return
      entries.set(key, value)
    },
  }
}

const localStorageStub = createStorage()
// 队列只依赖 `window.localStorage`；这里给一个最小可用的 window，避免把测试绑到 DOM 实现上。
Object.assign(globalThis, {
  window: { localStorage: localStorageStub, sessionStorage: createStorage() },
})

type FetchCall = { url: string; events: RecommendationEventInput[] }

let calls: FetchCall[] = []
let respond: () => Promise<Response> = async () => accepted()

function accepted(): Response {
  return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: 0 }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  })
}

function rejected(status: number): Response {
  return new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'bad' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  localStorageStub.clear()
  failWrites = false
  silentWriteDrops = false
  calls = []
  respond = async () => accepted()
  Object.assign(globalThis, {
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '{"events":[]}'
      calls.push({
        url: String(_input),
        events: (JSON.parse(body) as { events: RecommendationEventInput[] }).events,
      })
      return respond()
    },
  })
})

function event(): RecommendationEventInput {
  return {
    eventId: crypto.randomUUID(),
    listingId: LISTING_ID,
    eventType: 'DETAIL_VIEW',
    anonymousSessionId: crypto.randomUUID(),
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
}

function seedQueue(events: RecommendationEventInput[]): void {
  localStorageStub.setItem(QUEUE_STORAGE_KEY, JSON.stringify(events))
}

function queuedEvents(): RecommendationEventInput[] {
  const raw = localStorageStub.getItem(QUEUE_STORAGE_KEY)
  return raw === null ? [] : (JSON.parse(raw) as RecommendationEventInput[])
}

function sentEventIds(call: FetchCall | undefined): string[] {
  return (call?.events ?? []).map((item) => item.eventId)
}

/** 跑一段会触发 `console.warn` 的逻辑，但不把告警打到测试输出里。 */
async function withoutWarnings(run: () => Promise<void>): Promise<void> {
  const original = console.warn
  console.warn = () => undefined
  try {
    await run()
  } finally {
    console.warn = original
  }
}

describe('flushRecommendationQueue', () => {
  test('成功后按 eventId 出队，超过单批上限时继续分批', async () => {
    const events = Array.from({ length: 51 }, () => event())
    seedQueue(events)

    await flushRecommendationQueue()

    expect(calls.map((call) => call.events.length)).toEqual([50, 1])
    expect(queuedEvents()).toEqual([])
    expect(calls[0]?.url).toBe('/api/recommendations/events')
  })

  test('非 2xx 时保留队列，重试沿用同一个 eventId', async () => {
    const queued = event()
    seedQueue([queued])
    respond = async () => rejected(503)

    await flushRecommendationQueue()
    expect(queuedEvents().map((item) => item.eventId)).toEqual([queued.eventId])

    respond = async () => accepted()
    await flushRecommendationQueue()
    expect(sentEventIds(calls[1])).toEqual([queued.eventId])
    expect(queuedEvents()).toEqual([])
  })

  test('契约校验失败（422）同样保留队列，但会喊一声', async () => {
    seedQueue([event()])
    respond = async () => rejected(422)

    await withoutWarnings(() => flushRecommendationQueue())

    expect(queuedEvents()).toHaveLength(1)
  })

  test('本地队列里不合契约的事件被丢弃，不会连带同批合法事件', async () => {
    const valid = event()
    localStorageStub.setItem(QUEUE_STORAGE_KEY, JSON.stringify([{ eventId: 'not-a-uuid' }, valid]))

    await withoutWarnings(() => flushRecommendationQueue())

    expect(sentEventIds(calls[0])).toEqual([valid.eventId])
    expect(queuedEvents()).toEqual([])
  })

  test('本地队列写回失败时立刻收工，不会把同一批无限重发', async () => {
    const queued = [event(), event()]
    seedQueue(queued)
    let delivered = 0
    respond = async () => {
      delivered += 1
      // 修复前 drainQueue 的 `for(;;)` 会读到同一批再 POST（这正是缺陷本身），且因为
      // 全是已 resolve 的微任务，定时器会被饿死、进程挂死。这里给个上限，让用例以断言
      // 失败收场而不是把测试进程挂住。
      if (delivered > 3) throw new Error('写回失败后仍在重发同一批事件')
      return new Response(JSON.stringify({ accepted: 0, duplicates: 2, rejected: 0 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 服务端收下了，但本地写不回去（配额满）：队列内容一个字都没变。
    failWrites = true

    // 超时是第二道保险：冲刷必须在有限时间内 settle（否则之后所有入队都挂在死 promise 上）。
    const settled = await Promise.race([
      withoutWarnings(() => flushRecommendationQueue()).then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000)
      }),
    ])

    expect(settled).toBe(true)
    expect(calls).toHaveLength(1)
    // 事件保留在本地（读得到），下次写成功时连原 eventId 一起补发。
    failWrites = false
    expect(queuedEvents().map((item) => item.eventId)).toEqual(queued.map((item) => item.eventId))
  })

  test('本地存储静默丢弃写入时同样收工（只看返回值会无限重发）', async () => {
    const queued = [event(), event()]
    seedQueue(queued)
    let delivered = 0
    respond = async () => {
      delivered += 1
      if (delivered > 3) throw new Error('静默写失败后仍在重发同一批事件')
      return new Response(JSON.stringify({ accepted: 0, duplicates: 2, rejected: 0 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    }
    // `setItem` 不抛错也不落盘：只看返回值的实现会以为已经出队，于是把同一批发第二遍。
    silentWriteDrops = true

    const settled = await Promise.race([
      withoutWarnings(() => flushRecommendationQueue()).then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000)
      }),
    ])

    expect(settled).toBe(true)
    expect(calls).toHaveLength(1)
    // 队列在存储里一个字都没变，事件还在（下次写成功时连原 eventId 一起补发）。
    expect(queuedEvents().map((item) => item.eventId)).toEqual(queued.map((item) => item.eventId))
  })

  test('并发冲刷只保留一个在飞的请求', async () => {
    seedQueue([event(), event()])
    let inFlight = 0
    let maxInFlight = 0
    respond = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return accepted()
    }

    await Promise.all([
      flushRecommendationQueue(),
      flushRecommendationQueue(),
      flushRecommendationQueue(),
    ])

    expect(maxInFlight).toBe(1)
    expect(calls).toHaveLength(1)
    expect(queuedEvents()).toEqual([])
  })
})

describe('enqueueRecommendationEvent', () => {
  test('队列上限 500 条，超出丢最旧的', async () => {
    // 让冲刷失败，队列才会留在本地供断言。
    respond = async () => rejected(503)
    const events = Array.from({ length: 500 }, () => event())
    seedQueue(events)
    const oldest = events[0]?.eventId

    enqueueRecommendationEvent(event())

    const queued = queuedEvents()
    expect(queued).toHaveLength(500)
    expect(queued.some((item) => item.eventId === oldest)).toBe(false)

    await flushRecommendationQueue()
  })
})
