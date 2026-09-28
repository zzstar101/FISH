import { beforeEach, describe, expect, test } from 'bun:test'
import { flushRecommendationQueue } from './queue'
import {
  consumeAttribution,
  readAttribution,
  rememberAttribution,
  trackEvent,
  trackListingEvent,
} from './track'

const ATTRIBUTION_STORAGE_KEY = 'fish.recommendation.attribution'
const QUEUE_STORAGE_KEY = 'fish.recommendation.queue'
// 每个用例用不同 listing：模块内的归因 Map 在同一进程里是跨用例共享的。
const LISTING_REMEMBERED = 'lst_01jc000000e00800000000001a'
const LISTING_RESTORED = 'lst_01jc000000e00800000000001b'
const LISTING_UNKNOWN = 'lst_01jc000000e00800000000001c'
const LISTING_EXPIRED = 'lst_01jc000000e00800000000001d'
const LISTING_CONSUMED = 'lst_01jc000000e00800000000001e'
const LISTING_REVISITED = 'lst_01jc000000e00800000000001f'
const LISTING_SHARED = 'lst_01jc000000e008000000000020'

const REQUEST_ID = '2f1c7b3e-4d5a-4c6b-8d9e-0a1b2c3d4e5f'

function createStorage() {
  const entries = new Map<string, string>()
  return {
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

const localStorageStub = createStorage()
const sessionStorageStub = createStorage()
Object.assign(globalThis, {
  window: { localStorage: localStorageStub, sessionStorage: sessionStorageStub },
  // 入队会立刻触发一次冲刷；桩成 503 让事件留在本地队列里供断言，测试也不会真的发请求。
  fetch: async () => new Response(null, { status: 503 }),
})

beforeEach(() => {
  localStorageStub.clear()
  sessionStorageStub.clear()
})

/** 本地队列里当前积压的事件。 */
function readQueue(): Array<{ listingId: string; requestId?: string; position?: number }> {
  const raw = localStorageStub.getItem(QUEUE_STORAGE_KEY)
  return raw === null ? [] : (JSON.parse(raw) as Array<{ listingId: string }>)
}

/** 模拟「上一次访问留下的归因表」，用来验证刷新后仍能接上。 */
function seedStoredAttribution(listingId: string, position: number, expiresAt: number): void {
  sessionStorageStub.setItem(
    ATTRIBUTION_STORAGE_KEY,
    JSON.stringify({ [listingId]: { requestId: REQUEST_ID, position, expiresAt } }),
  )
}

describe('推荐归因', () => {
  test('记住后能读回 requestId 与 position', () => {
    rememberAttribution(LISTING_REMEMBERED, { requestId: REQUEST_ID, position: 7 })

    expect(readAttribution(LISTING_REMEMBERED)).toEqual({ requestId: REQUEST_ID, position: 7 })
  })

  test('刷新页面后仍能从 sessionStorage 接上归因', () => {
    seedStoredAttribution(LISTING_RESTORED, 3, Date.now() + 60_000)

    expect(readAttribution(LISTING_RESTORED)).toEqual({ requestId: REQUEST_ID, position: 3 })
  })

  test('没有归因的 listing 返回 null（搜索/分类进来的浏览）', () => {
    expect(readAttribution(LISTING_UNKNOWN)).toBeNull()
  })

  test('过期归因不再生效', () => {
    seedStoredAttribution(LISTING_EXPIRED, 3, Date.now() - 1)

    expect(readAttribution(LISTING_EXPIRED)).toBeNull()
  })
})

describe('归因消费', () => {
  test('消费后返回一次并清掉持久化条目，再消费为 null', () => {
    rememberAttribution(LISTING_CONSUMED, { requestId: REQUEST_ID, position: 4 })

    expect(consumeAttribution(LISTING_CONSUMED)).toEqual({ requestId: REQUEST_ID, position: 4 })
    // 已消费：30 分钟内从搜索、分类再进同一件商品，不该被上一次推荐请求污染。
    expect(readAttribution(LISTING_CONSUMED)).toBeNull()
    expect(consumeAttribution(LISTING_CONSUMED)).toBeNull()
  })

  test('没有归因的 listing 消费为 null', () => {
    expect(consumeAttribution(LISTING_UNKNOWN)).toBeNull()
  })

  test('同一次详情页浏览内，后续事件仍复用消费到的归因', async () => {
    rememberAttribution(LISTING_SHARED, { requestId: REQUEST_ID, position: 5 })

    // 详情页进入时消费一次；10 秒后的 LONG_VIEW 必须还挂在同一次推荐请求上。
    consumeAttribution(LISTING_SHARED)
    trackListingEvent({ listingId: LISTING_SHARED, eventType: 'LONG_VIEW' })

    const [queued] = readQueue()
    expect(queued?.listingId).toBe(LISTING_SHARED)
    expect(queued?.requestId).toBe(REQUEST_ID)
    expect(queued?.position).toBe(5)

    await flushRecommendationQueue()
  })

  test('消费后换个入口再进同一件商品，事件不带归因', async () => {
    rememberAttribution(LISTING_REVISITED, { requestId: REQUEST_ID, position: 6 })

    consumeAttribution(LISTING_REVISITED)
    // 离开详情页后从搜索结果再进一次：这一份归因已经用掉了。
    consumeAttribution(LISTING_REVISITED)
    trackListingEvent({ listingId: LISTING_REVISITED, eventType: 'DETAIL_VIEW' })

    const [queued] = readQueue()
    expect(queued?.listingId).toBe(LISTING_REVISITED)
    expect(queued?.requestId).toBeUndefined()
    expect(queued?.position).toBeUndefined()

    await flushRecommendationQueue()
  })

  test('非规范公开 id 的事件被丢掉，不入队', async () => {
    // `lst_` 前缀合法但编码不完整：契约校验会拒绝，绝不能进队列拖垮整批上报。
    await withoutWarnings(async () => {
      trackEvent({ listingId: 'lst_', eventType: 'DETAIL_VIEW' })
    })

    expect(localStorageStub.getItem(QUEUE_STORAGE_KEY)).toBeNull()
  })
})

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
