import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { encodeFollowingCursor } from './cursor'
import { createFollowService, FollowServiceError } from './service'
import type { FollowingCursor, FollowingRow, FollowingTotals, FollowStore } from './store'

const VIEWER = '01930000-0000-7000-8000-00000000000a'
const TARGET = '01930000-0000-7000-8000-00000000000b'
const THIRD = '01930000-0000-7000-8000-00000000000c'
const TARGET_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, TARGET)

function row(id: string, overrides: Partial<FollowingRow> = {}): FollowingRow {
  return {
    id,
    nickname: '林一',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    mutual: false,
    followedAtCursor: '2026-09-10T02:00:00.000000Z',
    ...overrides,
  }
}

class MemoryStore implements FollowStore {
  users = new Set<string>([VIEWER, TARGET, THIRD])
  /** 已建立的有向边（`follower → following`）。 */
  edges = new Set<string>()
  rows: FollowingRow[] = []
  totalsRow: FollowingTotals = { total: 0, mutualTotal: 0 }
  listCalls: { followerId: string; limit: number; cursor: FollowingCursor | null }[] = []
  followCalls: [string, string][] = []
  unfollowCalls: [string, string][] = []

  private key(a: string, b: string) {
    return `${a}>${b}`
  }

  async userExists(userId: string) {
    return this.users.has(userId)
  }
  async listFollowing(followerId: string, limit: number, cursor: FollowingCursor | null) {
    this.listCalls.push({ followerId, limit, cursor })
    // store 契约：多取一行（limit + 1），由 service 判断还有没有下一页
    return this.rows.slice(0, limit + 1)
  }
  async totals() {
    return this.totalsRow
  }
  async isFollowing(followerId: string, followingId: string) {
    return this.edges.has(this.key(followerId, followingId))
  }
  async follow(followerId: string, followingId: string) {
    this.followCalls.push([followerId, followingId])
    this.edges.add(this.key(followerId, followingId))
  }
  async unfollow(followerId: string, followingId: string) {
    this.unfollowCalls.push([followerId, followingId])
    this.edges.delete(this.key(followerId, followingId))
  }
}

describe('follow service: listMyFollowing', () => {
  test('drops the look-ahead row and derives nextCursor from the last returned row', async () => {
    const store = new MemoryStore()
    store.rows = [row(TARGET), row(THIRD), row('01930000-0000-7000-8000-00000000000d')]
    store.totalsRow = { total: 9, mutualTotal: 2 }
    const service = createFollowService({ store })

    const page = await service.listMyFollowing(VIEWER, { limit: 2 })

    expect(page.items).toHaveLength(2)
    expect(page.items.map((item) => item.id)).toEqual([
      TARGET_PUBLIC,
      encodePublicId(PUBLIC_ID_PREFIX.user, THIRD),
    ])
    // 全量计数来自 store.totals，不是这一页的长度
    expect(page.total).toBe(9)
    expect(page.mutualTotal).toBe(2)
    expect(page.nextCursor).not.toBeNull()
  })

  test('returns nextCursor=null when the whole list fits in one page', async () => {
    const store = new MemoryStore()
    store.rows = [row(TARGET)]
    store.totalsRow = { total: 1, mutualTotal: 0 }
    const service = createFollowService({ store })

    const page = await service.listMyFollowing(VIEWER, { limit: 20 })

    expect(page.nextCursor).toBeNull()
  })

  test('decodes a valid cursor before hitting the store, and rejects a bad one with 422', async () => {
    const store = new MemoryStore()
    store.totalsRow = { total: 0, mutualTotal: 0 }
    const service = createFollowService({ store })
    const cursor = encodeFollowingCursor({
      createdAt: '2026-09-10T02:00:00.000000Z',
      id: TARGET,
    })

    await service.listMyFollowing(VIEWER, { limit: 20, cursor })
    expect(store.listCalls[0]?.cursor).toEqual({
      createdAt: '2026-09-10T02:00:00.000000Z',
      id: TARGET,
    })

    const error = await service
      .listMyFollowing(VIEWER, { limit: 20, cursor: 'not-base64-json' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FollowServiceError)
    expect((error as FollowServiceError).status).toBe(422)
    expect((error as FollowServiceError).code).toBe('VALIDATION_FAILED')
    // 坏游标不打 store
    expect(store.listCalls).toHaveLength(1)
  })

  test('projects exactly the five public fields (no private columns leak)', async () => {
    const store = new MemoryStore()
    store.rows = [row(TARGET, { mutual: true })]
    store.totalsRow = { total: 1, mutualTotal: 1 }
    const service = createFollowService({ store })

    const page = await service.listMyFollowing(VIEWER, { limit: 20 })

    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'mutual',
      'nickname',
    ])
  })
})

describe('follow service: state / follow / unfollow', () => {
  test('getState: unknown target → 404, otherwise reflects both directions', async () => {
    const store = new MemoryStore()
    const service = createFollowService({ store })

    const missing = await service
      .getState(VIEWER, '01930000-0000-7000-8000-0000000000ff')
      .catch((e: unknown) => e)
    expect((missing as FollowServiceError).status).toBe(404)
    expect((missing as FollowServiceError).code).toBe('USER_NOT_FOUND')

    expect(await service.getState(VIEWER, TARGET)).toEqual({ following: false, mutual: false })

    store.edges.add(`${VIEWER}>${TARGET}`)
    expect(await service.getState(VIEWER, TARGET)).toEqual({ following: true, mutual: false })

    store.edges.add(`${TARGET}>${VIEWER}`)
    expect(await service.getState(VIEWER, TARGET)).toEqual({ following: true, mutual: true })
  })

  test('follow is idempotent and computes mutual from the reverse edge', async () => {
    const store = new MemoryStore()
    const service = createFollowService({ store })

    expect(await service.follow(VIEWER, TARGET)).toEqual({ following: true, mutual: false })
    // 重复关注仍 200，且 store 再走一次 ON CONFLICT DO NOTHING
    expect(await service.follow(VIEWER, TARGET)).toEqual({ following: true, mutual: false })
    expect(store.followCalls).toHaveLength(2)

    store.edges.add(`${TARGET}>${VIEWER}`)
    expect(await service.follow(VIEWER, TARGET)).toEqual({ following: true, mutual: true })
  })

  test('follow/unfollow self → 422 CANNOT_FOLLOW_SELF without touching the store', async () => {
    const store = new MemoryStore()
    const service = createFollowService({ store })

    for (const op of [service.follow, service.unfollow]) {
      const error = await op.call(service, VIEWER, VIEWER).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FollowServiceError)
      expect((error as FollowServiceError).status).toBe(422)
      expect((error as FollowServiceError).code).toBe('CANNOT_FOLLOW_SELF')
    }
    expect(store.followCalls).toHaveLength(0)
    expect(store.unfollowCalls).toHaveLength(0)
  })

  test('follow an unknown user → 404, and the write does not happen', async () => {
    const store = new MemoryStore()
    const service = createFollowService({ store })

    const error = await service
      .follow(VIEWER, '01930000-0000-7000-8000-0000000000ff')
      .catch((e: unknown) => e)
    expect((error as FollowServiceError).status).toBe(404)
    expect(store.followCalls).toHaveLength(0)
  })

  test('unfollow always returns {following:false, mutual:false}', async () => {
    const store = new MemoryStore()
    store.edges.add(`${VIEWER}>${TARGET}`)
    store.edges.add(`${TARGET}>${VIEWER}`)
    const service = createFollowService({ store })

    expect(await service.unfollow(VIEWER, TARGET)).toEqual({ following: false, mutual: false })
    expect(store.unfollowCalls).toEqual([[VIEWER, TARGET]])
  })
})
