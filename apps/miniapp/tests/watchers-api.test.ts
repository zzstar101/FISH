import { expect, mock, test } from 'bun:test'

const listingId = '01990000-0000-7000-8000-0000000000b1'
const calls: { path: string; query: unknown }[] = []
let payload: unknown = { items: [], total: 0, nextCursor: null }

mock.module('@/lib/request', () => ({
  apiRequest: async (path: string, options: { query: unknown }) => {
    calls.push({ path, query: options.query })
    return payload
  },
}))

const { fetchChatWatchers } = await import('@/features/watchers/api')

test('调用卖家专属路由、不解析不透明游标，保留不受分页影响的总人数', async () => {
  calls.length = 0
  payload = {
    items: [
      {
        user: {
          id: '01990000-0000-7000-8000-0000000000a1',
          nickname: '同学甲',
          avatarUrl: null,
          authStatus: 'VERIFIED',
        },
        startedAt: '2026-09-12T09:00:00.123Z',
      },
    ],
    total: 18,
    nextCursor: 'opaque-next',
  }
  const first = await fetchChatWatchers(listingId)
  expect(first.total).toBe(18)
  expect(first.items).toHaveLength(1)
  const second = await fetchChatWatchers(listingId, first.nextCursor ?? undefined)
  expect(second.nextCursor).toBe('opaque-next')
  expect(calls).toEqual([
    { path: `/listings/${listingId}/watchers`, query: { limit: 20, cursor: undefined } },
    { path: `/listings/${listingId}/watchers`, query: { limit: 20, cursor: 'opaque-next' } },
  ])
})

test('字段不符时拒绝渲染，不把伪造的私有字段交给页面', async () => {
  payload = {
    items: [
      {
        user: { id: 'invalid', nickname: '甲', avatarUrl: null, authStatus: 'VERIFIED' },
        startedAt: 'x',
      },
    ],
    total: 1,
    nextCursor: null,
  }
  await expect(fetchChatWatchers(listingId)).rejects.toThrow()
})
