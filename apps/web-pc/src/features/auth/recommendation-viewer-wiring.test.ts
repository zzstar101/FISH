import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'
import { QueryClient } from '@tanstack/react-query'

/**
 * 埋点队列的**集成接线**（#323 R1 复审第 6 轮审查 F5）。
 *
 * `queue.test.ts` 直接调 `syncRecommendationViewer`，因此把真实调用点里的那一行删掉（`queries.ts`
 * 的成功 / 401 两条路径、`session-cache.ts` 的重置路径）不会有任何用例变红 —— 队列的身份分区
 * 会静默失效。这个文件只做一件事：走真实调用点，断言存储里的标记与队列真的跟着身份走。
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
// 队列只依赖 `window.localStorage`（手法同 `features/recommendation/queue.test.ts`），必须在
// 动态 import 之前装好。
Object.assign(globalThis, {
  window: { localStorage: localStorageStub, sessionStorage: createStorage() },
})

const { syncRecommendationViewer } = await import('../recommendation/queue')
const { loadMe } = await import('./queries')
const { resetPcSession } = await import('../../lib/session-cache')

const originalFetch = globalThis.fetch

const userA: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: 'A',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}
const userB: Me = { ...userA, id: 'usr_01jc000000e00800000000000b', nickname: 'B' }

function respondWithMe(user: Me): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ user }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

function respondUnauthenticated(): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '未登录' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
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

/** 直接写存储，模拟「上一次成功落盘、还没发出去的事件」。 */
function seedQueue(events: RecommendationEventInput[]): void {
  localStorageStub.setItem(QUEUE_STORAGE_KEY, JSON.stringify(events))
}

function queuedEventIds(): string[] {
  const raw = localStorageStub.getItem(QUEUE_STORAGE_KEY)
  return raw === null
    ? []
    : (JSON.parse(raw) as RecommendationEventInput[]).map((item) => item.eventId)
}

function storedMarker(): unknown {
  const raw = localStorageStub.getItem(VIEWER_STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw)
}

beforeEach(() => {
  localStorageStub.clear()
  // 模块级身份跨用例存活：先落成匿名，每个用例自己从「未登录」出发建立身份
  syncRecommendationViewer(null)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('埋点队列的身份接线', () => {
  test('loadMe 成功建立身份时写下标记，并丢弃旧身份的待发事件', async () => {
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    seedQueue(queued)

    respondWithMe(userB)
    await loadMe(new QueryClient())

    expect(storedMarker()).toEqual({ userId: userB.id })
    expect(queuedEventIds()).toEqual([])
  })

  test('loadMe 拿到 401 时把身份落成匿名，并丢弃登录身份的待发事件', async () => {
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    seedQueue(queued)

    respondUnauthenticated()
    await loadMe(new QueryClient())

    expect(storedMarker()).toEqual({ userId: null })
    expect(queuedEventIds()).toEqual([])
  })

  test('loadMe 成功但身份没变时不动队列', async () => {
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    seedQueue(queued)

    respondWithMe(userA)
    await loadMe(new QueryClient())

    expect(storedMarker()).toEqual({ userId: userA.id })
    expect(queuedEventIds()).toEqual(queued.map((item) => item.eventId))
  })

  test('resetPcSession（登录 / 跨标签页换号）同步标记并丢弃旧身份事件', async () => {
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    seedQueue(queued)

    await resetPcSession(new QueryClient(), userB)

    expect(storedMarker()).toEqual({ userId: userB.id })
    expect(queuedEventIds()).toEqual([])
  })

  test('resetPcSession（退出登录）同步成匿名并丢弃登录身份事件', async () => {
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    seedQueue(queued)

    await resetPcSession(new QueryClient(), null)

    expect(storedMarker()).toEqual({ userId: null })
    expect(queuedEventIds()).toEqual([])
  })
})
