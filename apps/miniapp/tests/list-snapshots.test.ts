import { expect, mock, test } from 'bun:test'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected test value')
  return value
}

mock.module('@tarojs/taro', () => ({ default: {} }))
const { createListSnapshots, SNAPSHOT_TTL_MS, SNAPSHOT_MAX_BYTES } = await import(
  '../src/features/list-snapshots'
)

function fixture() {
  const disk = new Map<string, unknown>()
  let now = 1_000_000
  const storage = {
    get: (key: string) => disk.get(key),
    set: (key: string, value: string) => {
      disk.set(key, value)
    },
    remove: (key: string) => {
      disk.delete(key)
    },
  }
  const cache = createListSnapshots(storage, () => now)
  cache.syncAccount('alice')
  return {
    cache,
    disk,
    storage,
    advance: (ms: number) => {
      now += ms
    },
    clock: () => now,
  }
}
const emptyOrders = { items: [], truncated: false }
const emptyFavorites = { items: [], total: 0 }

test('three isolated scopes survive process restart only after authoritative same-account sync', () => {
  const { cache, storage, disk, clock } = fixture()
  for (const scope of ['buyer', 'seller', 'favorites'] as const) {
    const ticket = cache.begin(scope, 'alice')
    expect(ticket).not.toBeNull()
    if (ticket) cache.write(ticket, scope === 'favorites' ? emptyFavorites : emptyOrders)
  }
  expect(disk.size).toBe(3)
  const restarted = createListSnapshots(storage, clock)
  expect(restarted.read('buyer', 'alice')).toBeNull()
  restarted.syncAccount('alice')
  expect(restarted.read('buyer', 'alice')).toEqual(emptyOrders)
  expect(restarted.read('favorites', 'alice')).toEqual(emptyFavorites)
  expect(restarted.read('seller', 'bob')).toBeNull()
  restarted.syncAccount('bob')
  expect(disk.size).toBe(0)
  expect(restarted.read('buyer', 'bob')).toBeNull()
})

test('latest request wins; mutation, logout and A→B→A retire all old tickets', () => {
  const { cache } = fixture()
  const first = required(cache.begin('buyer', 'alice'))
  const second = required(cache.begin('buyer', 'alice'))
  expect(cache.isCurrent(first)).toBe(false)
  expect(cache.write(first, emptyOrders)).toBe(false)
  expect(cache.write(second, emptyOrders)).toBe(true)
  const owner = cache.owner()
  cache.invalidate(owner, ['buyer'])
  expect(cache.read('buyer', 'alice')).toBeNull()
  expect(cache.write(second, emptyOrders)).toBe(false)
  const old = required(cache.begin('favorites', 'alice'))
  cache.syncAccount(null)
  cache.syncAccount('bob')
  cache.syncAccount('alice')
  expect(cache.write(old, emptyFavorites)).toBe(false)
  expect(cache.isOwner(owner)).toBe(false)
})

test('TTL, schema version, malformed data, future timestamps and byte bounds fail closed', () => {
  const f = fixture()
  const ticket = required(f.cache.begin('buyer', 'alice'))
  f.cache.write(ticket, emptyOrders)
  const key = required([...f.disk.keys()][0])
  const valid = String(f.disk.get(key))
  for (const corrupt of [
    '{',
    JSON.stringify({ ...JSON.parse(valid), version: 99 }),
    JSON.stringify({ ...JSON.parse(valid), savedAt: f.clock() + 1 }),
    JSON.stringify({ ...JSON.parse(valid), data: { items: [{}], truncated: false } }),
    'x'.repeat(SNAPSHOT_MAX_BYTES + 1),
  ]) {
    f.disk.set(key, corrupt)
    expect(f.cache.read('buyer', 'alice')).toBeNull()
  }
  f.disk.set(key, valid)
  f.advance(SNAPSHOT_TTL_MS)
  expect(f.cache.read('buyer', 'alice')).toBeNull()
})

test('storage read/write/remove failures do not escape or resurrect invalidated data', () => {
  const f = fixture()
  const ticket = required(f.cache.begin('favorites', 'alice'))
  f.cache.write(ticket, emptyFavorites)
  f.storage.remove = () => {
    throw new Error('storage unavailable')
  }
  f.storage.set = () => {
    throw new Error('quota')
  }
  expect(() => f.cache.invalidate(f.cache.owner(), ['favorites'])).not.toThrow()
  expect(f.cache.read('favorites', 'alice')).toBeNull()
  f.storage.get = () => {
    throw new Error('unavailable')
  }
  expect(() => f.cache.syncAccount(null)).not.toThrow()
  expect(f.cache.read('buyer', 'alice')).toBeNull()
})

test('failed refresh leaves last successful snapshot; successful empty response replaces it', async () => {
  const f = fixture()
  f.cache.write(required(f.cache.begin('buyer', 'alice')), { items: [], truncated: true })
  const refreshing = required(f.cache.begin('buyer', 'alice'))
  await Promise.reject(new Error('offline')).catch(() => {})
  expect(f.cache.read('buyer', 'alice')).toEqual({ items: [], truncated: true })
  f.cache.write(refreshing, emptyOrders)
  expect(f.cache.read('buyer', 'alice')).toEqual(emptyOrders)
})

// Contract parsers, not TypeScript assertions, are the storage trust boundary.
test('rejects excessive rows and strips unknown fields before persisting', () => {
  const f = fixture()
  const ticket = required(f.cache.begin('favorites', 'alice'))
  expect(f.cache.write(ticket, { items: Array(201).fill({}), total: 201 })).toBe(false)
  expect(f.cache.write(ticket, { ...emptyFavorites, cookie: 'secret' })).toBe(true)
  expect([...f.disk.values()].join()).not.toContain('secret')
})
