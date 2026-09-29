import { beforeEach, describe, expect, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'
import {
  clearRecommendationQueue,
  enqueueRecommendationEvent,
  flushRecommendationQueue,
  syncRecommendationViewer,
} from './queue'

const QUEUE_STORAGE_KEY = 'fish.recommendation.queue'
const VIEWER_STORAGE_KEY = 'fish.recommendation.viewer'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

/** 模拟配额写满：置为 true 后 `setItem` 抛错，`getItem` 仍能读到已写入的内容。 */
let failWrites = false
/** 模拟静默失败：`setItem` 不抛错也不落盘（某些浏览器 / 隐私模式下的 `localStorage`）。 */
let silentWriteDrops = false
/** 模拟删除静默失败：`removeItem` 不抛错也不生效（旧身份的事件会留在存储里）。 */
let silentRemoveDrops = false

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
      if (silentRemoveDrops) return
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
  silentRemoveDrops = false
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
  // 身份标记写下来（匿名）＝ 身份已解析：冲刷的身份门打开，且内存里的当前身份回到确定值，
  // 用例之间不会互相污染。需要「身份未知」状态的用例自己调 `dropViewerMarker()`。
  syncRecommendationViewer(null)
  calls = []
})

/** 回到「身份未知」：首次使用 / 旧版本客户端 / 身份还没解析出来。 */
function dropViewerMarker(): void {
  localStorageStub.removeItem(VIEWER_STORAGE_KEY)
}

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

/**
 * #323 R1 复审 blocker：离线队列必须按「事件发生时的登录身份」归属。
 * 队列里没有 `requestId` 的事件补发时由服务端按补发那一刻的 Cookie 落 `user_id`，
 * 所以客户端必须在身份变化时丢掉旧身份的待发事件。
 */
describe('syncRecommendationViewer', () => {
  test('切号后不再补发旧身份的待发事件', async () => {
    syncRecommendationViewer('A')
    // 断网期间入队：冲刷失败，A 的两条事件留在本地。
    respond = async () => rejected(503)
    enqueueRecommendationEvent(event())
    enqueueRecommendationEvent(event())
    await flushRecommendationQueue()
    expect(queuedEvents()).toHaveLength(2)
    const callsBeforeSwitch = calls.length

    // A 退出、B 登录（真实入口是 `resetPcSession` / `loadMe`）。
    respond = async () => accepted()
    syncRecommendationViewer('B')
    await flushRecommendationQueue()

    expect(queuedEvents()).toEqual([])
    // 旧身份的队列被丢弃，本轮一条都没发出去。
    expect(calls).toHaveLength(callsBeforeSwitch)

    const fresh = event()
    enqueueRecommendationEvent(fresh)
    await flushRecommendationQueue()

    expect(calls.slice(callsBeforeSwitch).flatMap((call) => sentEventIds(call))).toEqual([
      fresh.eventId,
    ])
  })

  test('身份没变时重复同步不轮换队列', async () => {
    syncRecommendationViewer('A')
    const queued = [event(), event()]
    seedQueue(queued)

    syncRecommendationViewer('A')
    syncRecommendationViewer('A')

    // 队列内容一个字都没变（每次刷新页面都会走到这里，轮换就等于丢掉待发事件）。
    expect(queuedEvents().map((item) => item.eventId)).toEqual(queued.map((item) => item.eventId))

    await flushRecommendationQueue()
    expect(sentEventIds(calls[0])).toEqual(queued.map((item) => item.eventId))
  })

  test('另一个标签页轮换身份后本页不再补发', async () => {
    syncRecommendationViewer('A')
    seedQueue([event(), event()])
    // 模拟另一个标签页换号：它写下了自己的身份标记（并按协议清空了共享队列）。
    // 这里故意留下队列，证明本页即使还握着 A 的批次也不会把它投递出去。
    localStorageStub.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ userId: 'B' }))

    await flushRecommendationQueue()

    expect(calls).toEqual([])
  })

  test('取到批次之后身份被换掉时不再投递这一批', async () => {
    syncRecommendationViewer('A')
    seedQueue(Array.from({ length: 51 }, () => event()))
    // 第一批的请求在飞时另一个标签页换号：第二批必须在 POST 之前复核到标记已变。
    respond = async () => {
      localStorageStub.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ userId: 'B' }))
      return accepted()
    }

    await flushRecommendationQueue()

    expect(calls).toHaveLength(1)
    expect(queuedEvents()).toHaveLength(1)
  })

  test('身份未知时入队的事件在解析出登录态后不迁移', async () => {
    // 冷启动：身份还没解析出来（没有标记）就入了队，随后解析出登录态 A。
    // 这批事件可能来自匿名会话，挂到 A 上就是一次「匿名 → 登录」迁移 —— 按锁定口径丢弃。
    seedQueue([event(), event()])
    dropViewerMarker()

    syncRecommendationViewer('A')

    expect(queuedEvents()).toEqual([])
    await flushRecommendationQueue()
    expect(calls).toEqual([])
  })

  test('身份未就绪时不投递，事件留在队列等身份解析', async () => {
    const queued = [event(), event()]
    seedQueue(queued)
    dropViewerMarker()

    // 没有标记 = 还不知道这批事件属于谁：此刻发送只能按当时的 Cookie 落 `user_id`。
    await flushRecommendationQueue()

    expect(calls).toEqual([])
    expect(queuedEvents().map((item) => item.eventId)).toEqual(queued.map((item) => item.eventId))

    // 身份解析出来（这里仍是匿名）后照常补发：冷启动的曝光数据不会丢。
    respond = async () => accepted()
    syncRecommendationViewer(null)
    await flushRecommendationQueue()

    expect(sentEventIds(calls.at(-1))).toEqual(queued.map((item) => item.eventId))
    expect(queuedEvents()).toEqual([])
  })

  test('清除队列只有在确认清空之后才算成功', () => {
    seedQueue([event()])
    expect(clearRecommendationQueue()).toBe(true)
    expect(queuedEvents()).toEqual([])

    // 静默失败：不抛错也没删掉。只信返回值就会误判成「旧身份的事件已经清干净」。
    seedQueue([event()])
    silentRemoveDrops = true
    expect(clearRecommendationQueue()).toBe(false)
    expect(queuedEvents()).toHaveLength(1)
  })

  test('清除队列静默失效时不采纳新身份，也不补发旧身份事件', async () => {
    syncRecommendationViewer('A')
    const queued = [event(), event()]
    seedQueue(queued)

    // 换号 B：标记照常写进去，但删队列静默失效 —— 存储里仍是 A 的事件、标记却是 B。
    silentRemoveDrops = true
    syncRecommendationViewer('B')

    // 没有确认清空就不许采纳 B：否则这批事件会按 B 的 Cookie 投出去（串号）。
    await flushRecommendationQueue()
    expect(calls).toEqual([])
    expect(queuedEvents().map((item) => item.eventId)).toEqual(queued.map((item) => item.eventId))
  })

  test('身份标记写不进去时不采纳新身份，也不补发旧身份事件', async () => {
    syncRecommendationViewer('A')
    const queued = [event(), event()]
    seedQueue(queued)

    // 换号 B：队列清空成功，但标记写入静默失效 —— 存储里仍是旧标记 A。
    // 若此时内存采纳 B，复核会读到 A 与内存 B 不一致而「同意」……
    // 更糟的是反过来：内存若留在 A，闸门照样会开，A 的事件就按 B 的 Cookie 发出去了。
    silentWriteDrops = true
    syncRecommendationViewer('B')

    await flushRecommendationQueue()
    expect(calls).toEqual([])
    expect(queuedEvents()).toEqual([])
    expect(JSON.parse(localStorageStub.getItem(VIEWER_STORAGE_KEY) ?? 'null')).toEqual({
      userId: 'A',
    })
  })

  test('身份不明时模块加载（导入 queue.ts）不丢队列', () => {
    // 冷启动 `loadMe` 网络失败时整段会话都不写标记：本客户端自己攒的事件不能被当成
    // 「旧版本客户端的遗留队列」丢掉（模块加载时的丢弃规则已被删除）。
    seedQueue([event(), event()])
    dropViewerMarker()

    expect(queuedEvents()).toHaveLength(2)
  })

  test('退出登录后不补发已登录身份的待发事件', async () => {
    syncRecommendationViewer('A')
    seedQueue([event(), event()])

    syncRecommendationViewer(null)

    expect(queuedEvents()).toEqual([])
    expect(JSON.parse(localStorageStub.getItem(VIEWER_STORAGE_KEY) ?? 'null')).toEqual({
      userId: null,
    })
    await flushRecommendationQueue()
    expect(calls).toEqual([])
  })
})
