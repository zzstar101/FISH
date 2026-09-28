import { beforeEach, describe, expect, test } from 'bun:test'
import { readAttribution, rememberAttribution } from './track'

const ATTRIBUTION_STORAGE_KEY = 'fish.recommendation.attribution'
// 每个用例用不同 listing：模块内的归因 Map 在同一进程里是跨用例共享的。
const LISTING_REMEMBERED = 'lst_01jc000000e00800000000001a'
const LISTING_RESTORED = 'lst_01jc000000e00800000000001b'
const LISTING_UNKNOWN = 'lst_01jc000000e00800000000001c'
const LISTING_EXPIRED = 'lst_01jc000000e00800000000001d'

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
})

beforeEach(() => {
  localStorageStub.clear()
  sessionStorageStub.clear()
})

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
