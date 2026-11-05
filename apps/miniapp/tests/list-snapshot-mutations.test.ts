import { beforeEach, expect, mock, test } from 'bun:test'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected test value')
  return value
}

const disk = new Map<string, string>()
mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => disk.get(key),
    setStorageSync: (key: string, value: string) => disk.set(key, value),
    removeStorageSync: (key: string) => disk.delete(key),
  },
}))
let request: () => Promise<unknown> = async () => ({})
mock.module('@/lib/request', () => ({ apiRequest: () => request(), isApiError: () => false }))
const { listSnapshots: cache } = await import('../src/features/list-snapshots')
const tx = await import('../src/features/transaction/api')
const listing = await import('../src/features/listing/api')
const favorites = await import('../src/features/favorites/api')
const scopes = ['buyer', 'seller', 'favorites'] as const
const seed = () => {
  for (const scope of scopes)
    cache.write(
      required(cache.begin(scope, 'alice')),
      scope === 'favorites' ? { items: [], total: 0 } : { items: [], truncated: false },
    )
}
beforeEach(() => {
  cache.syncAccount(null)
  cache.syncAccount('alice')
  seed()
})

for (const [name, run, affected] of [
  ['confirm', () => tx.confirmTransaction('id'), scopes],
  ['accept', () => tx.acceptTransaction('id', 1), scopes],
  ['cancel', () => tx.cancelTransaction('id'), scopes],
  ['update', () => listing.updateListing('id', { title: 'changed' }), scopes],
  ['offline', () => listing.offlineListing('id'), scopes],
  ['online', () => listing.onlineListing('id'), scopes],
  ['delete', () => listing.deleteListing('id'), scopes],
  ['favorite', () => favorites.setFavorite('id', true), ['favorites'] as const],
  ['unfavorite', () => favorites.setFavorite('id', false), ['favorites'] as const],
] as const) {
  test(`${name} fences reads before/during mutation and invalidates even malformed success`, async () => {
    const old = required(cache.begin(affected[0], 'alice'))
    let finish: (value: unknown) => void = () => {}
    request = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const mutation = run().catch(() => {})
    expect(cache.isCurrent(old)).toBe(false)
    const during = required(cache.begin(affected[0], 'alice'))
    expect(cache.isCurrent(during)).toBe(false)
    finish({}) // 2xx changed server state, even if DTO cannot be parsed
    await mutation
    expect(cache.isCurrent(during)).toBe(false)
    for (const scope of affected) expect(cache.read(scope, 'alice')).toBeNull()
    if (affected.length === 1) expect(cache.read('buyer', 'alice')).not.toBeNull()
  })
}

test('late old-account mutation does not invalidate new-account snapshots or pending reads', async () => {
  let finish: (value: unknown) => void = () => {}
  request = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const mutation = favorites.setFavorite('id', false)
  cache.syncAccount('bob')
  const ticket = required(cache.begin('favorites', 'bob'))
  expect(cache.write(ticket, { items: [], total: 0 })).toBe(true)
  finish({ favorited: false })
  await mutation
  expect(cache.isCurrent(ticket)).toBe(true)
  expect(cache.read('favorites', 'bob')).toEqual({ items: [], total: 0 })
})

test('batch only reports successful selected rows and invalidates partial success', async () => {
  let call = 0
  request = async () => {
    if (++call === 2) throw new Error('offline')
    return { favorited: false }
  }
  const result = await favorites.removeFavorites(['selected-ok', 'selected-failed'], () => true)
  expect([...result.removedIds]).toEqual(['selected-ok'])
  expect(result.failed).toEqual(['selected-failed'])
  expect(cache.read('favorites', 'alice')).toBeNull()
})

test('batch stops issuing writes when account changes or page unmounts', async () => {
  for (const switchAccount of [true, false]) {
    cache.syncAccount('alice')
    let mounted = true
    let calls = 0
    request = async () => {
      calls += 1
      if (switchAccount) cache.syncAccount('bob')
      else mounted = false
      return { favorited: false }
    }
    await favorites.removeFavorites(['first', 'never-send'], () => mounted)
    expect(calls).toBe(1)
  }
})

test('overlapping writes keep reads fenced until both settle, including failure', async () => {
  const finishers: Array<(value: unknown) => void> = []
  request = () =>
    new Promise((resolve) => {
      finishers.push(resolve)
    })
  const first = favorites.setFavorite('first', false).catch(() => {})
  const second = favorites.setFavorite('second', false).catch(() => {})
  required(finishers[0])({})
  await first
  expect(cache.isCurrent(required(cache.begin('favorites', 'alice')))).toBe(false)
  required(finishers[1])({ favorited: false })
  await second
  expect(cache.isCurrent(required(cache.begin('favorites', 'alice')))).toBe(true)
})
