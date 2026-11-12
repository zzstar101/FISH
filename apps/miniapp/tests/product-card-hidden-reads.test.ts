import { beforeEach, expect, mock, test } from 'bun:test'
import type { MockListing, MockUser } from '../src/mock/types'

/**
 * 商品卡 mount 时读本机隐藏名单的**次数**（#595）。
 *
 * 需求原文：一屏 50 张卡，每张在 `useState` initializer 里同步读同一个存储 key，
 * 就是 50 次同 key 读取。修法不是加缓存，而是**页面已经有一份恒新鲜的名单**
 * （mount / `useDidShow` / 隐藏回调三处维护），卡片直接信它，只在**没有页面托管**
 * 时才自己读一次兜底。
 *
 * 这里用最小 hook host 跑真实组件（不引渲染器依赖），把 `getStorageSync` 的调用
 * 计数钉住 —— 光看源码里有没有 `readHiddenListingIds()` 抓不到「到底读了几次」。
 */

let slots: unknown[] = []
let cursor = 0
mock.module('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const index = cursor++
    // 与 React 一致：函数形态的初值是 lazy initializer，要**调用**它。
    // 不调用的话 `useState(() => readHiddenListingIds()...)` 存进去的是函数本身（恒真），
    // 「读了几次存储」这条断言就永远是 0，测试会假绿。
    if (!(index in slots)) {
      slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    return [
      slots[index],
      (next: T | ((previous: T) => T)) => {
        const value =
          typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next
        slots[index] = value
      },
    ]
  },
  useRef: <T>(initial: T) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
}))
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }))
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: 'Fragment' }))
mock.module('@tarojs/components', () => ({ View: 'View', Text: 'Text', Image: 'Image' }))

const HIDDEN_KEY = 'fish.recommendation.hiddenListings'
const disk = new Map<string, unknown>()
/** 每次 `getStorageSync` 都记一笔，用来证明读取次数不随卡片数增长 */
const storageReads: string[] = []
mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => {
      storageReads.push(key)
      return disk.get(key) ?? ''
    },
    setStorageSync: (key: string, value: unknown) => {
      disk.set(key, value)
    },
    showActionSheet: () => Promise.resolve({ tapIndex: 1 }),
  },
}))

mock.module('@/features/favorites/api', () => ({
  fetchFavoriteState: () => Promise.resolve(false),
  setFavorite: () => Promise.resolve({ favorited: true }),
}))
mock.module('@/features/recommendation/track', () => ({ trackRecommendationEvent: () => {} }))
mock.module('@/features/listing/status-mark', () => ({ outOfMarketLabel: () => null }))

const { default: ProductCard } = await import('../src/components/product-card')

const seller: MockUser = {
  id: 'usr-1',
  nickname: '卖家',
  avatarUrl: 'https://cdn.example.com/a.png',
  authStatus: 'VERIFIED',
}

function listing(id: string): MockListing {
  return {
    id,
    title: `标题 ${id}`,
    priceCents: 1200,
    originalPriceCents: null,
    category: 'DIGITAL',
    sub: '',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: 'assets/covers/digital-headphone.png',
    images: ['assets/covers/digital-headphone.png'],
    ratio: '4x5',
    badge: null,
    description: '',
    spec: '',
    sellerId: seller.id,
    seller,
    views: 3,
    wants: 1,
    createdHoursAgo: 2,
    createdAt: '2026-11-07T00:00:00.000Z',
  }
}

function mount(hidden: boolean | undefined): unknown {
  slots = []
  cursor = 0
  const props: Record<string, unknown> = {
    listing: listing('lst-1'),
    seller,
    imageHeight: 400,
  }
  if (hidden !== undefined) props.hidden = hidden
  return ProductCard(props as never)
}

beforeEach(() => {
  storageReads.length = 0
  disk.clear()
})

test('页面传了 hidden：mount 不读本机隐藏名单（一屏几十张就是几十次同 key 读取）', () => {
  mount(false)
  expect(storageReads.filter((key) => key === HIDDEN_KEY)).toHaveLength(0)
})

test('页面传了 hidden=true 同样不读存储：页面说隐藏就隐藏，不必自己再确认一遍', () => {
  const tree = mount(true) as { props: { children?: unknown } } | null
  expect(storageReads.filter((key) => key === HIDDEN_KEY)).toHaveLength(0)
  // 整张卡不渲染
  expect(tree).toBeNull()
})

test('没有页面托管（不传 hidden）时保留 mount 读一次兜底：命中名单就不渲染', () => {
  disk.set(HIDDEN_KEY, { ids: ['lst-1'], expiresAt: Date.now() + 60_000 })
  const tree = mount(undefined) as unknown
  expect(storageReads.filter((key) => key === HIDDEN_KEY)).toHaveLength(1)
  expect(tree).toBeNull()
})

test('没有页面托管且名单未命中：读一次、照常渲染', () => {
  disk.set(HIDDEN_KEY, { ids: ['lst-9'], expiresAt: Date.now() + 60_000 })
  const tree = mount(undefined) as { props: Record<string, unknown> } | null
  expect(storageReads.filter((key) => key === HIDDEN_KEY)).toHaveLength(1)
  expect(tree).not.toBeNull()
})

test('名单过期后兜底读取不再隐藏（过期规则不回归）', () => {
  disk.set(HIDDEN_KEY, { ids: ['lst-1'], expiresAt: Date.now() - 1 })
  const tree = mount(undefined) as unknown
  expect(tree).not.toBeNull()
})

test('多张卡走页面托管时，存储读取次数恒为 0（不随卡片数线性增长）', () => {
  for (let index = 0; index < 50; index++) {
    // 每张卡都是独立的一次 mount：槽位必须清空，否则 lazy initializer 只在第一张上跑，
    // 这条断言就变成了「只挂了一张卡」的同义反复。
    slots = []
    cursor = 0
    ProductCard({
      listing: listing(`lst-${index + 1}`),
      seller,
      imageHeight: 400,
      hidden: false,
    } as never)
  }
  expect(storageReads.filter((key) => key === HIDDEN_KEY)).toHaveLength(0)
})
