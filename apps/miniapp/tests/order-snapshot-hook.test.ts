import { beforeEach, expect, mock, test } from 'bun:test'
import { transactionDtoSchema } from '@fish/contracts/transactions/schema'
import { encodePublicId } from '@fish/shared/public-id'
import type { LoadedOrders } from '../src/features/fetchers'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected test value')
  return value
}

// Minimal hook host: rerender render-phase state adjustments without adding a renderer dependency.
let slots: unknown[] = []
let cursor = 0
let dirty = false
mock.module('react', () => ({
  useState: <T>(initial: T) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = initial
    return [
      slots[index],
      (next: T) => {
        slots[index] = next
        dirty = true
      },
    ]
  },
  useRef: <T>(initial: T) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useCallback: <T>(callback: T) => callback,
  useEffect: () => {},
}))
const disk = new Map<string, string>()
mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => disk.get(key),
    setStorageSync: (key: string, value: string) => disk.set(key, value),
    removeStorageSync: (key: string) => disk.delete(key),
  },
}))
let fetchOrders: () => Promise<LoadedOrders>
mock.module('@/features/fetchers', () => ({ loadOrders: () => fetchOrders() }))
const { listSnapshots: cache } = await import('../src/features/list-snapshots')
const { useOrderList } = await import('../src/features/transaction/useOrderList')
const buyer = encodePublicId('usr', '01930000-0000-7000-8000-00000000000a')
const seller = encodePublicId('usr', '01930000-0000-7000-8000-00000000000b')
const dto = transactionDtoSchema.parse({
  id: encodePublicId('txn', '01930000-0000-7000-8000-000000000051'),
  conversationId: encodePublicId('cnv', '01930000-0000-7000-8000-000000000044'),
  listingId: encodePublicId('lst', '01930000-0000-7000-8000-000000000014'),
  buyerId: buyer,
  sellerId: seller,
  role: 'buyer',
  listing: {
    id: encodePublicId('lst', '01930000-0000-7000-8000-000000000014'),
    title: 'Lamp',
    priceCents: 3000,
    status: 'RESERVED',
    coverUrl: null,
  },
  counterpart: { id: seller, nickname: 'Seller', avatarUrl: null },
  amountCents: 2800,
  status: 'PENDING_MEETUP',
  buyerConfirmedAt: null,
  sellerConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-09-14T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:00.000Z',
})
function render(account: string | null = buyer, role: 'buyer' | 'seller' = 'buyer') {
  for (let attempt = 0; attempt < 5; attempt++) {
    cursor = 0
    dirty = false
    // biome-ignore lint/correctness/useHookAtTopLevel: this loop is the mocked hook host, not a component
    const value = useOrderList(role, account)
    if (!dirty) return value
  }
  throw new Error('render did not settle')
}
beforeEach(() => {
  slots = []
  cache.syncAccount(null)
  cache.syncAccount(buyer)
  cache.write(required(cache.begin('buyer', buyer)), { items: [dto], truncated: true })
})

test('real cached rows hydrate before refresh; failure retains rows and truncation; retry replaces', async () => {
  let page = render()
  expect(page.items.map((item) => item.id)).toEqual([dto.id])
  expect(page.loading).toBe(false)
  fetchOrders = async () => ({ items: [], truncated: false, failureKind: 'network' })
  await page.reload()
  page = render()
  expect(page.items).toHaveLength(1)
  expect(page.truncated).toBe(true)
  expect(page.failureKind).toBe('network')
  expect(cache.read('buyer', buyer)?.items).toHaveLength(1)
  fetchOrders = async () => ({
    items: [],
    truncated: false,
    failureKind: null,
    snapshot: { items: [], truncated: false },
  })
  await page.reload()
  expect(render().items).toEqual([])
  expect(cache.read('buyer', buyer)?.items).toEqual([])
})

test('late read after a mutation neither repaints nor persists its stale rows', async () => {
  const resolves: Array<(result: LoadedOrders) => void> = []
  fetchOrders = () =>
    new Promise((done) => {
      resolves.push(done)
    })
  const page = render()
  const stale = page.reload()
  const finish = cache.startMutation(['buyer'])
  const during = render().reload()
  required(resolves[1])({
    items: page.items,
    truncated: true,
    failureKind: null,
    snapshot: { items: [dto], truncated: true },
  })
  await Bun.sleep(0)
  expect(render().items).toEqual([])
  expect(render().failureKind).toBeNull()
  expect(cache.read('buyer', buyer)).toBeNull()
  finish()
  await Bun.sleep(0)
  required(resolves[2])({
    items: [],
    truncated: false,
    failureKind: null,
    snapshot: { items: [], truncated: false },
  })
  await during
  expect(render().items).toEqual([])
  expect(cache.read('buyer', buyer)?.items).toEqual([])
  required(resolves[0])({
    items: [],
    truncated: false,
    failureKind: null,
    snapshot: { items: [], truncated: false },
  })
  await stale
  expect(render().items).toEqual([])
})

test('return refresh shows loading when a mutation invalidated the list', async () => {
  const cached = render()
  const finish = cache.startMutation(['buyer'])
  finish()
  let resolve: (result: LoadedOrders) => void = () => {}
  fetchOrders = () =>
    new Promise((done) => {
      resolve = done
    })
  const pending = cached.reload()
  const refreshing = render()
  expect(refreshing.items).toEqual([])
  expect(refreshing.loading).toBe(true)
  resolve({
    items: [],
    truncated: false,
    failureKind: null,
    snapshot: { items: [], truncated: false },
  })
  await pending
  expect(render().loading).toBe(false)
})

test('read fenced by a local write is retried once it settles, never reported as a server failure', async () => {
  let calls = 0
  fetchOrders = async () => {
    calls += 1
    return {
      items: [],
      truncated: false,
      failureKind: null,
      snapshot: { items: [], truncated: false },
    }
  }
  const cached = render()
  const finish = cache.startMutation(['buyer'])
  // Issued while the write is in flight: the mutation fence retires this read.
  const pending = cached.reload()
  expect(render().failureKind).toBeNull()
  finish()
  await pending
  const recovered = render()
  expect(calls).toBe(2)
  expect(recovered.failureKind).toBeNull()
  expect(recovered.loading).toBe(false)
  expect(recovered.items).toEqual([])
  expect(cache.read('buyer', buyer)?.items).toEqual([])
})

test('first screen fenced by a local write leaves the skeleton, then loads instead of failing', async () => {
  let calls = 0
  fetchOrders = async () => {
    calls += 1
    return {
      items: [],
      truncated: false,
      failureKind: null,
      snapshot: { items: [], truncated: false },
    }
  }
  // No seller snapshot on disk: this really is a first screen, so it starts on the skeleton.
  const first = render(buyer, 'seller')
  expect(first.items).toEqual([])
  expect(first.loading).toBe(true)
  const finish = cache.startMutation(['seller'])
  const pending = first.reload()
  finish()
  await pending
  const after = render(buyer, 'seller')
  expect(calls).toBe(2)
  expect(after.failureKind).toBeNull()
  expect(after.loading).toBe(false)
})

test('account and role changes synchronously remove the previous view', () => {
  expect(render().items).toHaveLength(1)
  expect(render(buyer, 'seller').items).toEqual([])
  cache.syncAccount(seller)
  expect(render(seller).items).toEqual([])
  cache.syncAccount(null)
  expect(render(null).items).toEqual([])
})

test('old account success cannot populate new account after a switch', async () => {
  let resolve: (result: LoadedOrders) => void = () => {}
  fetchOrders = () =>
    new Promise((done) => {
      resolve = done
    })
  const page = render()
  const pending = page.reload()
  cache.syncAccount(seller)
  render(seller)
  resolve({
    items: page.items,
    truncated: false,
    failureKind: null,
    snapshot: { items: [dto], truncated: false },
  })
  await pending
  expect(render(seller).items).toEqual([])
  expect(cache.read('buyer', seller)).toBeNull()
})
