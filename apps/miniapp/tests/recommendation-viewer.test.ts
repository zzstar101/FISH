import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 离线队列的**身份归属**（#323 R1 复审 blocker）。
 *
 * 要拦住的缺陷：服务端按「投递那一刻的会话 cookie」反解事件归属
 * （`apps/api/src/modules/recommendation/service.ts` 的 `let userId = viewerId`），而本地队列
 * 没有按事件发生时的身份分区 —— A 登录时入队的无归因事件（搜索 / 分类入口进详情产生的
 * DETAIL_VIEW 等没有 `requestId`，服务端没有 `ownsRequest()` 兜底）会在 A 退出、B 登录后的
 * 补发里被记成 **B 的行为**。
 *
 * 修法的语义是「登录 / 换号 / 退出时丢弃未发送的旧身份事件」：身份变了以后那些事件要么
 * 以旧身份发（cookie 已经是新的，做不到），要么被算成新身份的行为（错误数据）。
 *
 * 为什么用 `mock.module`：`queue.ts` 必须 `import Taro`，而 Bun 下加载真 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`（手法同 `tests/recommendation-queue.test.ts`）。
 */
const QUEUE_KEY = 'fish.recommendation.queue'
const VIEWER_KEY = 'fish:recommendation:viewer'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

const store = new Map<string, unknown>()

/**
 * 「另一个页面轮换身份」的模拟：从存储读 viewer 标记**到第 N 次之后**返回被换成的身份。
 * `Number.POSITIVE_INFINITY`（默认）= 始终返回真实标记，即没人轮换。
 *
 * 它是给「读批次 → 投递之间」那个竞态窗口用的：让冲刷开头那次比对通过、POST 前那次比对失败。
 */
let viewerReadsBeforeRotation = Number.POSITIVE_INFINITY
let rotationUserId: string | null = null

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => {
      if (key === VIEWER_KEY) {
        if (viewerReadsBeforeRotation <= 0) return { userId: rotationUserId }
        viewerReadsBeforeRotation -= 1
      }
      return store.get(key) ?? ''
    },
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

type PostCall = { events: RecommendationEventInput[] }

let calls: PostCall[] = []

mock.module('../src/features/recommendation/api', () => ({
  postRecommendationEvents: async (events: RecommendationEventInput[]) => {
    calls.push({ events })
  },
}))

const {
  dropUnattributableQueue,
  enqueueRecommendationEvent,
  flushRecommendationQueue,
  syncRecommendationViewer,
} = await import('../src/features/recommendation/queue')

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

function queuedEventIds(): string[] {
  return queuedEvents().map((item) => item.eventId)
}

function postedEventIds(call: PostCall | undefined): string[] {
  return (call?.events ?? []).map((item) => item.eventId)
}

beforeEach(() => {
  store.clear()
  calls = []
  viewerReadsBeforeRotation = Number.POSITIVE_INFINITY
  rotationUserId = null
  // 模块级身份跨用例存活，必须显式重置：`null` = 已建立「未登录」身份、队列为空
  syncRecommendationViewer(null)
})

describe('syncRecommendationViewer', () => {
  test('切号后不补发旧身份的事件，只投递新身份入队的事件', async () => {
    syncRecommendationViewer('A')
    const oldEvents = [event(), event()]
    seedQueue(oldEvents)

    syncRecommendationViewer('B')
    // 旧身份的事件在切号这一步就被丢弃（修复前它们留在队列里，等补发时被记成 B 的行为）
    expect(queuedEventIds()).toEqual([])

    // A 的 eventId 一个都没被 POST
    await flushRecommendationQueue()
    expect(calls).toEqual([])

    const fresh = event()
    enqueueRecommendationEvent(fresh)
    await flushRecommendationQueue()

    expect(calls).toHaveLength(1)
    expect(postedEventIds(calls[0])).toEqual([fresh.eventId])
  })

  test('同一身份重复同步不轮换队列', () => {
    syncRecommendationViewer('A')
    const queued = [event(), event()]
    seedQueue(queued)

    syncRecommendationViewer('A')

    expect(queuedEventIds()).toEqual(queued.map((item) => item.eventId))
  })

  test('退出登录后不补发登录期间入队的事件', async () => {
    syncRecommendationViewer('A')
    seedQueue([event()])

    syncRecommendationViewer(null)

    expect(queuedEventIds()).toEqual([])
    await flushRecommendationQueue()
    expect(calls).toEqual([])
  })

  test('没有身份标记时，匿名 → 登录不迁移：旧队列在首次同步成登录态时被丢弃', async () => {
    // 身份不明的一批事件（标记缺失）：挂到账号上就是「匿名 → 登录」迁移，口径锁定为丢弃
    store.delete(VIEWER_KEY)
    const legacy = [event(), event()]
    seedQueue(legacy)

    syncRecommendationViewer('A')

    expect(queuedEventIds()).toEqual([])
    await flushRecommendationQueue()
    expect(calls).toEqual([])
  })

  test('没有身份标记但解析出的是未登录态时，队列保留', () => {
    // 冷启动的匿名访客：身份就绪（null）但事件尚未发送，不能丢
    store.delete(VIEWER_KEY)
    const queued = [event(), event()]
    seedQueue(queued)

    syncRecommendationViewer(null)

    expect(queuedEventIds()).toEqual(queued.map((item) => item.eventId))
  })

  test('模块加载时丢弃身份不明的遗留队列', () => {
    // 旧版本客户端留下的队列：有事件、没有身份标记 —— 不可能是本页面生命周期写的
    store.delete(VIEWER_KEY)
    const legacy = [event(), event()]
    seedQueue(legacy)

    dropUnattributableQueue()

    expect(queuedEventIds()).toEqual([])
  })

  test('身份标记已经写下时，模块加载不丢弃队列', () => {
    store.delete(VIEWER_KEY)
    syncRecommendationViewer(null)
    const queued = [event(), event()]
    seedQueue(queued)

    dropUnattributableQueue()

    expect(queuedEventIds()).toEqual(queued.map((item) => item.eventId))
  })
})

describe('flushRecommendationQueue —— 身份把关', () => {
  test('身份未就绪时不投递，事件留在队列等身份解析', async () => {
    // 标记缺失（身份未知）：事件既不能按匿名发，也不能按未知身份发，只能等
    store.delete(VIEWER_KEY)
    const seeded = [event(), event()]
    seedQueue(seeded)

    await flushRecommendationQueue()

    expect(calls).toEqual([])
    expect(queuedEventIds()).toEqual(seeded.map((item) => item.eventId))

    // 身份解析为「未登录」后，同一批照原 eventId 补发
    syncRecommendationViewer(null)
    await flushRecommendationQueue()

    expect(postedEventIds(calls[0])).toEqual(seeded.map((item) => item.eventId))
    expect(queuedEventIds()).toEqual([])
  })
  test('存储里的身份被别的页面轮换后，本页不投递手里的旧队列', async () => {
    syncRecommendationViewer('A')
    const seeded = [event(), event()]
    seedQueue(seeded)

    /*
      模拟另一个页面轮换身份：只改存储标记。真实路径里对方还会清空队列，这里**故意不清** ——
      本页必须自己挡住（对方写存储失败、或标记被手工改掉时，队列会原样留着）。
    */
    store.set(VIEWER_KEY, { userId: 'B' })

    await flushRecommendationQueue()

    expect(calls).toEqual([])
    expect(queuedEventIds()).toEqual([])
  })

  test('读批次到投递之间被换号：本轮一条都不投递，事件也不出队', async () => {
    syncRecommendationViewer('A')
    const seeded = [event()]
    seedQueue(seeded)

    // 第一次读（冲刷开头的比对）还看到 A，第二次读（POST 前）看到 B —— 正是要压住的竞态窗口
    viewerReadsBeforeRotation = 1
    rotationUserId = 'B'

    await flushRecommendationQueue()

    expect(calls).toEqual([])
    expect(queuedEventIds()).toEqual([seeded[0]?.eventId])
  })
})
