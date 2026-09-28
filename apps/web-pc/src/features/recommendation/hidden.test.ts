import { beforeEach, describe, expect, test } from 'bun:test'
import { hideListingLocally, readHiddenListingIds } from './hidden'

const HIDDEN_STORAGE_KEY = 'fish.recommendation.hiddenListings'

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
Object.assign(globalThis, { window: { localStorage: localStorageStub } })

beforeEach(() => {
  localStorageStub.clear()
})

describe('hidden listings', () => {
  test('隐藏后进入本地名单', () => {
    hideListingLocally('lst_01jc000000e00800000000001a')

    expect([...readHiddenListingIds()]).toEqual(['lst_01jc000000e00800000000001a'])
  })

  test('重复隐藏不产生重复项', () => {
    hideListingLocally('lst_01jc000000e00800000000001a')
    hideListingLocally('lst_01jc000000e00800000000001a')

    expect([...readHiddenListingIds()]).toEqual(['lst_01jc000000e00800000000001a'])
  })

  test('多个商品各自独立', () => {
    hideListingLocally('lst_01jc000000e00800000000001a')
    hideListingLocally('lst_01jc000000e00800000000001b')

    expect([...readHiddenListingIds()]).toEqual([
      'lst_01jc000000e00800000000001a',
      'lst_01jc000000e00800000000001b',
    ])
  })

  test('名单过期后不再过滤', () => {
    localStorageStub.setItem(
      HIDDEN_STORAGE_KEY,
      JSON.stringify({ ids: ['lst_01jc000000e00800000000001a'], expiresAt: Date.now() - 1 }),
    )

    expect(readHiddenListingIds().size).toBe(0)
  })
})
