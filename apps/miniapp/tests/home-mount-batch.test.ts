import { describe, expect, test } from 'bun:test'
import type { MockListing } from '../src/mock/types'
import {
  INITIAL_MOUNT_COUNT,
  MOUNT_BATCH_SIZE,
  mountPrefix,
  nextMountCount,
} from '../src/pages/home/mount-batch'

/**
 * 首屏分批挂载的窗口计算（#595）。
 *
 * 首页把整批 feed 留在 `items`，只挂前缀：首屏不挂 50 张，滚动触底按批增量，
 * 全部结果仍能滚到。这里锁住三条容易静默坏掉的规矩：
 * 隐藏卡不能吃掉可见名额（否则首屏不满、滚不动、后面永远挂不上）、
 * 前缀必须保序（两列交错不能重排）、触底只增不减且封顶。
 */

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

const feed = Array.from({ length: 50 }, (_, index) => listing(`lst-${index + 1}`))

describe('mountPrefix —— 只挂够覆盖首屏的那一段', () => {
  test('初始窗口远小于整批 feed（不是一上来就挂 50 张）', () => {
    const mounted = mountPrefix(feed, [], INITIAL_MOUNT_COUNT)
    expect(mounted).toHaveLength(INITIAL_MOUNT_COUNT)
    expect(mounted.length).toBeLessThan(feed.length)
  })

  test('保序：前缀就是原列表的头几项，不排序、不重排（两列交错不能变）', () => {
    const mounted = mountPrefix(feed, [], 6)
    expect(mounted.map((item) => item.id)).toEqual([
      'lst-1',
      'lst-2',
      'lst-3',
      'lst-4',
      'lst-5',
      'lst-6',
    ])
  })

  test('隐藏卡占位但不吃名额：可见数够、奇偶位不乱', () => {
    // 前 3 张里隐藏 2 张：可见名额 4 就得一路取到第 6 张
    const hidden = ['lst-1', 'lst-2']
    const mounted = mountPrefix(feed, hidden, 4)
    expect(mounted.map((item) => item.id)).toEqual([
      'lst-1',
      'lst-2',
      'lst-3',
      'lst-4',
      'lst-5',
      'lst-6',
    ])
    const visible = mounted.filter((item) => !hidden.includes(item.id))
    expect(visible).toHaveLength(4)
  })

  test('隐藏卡全在前段时不会把后面的卡饿死', () => {
    const hidden = feed.slice(0, 8).map((item) => item.id)
    const mounted = mountPrefix(feed, hidden, 4)
    // 前 8 张全隐藏 → 还要再取 4 张可见的
    expect(mounted).toHaveLength(12)
  })

  test('总数不够时给多少算多少，不补空、不抛错', () => {
    const few = feed.slice(0, 3)
    expect(mountPrefix(few, [], 10)).toHaveLength(3)
    expect(mountPrefix([], [], 10)).toEqual([])
  })

  test('窗口大于总数时就是全量（全部结果可达）', () => {
    expect(mountPrefix(feed, [], 1000)).toHaveLength(feed.length)
  })

  test('名单里混着不属于这批 feed 的 id：不影响前缀，只跳过匹配的那几张', () => {
    const hidden = [feed[1]!.id, 'lst_other_page', feed[3]!.id]
    const prefix = mountPrefix(feed, hidden, 4)
    // 两张命中的隐藏卡占住原位置，其余补到 4 张可见
    expect(prefix.map((item) => item.id)).toEqual([
      feed[0]!.id,
      feed[1]!.id,
      feed[2]!.id,
      feed[3]!.id,
      feed[4]!.id,
      feed[5]!.id,
    ])
  })
})

describe('nextMountCount —— 触底只增不减、封顶', () => {
  test('每次触底按批增量', () => {
    expect(nextMountCount(10, 50)).toBe(10 + MOUNT_BATCH_SIZE)
  })

  test('最后一跳截到总数，不会超出（否则"已全挂"永远判不出来）', () => {
    expect(nextMountCount(49, 50)).toBe(50)
    expect(nextMountCount(10, 18)).toBe(18)
    expect(nextMountCount(15, 18)).toBe(18)
  })

  test('已经全挂完时返回原值（setState 因此 bail，不反复渲染）', () => {
    expect(nextMountCount(50, 50)).toBe(50)
    expect(nextMountCount(60, 50)).toBe(60)
  })

  test('空列表不触发增量', () => {
    expect(nextMountCount(10, 0)).toBe(10)
  })
})
