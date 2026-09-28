import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { RecommendationEventInput } from '@fish/contracts/recommendation/schema'

/**
 * 埋点队列的**集成接线**（#323 R1 复审第 6 轮审查 F5，小程序侧）。
 *
 * `recommendation-viewer.test.ts` 直接调 `syncRecommendationViewer`，所以把 `features/auth/store.ts`
 * 里 `emit()` 的那一行删掉不会有任何用例变红 —— 队列的身份分区会静默失效。这个文件只走真实调用点：
 * `bootstrapAuth()`（冷启动 `/me` 成功 / 401 / 网络失败 / 无本地会话）与 `clearLocalSession()`（退出）。
 */
const QUEUE_KEY = 'fish.recommendation.queue'
const VIEWER_KEY = 'fish:recommendation:viewer'
const SESSION_KEY = 'fish:session'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

const store = new Map<string, unknown>()

/** `queue.ts` 与 `lib/session.ts` 都通过 Taro 存储读写；真 Taro 在 Bun 下会抛 `ENABLE_INNER_HTML is not defined`。 */
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

/**
 * 演示登录态在测试运行时不存在（`__DEMO_AUTH__` 是构建期注入的全局），必须顶替掉，
 * 否则 `demo.ts` 在 import 期就 `ReferenceError`。
 */
const demoModule = () => ({
  DEMO_AUTH_ENABLED: false,
  DEMO_USER: {
    id: 'usr_demo',
    nickname: '演示同学',
    avatarUrl: null,
    authStatus: 'VERIFIED' as const,
    verifiedAt: null,
    phoneBound: false,
    maskedPhone: null,
  },
})
mock.module('@/features/auth/demo', demoModule)
mock.module('../src/features/auth/demo', demoModule)

type MeResult = { ok: true; user: Me } | { ok: false; error: unknown }
let nextMe: MeResult = { ok: true, user: { id: 'usr_unset' } as Me }

const authApiModule = () => ({
  fetchMe: async () => {
    if (nextMe.ok) return nextMe.user
    throw nextMe.error
  },
  logout: async () => undefined,
  wechatSignIn: async () => {
    throw new Error('这个用例不该调用 wechatSignIn')
  },
})
mock.module('@/features/auth/api', authApiModule)
mock.module('../src/features/auth/api', authApiModule)

const { ApiError } = await import('@/lib/request')
const { authSnapshot, bootstrapAuth, clearLocalSession } = await import('@/features/auth/store')
const { syncRecommendationViewer } = await import('@/features/recommendation/queue')

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

function event(): RecommendationEventInput {
  return {
    eventId: crypto.randomUUID(),
    listingId: LISTING_ID,
    eventType: 'DETAIL_VIEW',
    anonymousSessionId: crypto.randomUUID(),
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
}

function queuedEventIds(): string[] {
  const raw = store.get(QUEUE_KEY)
  return Array.isArray(raw) ? (raw as RecommendationEventInput[]).map((item) => item.eventId) : []
}

function storedMarker(): unknown {
  return store.get(VIEWER_KEY) ?? null
}

beforeEach(() => {
  store.clear()
  nextMe = { ok: true, user: userA }
  // 模块级身份跨用例存活：`undefined` = 身份不明（不写标记、闸门关着），每个用例自己建立状态
  syncRecommendationViewer(undefined)
})

describe('埋点队列的身份接线（store.ts）', () => {
  test('bootstrapAuth 成功建立身份时写下标记，并丢弃旧身份的待发事件', async () => {
    store.set(SESSION_KEY, 'fish_session=abc')
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    store.set(QUEUE_KEY, queued)

    nextMe = { ok: true, user: userB }
    await bootstrapAuth()

    expect(authSnapshot()).toEqual({ status: 'authed', user: userB })
    expect(storedMarker()).toEqual({ userId: userB.id })
    expect(queuedEventIds()).toEqual([])
  })

  test('bootstrapAuth 拿到 401 时落成匿名，并丢弃登录身份的待发事件', async () => {
    store.set(SESSION_KEY, 'fish_session=abc')
    syncRecommendationViewer(userA.id)
    store.set(QUEUE_KEY, [event(), event()])

    nextMe = { ok: false, error: new ApiError('UNAUTHENTICATED', 401, '未登录') }
    await bootstrapAuth()

    expect(storedMarker()).toEqual({ userId: null })
    expect(queuedEventIds()).toEqual([])
  })

  test('bootstrapAuth 遇到网络失败时不把身份当成匿名：闸门关掉、队列保留、凭据保留', async () => {
    store.set(SESSION_KEY, 'fish_session=abc')
    syncRecommendationViewer(userA.id)
    const queued = [event(), event()]
    store.set(QUEUE_KEY, queued)

    nextMe = { ok: false, error: new ApiError('NETWORK_ERROR', 0, '网络不可达') }
    await bootstrapAuth()

    // 标记仍是 A（cookie 可能还是登录态），事件一条不丢
    expect(storedMarker()).toEqual({ userId: userA.id })
    expect(queuedEventIds()).toEqual(queued.map((item) => item.eventId))
    expect(store.get(SESSION_KEY)).toBe('fish_session=abc')
  })

  test('bootstrapAuth 在没有本地会话时判匿名，并丢弃旧身份的待发事件', async () => {
    syncRecommendationViewer(userA.id)
    store.set(QUEUE_KEY, [event(), event()])

    await bootstrapAuth()

    expect(storedMarker()).toEqual({ userId: null })
    expect(queuedEventIds()).toEqual([])
  })

  test('clearLocalSession（退出登录）落成匿名并丢弃登录身份的待发事件', () => {
    syncRecommendationViewer(userA.id)
    store.set(QUEUE_KEY, [event(), event()])

    clearLocalSession()

    expect(storedMarker()).toEqual({ userId: null })
    expect(queuedEventIds()).toEqual([])
  })
})
