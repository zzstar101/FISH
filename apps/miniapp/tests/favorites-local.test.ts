import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 本机收藏名单（瀑布流卡片长按菜单的「收藏」）。
 *
 * 为什么用 `mock.module`：`features/favorites/local.ts` 必须 `import Taro`，Bun 下加载真 Taro
 * 会抛 `ENABLE_INNER_HTML is not defined`（手法同 `tests/recommendation-queue.test.ts`）。
 * 这里用内存 Map 顶替同步存储，并让读 / 写各自按需失败 —— 真机上存储也会失败（配额写满 /
 * 存储不可用），而调用它的是一次长按菜单：抛出去就是整个菜单哑掉，所以「不抛」本身是行为要求。
 */
const FAVORITES_KEY = 'fish.favorites.localListings'
const LISTING_A = 'lst_01jc000000e00800000000001a'
const LISTING_B = 'lst_01jc000000e00800000000001b'

const store = new Map<string, unknown>()
let throwOnWrite = false
let throwOnRead = false

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => {
      if (throwOnRead) throw new Error('storage read failed')
      return store.get(key) ?? ''
    },
    setStorageSync: (key: string, data: unknown) => {
      if (throwOnWrite) throw new Error('storage write failed')
      store.set(key, data)
    },
  },
}))

const { isListingFaved, setListingFavorite } = await import('../src/features/favorites/local')

/** 存储里那一条原始记录（断言「写了什么」而不只是「读得到什么」） */
function storedIds(): string[] {
  const raw = store.get(FAVORITES_KEY)
  if (typeof raw !== 'object' || raw === null) return []
  const ids = (raw as { ids?: unknown }).ids
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

beforeEach(() => {
  store.clear()
  throwOnWrite = false
  throwOnRead = false
})

describe('收藏 / 取消收藏', () => {
  test('收藏后读得回来（菜单据此显示「取消收藏」）', () => {
    expect(setListingFavorite(LISTING_A, true)).toBe(true)
    expect(isListingFaved(LISTING_A)).toBe(true)
    expect(storedIds()).toEqual([LISTING_A])
  })

  test('同一件重复收藏只留一份', () => {
    setListingFavorite(LISTING_A, true)
    setListingFavorite(LISTING_A, true)
    expect(storedIds()).toEqual([LISTING_A])
  })

  test('取消收藏只摘掉这一条，别的收藏不动', () => {
    setListingFavorite(LISTING_A, true)
    setListingFavorite(LISTING_B, true)

    expect(setListingFavorite(LISTING_A, false)).toBe(false)
    expect(isListingFaved(LISTING_A)).toBe(false)
    expect(storedIds()).toEqual([LISTING_B])
  })

  test('取消一件没收藏过的商品不会把它写进去，且返回「没收藏」', () => {
    /*
      返回值就是卡片 `if (next === faved)` 判据里的真值：早返回时若返回相反的值，
      卡片会把一次**没落盘**的取消报成「已取消收藏」，还照发一条 UNFAVORITE。
    */
    expect(setListingFavorite(LISTING_A, false)).toBe(false)
    expect(store.has(FAVORITES_KEY)).toBe(false)
    expect(isListingFaved(LISTING_A)).toBe(false)
  })

  test('已经是目标状态时重复点同一边：不写存储，返回值仍是那个状态', () => {
    expect(setListingFavorite(LISTING_A, true)).toBe(true)
    expect(setListingFavorite(LISTING_A, true)).toBe(true)
    expect(storedIds()).toEqual([LISTING_A])
  })
})

describe('存储不可用 / 被写坏时都不能把菜单搞崩', () => {
  test('写入失败不抛，返回的是**没落盘**的状态（卡片据此如实提示）', () => {
    throwOnWrite = true
    expect(() => setListingFavorite(LISTING_A, true)).not.toThrow()
    // 关键：不能按意图返回 true —— 那会让菜单显示「取消收藏」，而存储里根本没有
    expect(setListingFavorite(LISTING_A, true)).toBe(false)
    expect(storedIds()).toEqual([])
    expect(isListingFaved(LISTING_A)).toBe(false)
  })

  test('读取抛异常时当空名单，不抛', () => {
    throwOnRead = true
    expect(() => isListingFaved(LISTING_A)).not.toThrow()
    expect(isListingFaved(LISTING_A)).toBe(false)
    // 读不了就当没有：写入仍然照走（写完重读核对拿不到就返回原状态）
    expect(() => setListingFavorite(LISTING_A, true)).not.toThrow()
  })

  test('存储里是坏形状时当空名单，不抛', () => {
    for (const bad of ['', 'lst_x', {}, { ids: 'x' }, { ids: [1, null] }]) {
      store.set(FAVORITES_KEY, bad)
      expect(() => isListingFaved(LISTING_A)).not.toThrow()
      expect(isListingFaved(LISTING_A)).toBe(false)
    }
  })

  test('名单里混进非字符串时只丢那一条', () => {
    store.set(FAVORITES_KEY, { ids: [LISTING_A, 7, null, LISTING_B] })
    expect(isListingFaved(LISTING_A)).toBe(true)
    expect(isListingFaved(LISTING_B)).toBe(true)
    expect(storedIds()).toEqual([LISTING_A, LISTING_B])
  })
})
