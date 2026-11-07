import { expect, mock, test } from 'bun:test'
import type { MockListing } from '../src/mock/types'

/**
 * 身份指纹的**生产实现**（#631）：`homeFeedViewer()` 直接读 `fish:session`。
 *
 * `tests/home-feed-cache.test.ts` 的每条用例都显式注入 `viewer`，那个函数从没被执行过 ——
 * 把它改成恒返回 `'anon'`，那边依旧全绿。这里补的正是这条缝：真实会话 cookie 进、指纹出，
 * 且会话一变快照就必须作废。
 *
 * 会话读取走 `apps/miniapp/src/lib/session.ts` 的 `readSession()`，它只碰
 * `Taro.getStorageSync`，所以 mock 一个带存储的 Taro 就够，不用 mock `@/lib/session` 本身。
 */

const SESSION_KEY = 'fish:session'
const SNAPSHOT_KEY = 'fish:home.feed-snapshot:ALL'
const disk = new Map<string, unknown>()

/** 模拟微信存储读失败（配额满、存储被清理）—— 只影响读取，写入照常 */
let readFails = false

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => {
      if (readFails) throw new Error('storage read failed')
      return disk.get(key) ?? ''
    },
    setStorageSync: (key: string, value: unknown) => {
      disk.set(key, value)
    },
    removeStorageSync: (key: string) => {
      disk.delete(key)
    },
  },
}))

const { homeFeedCache, homeFeedViewer } = await import('../src/features/home/feed-cache')

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
    sellerId: 'seller-1',
    seller: null,
    views: 3,
    wants: 1,
    createdHoursAgo: 2,
    createdAt: '2026-11-07T00:00:00.000Z',
  }
}

function signIn(token: string): void {
  disk.set(SESSION_KEY, `fish_session=${token}`)
}

function signOut(): void {
  disk.delete(SESSION_KEY)
}

test('没有会话 → 匿名桶', () => {
  signOut()
  expect(homeFeedViewer()).toBe('anon')
})

test('同一段会话 cookie 指纹稳定，换 token 就变', () => {
  signIn('aaa')
  const first = homeFeedViewer()
  expect(first).toMatch(/^auth:[0-9a-f]{8}$/)
  expect(homeFeedViewer()).toBe(first)

  signIn('bbb')
  const second = homeFeedViewer()
  expect(second).toMatch(/^auth:[0-9a-f]{8}$/)
  expect(second).not.toBe(first)
})

test('默认身份接线：登录态写的快照，退出后读不到（AC④ 的生产实现）', () => {
  signIn('aaa')
  expect(homeFeedCache.write('ALL', [listing('a'), listing('b')], homeFeedCache.viewer())).toBe(
    true,
  )
  expect(homeFeedCache.read('ALL')?.items.map((item) => item.id)).toEqual(['a', 'b'])

  // 退出：同一台设备上「现在是谁」变成匿名 —— 上一身份的列表不许再上屏，也不许留在盘上
  signOut()
  expect(homeFeedCache.read('ALL')).toBeNull()
  expect(disk.has(SNAPSHOT_KEY)).toBe(false)
})

test('存储读失败 → 退成匿名桶，不抛错打断进页', () => {
  signIn('aaa')
  readFails = true
  try {
    expect(homeFeedViewer()).toBe('anon')
    expect(homeFeedCache.read('ALL')).toBeNull()
  } finally {
    readFails = false
  }
})
