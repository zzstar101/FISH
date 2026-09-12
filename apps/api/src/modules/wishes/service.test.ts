import { describe, expect, test } from 'bun:test'
import type { WishCreateInput, WishStatus, WishUpdateInput } from '@fish/contracts/wishes/schema'
import { createWishService, WishServiceError } from './service'
import type { EditableWishFields, PoolRow, WishRow, WishStore } from './store'

const userA = 'user-a'
const userB = 'user-b'

class MemoryWishStore implements WishStore {
  rows: WishRow[] = []

  async createOrGetRecent(row: WishRow, activeLimit: number, createdAfter: Date) {
    const duplicate = this.rows.find(
      (item) =>
        item.user_id === row.user_id &&
        item.keyword === row.keyword &&
        item.category === row.category &&
        item.status === 'ACTIVE' &&
        new Date(item.created_at) > createdAfter,
    )
    if (duplicate) return { kind: 'duplicate' as const, row: { ...duplicate } }
    if (
      this.rows.filter((item) => item.user_id === row.user_id && item.status === 'ACTIVE').length >=
      activeLimit
    ) {
      return { kind: 'active-limit' as const }
    }
    this.rows.push({ ...row })
    return { kind: 'created' as const, row: { ...row } }
  }

  async findById(id: string) {
    const row = this.rows.find((item) => item.id === id)
    return row ? { ...row } : null
  }

  async listByUser(userId: string, filter: { status?: WishStatus; limit: number; offset: number }) {
    const matched = this.rows
      .filter((row) => row.user_id === userId && (!filter.status || row.status === filter.status))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return {
      rows: matched.slice(filter.offset, filter.offset + filter.limit),
      total: matched.length,
    }
  }

  async update(id: string, fields: EditableWishFields, updatedAt: Date) {
    const row = this.rows.find((item) => item.id === id && item.status === 'ACTIVE')
    if (!row) return null
    Object.assign(row, {
      ...(fields.keyword === undefined ? {} : { keyword: fields.keyword }),
      ...(fields.category === undefined ? {} : { category: fields.category }),
      ...(fields.budgetMinCents === undefined ? {} : { budget_min_cents: fields.budgetMinCents }),
      ...(fields.budgetMaxCents === undefined ? {} : { budget_max_cents: fields.budgetMaxCents }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.acceptSimilar === undefined ? {} : { accept_similar: fields.acceptSimilar }),
      updated_at: updatedAt,
    })
    return { ...row }
  }

  async updateStatusIfActive(id: string, status: 'CLOSED' | 'FULFILLED', updatedAt: Date) {
    const row = this.rows.find((item) => item.id === id && item.status === 'ACTIVE')
    if (!row) return null
    row.status = status
    row.updated_at = updatedAt
    return { ...row }
  }

  async aggregatePool(minCount: number, limit: number): Promise<PoolRow[]> {
    const groups = new Map<string, WishRow[]>()
    for (const row of this.rows.filter((item) => item.status === 'ACTIVE')) {
      const key = `${row.keyword}:${row.category}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    return [...groups.values()]
      .filter((rows) => rows.length >= minCount)
      .map((rows) => ({
        keyword: rows[0]?.keyword ?? '',
        category: rows[0]?.category ?? 'other',
        want_count: rows.length,
        median_budget_cents:
          rows.map((row) => row.budget_max_cents).sort((a, b) => a - b)[
            Math.floor(rows.length / 2)
          ] ?? 0,
      }))
      .slice(0, limit)
  }
}

const createInput: WishCreateInput = {
  keyword: '机械键盘',
  category: 'electronics',
  budgetMinCents: 10000,
  budgetMaxCents: 20000,
  acceptSimilar: true,
}

function setup(enqueue: (id: string) => Promise<void> = async () => undefined) {
  const store = new MemoryWishStore()
  const queued: string[] = []
  const service = createWishService({
    store,
    matchQueue: {
      enqueue: async (id) => {
        queued.push(id)
        await enqueue(id)
      },
    },
  })
  return { store, queued, service }
}

describe('wish service', () => {
  test('creates a wish and retries match enqueue when a duplicate submission is replayed', async () => {
    const { queued, service } = setup()
    const first = await service.createWish(userA, createInput)
    const second = await service.createWish(userA, createInput)

    expect(second.id).toBe(first.id)
    expect(queued).toEqual([first.id, first.id])
  })

  test('allows a retry to re-enqueue a record after a prior enqueue failure', async () => {
    let attempts = 0
    const { queued, service } = setup(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('queue unavailable')
    })

    await expect(service.createWish(userA, createInput)).rejects.toThrow('queue unavailable')
    await expect(service.createWish(userA, createInput)).resolves.toMatchObject({
      keyword: '机械键盘',
    })
    expect(queued).toHaveLength(2)
  })

  test('enforces the ten ACTIVE wish limit', async () => {
    const { service } = setup()
    for (let i = 0; i < 10; i += 1) {
      await service.createWish(userA, { ...createInput, keyword: `键盘${i}` })
    }
    await expect(
      service.createWish(userA, { ...createInput, keyword: '鼠标' }),
    ).rejects.toMatchObject(new WishServiceError(409, 'ACTIVE 愿望最多 10 条'))
  })

  test('prevents other users from viewing or changing a wish', async () => {
    const { service } = setup()
    const wish = await service.createWish(userA, createInput)
    await expect(service.getWish(userB, wish.id)).rejects.toMatchObject(
      new WishServiceError(403, '无权查看该愿望'),
    )
    await expect(service.closeWish(userB, wish.id)).rejects.toMatchObject(
      new WishServiceError(403, '无权操作该愿望'),
    )
  })

  test('allows ACTIVE to CLOSED/FULFILLED and makes repeated transitions idempotent', async () => {
    const { service } = setup()
    const closed = await service.createWish(userA, createInput)
    expect((await service.closeWish(userA, closed.id)).status).toBe('CLOSED')
    expect((await service.closeWish(userA, closed.id)).status).toBe('CLOSED')

    const fulfilled = await service.createWish(userA, { ...createInput, keyword: '耳机' })
    expect((await service.fulfillWish(userA, fulfilled.id)).status).toBe('FULFILLED')
    await expect(service.closeWish(userA, fulfilled.id)).rejects.toMatchObject(
      new WishServiceError(409, '愿望已经处于终态'),
    )
  })

  test('validates a partial update against the existing budget range', async () => {
    const { service } = setup()
    const wish = await service.createWish(userA, createInput)
    await expect(service.updateWish(userA, wish.id, { budgetMinCents: 30000 })).rejects.toThrow(
      'budgetMaxCents 必须 ≥ budgetMinCents',
    )
    const updated = await service.updateWish(userA, wish.id, {
      keyword: '  蓝牙耳机  ',
      description: null,
    } as WishUpdateInput)
    expect(updated.keyword).toBe('蓝牙耳机')
    expect(updated.description).toBeNull()
  })

  test('invalidates the pool cache even when match enqueue fails', async () => {
    let failEnqueue = false
    const { service } = setup(async () => {
      if (failEnqueue) throw new Error('queue unavailable')
    })
    for (let i = 0; i < 3; i += 1) await service.createWish(`user-${i}`, createInput)
    expect((await service.getPool()).items[0]?.wantCount).toBe(3)

    failEnqueue = true
    await expect(service.createWish('user-4', createInput)).rejects.toThrow('queue unavailable')

    expect((await service.getPool()).items[0]?.wantCount).toBe(4)
  })

  test('returns only k-anonymous active groups and caches the pool', async () => {
    const { store, service } = setup()
    for (let i = 0; i < 3; i += 1) await service.createWish(`user-${i}`, createInput)
    await service.createWish('user-unique', { ...createInput, keyword: '独有商品' })

    expect((await service.getPool()).items).toHaveLength(1)
    const original = store.aggregatePool.bind(store)
    let calls = 0
    store.aggregatePool = async (...args: Parameters<WishStore['aggregatePool']>) => {
      calls += 1
      return original(...args)
    }
    await service.getPool()
    expect(calls).toBe(0)
  })
})
