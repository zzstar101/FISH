import { expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor } from './cursor'
import type { ConversationServiceError } from './service'
import { createChatWatchersService } from './watchers-service'

const listing = '01990000-0000-7000-8000-0000000000b1'
const seller = '01990000-0000-7000-8000-0000000000a2'
const buyer = '01990000-0000-7000-8000-0000000000a1'
const conv = '01990000-0000-7000-8000-0000000000c1'

test('只给卖家：非卖家与不存在商品不查询买家名单', async () => {
  let reads = 0
  const store = {
    findListingBrief: async (id: string) => (id === listing ? { id, sellerId: seller } : null),
    listChatWatchers: async () => {
      reads++
      return { rows: [], total: 0 }
    },
  }
  const service = createChatWatchersService(store)
  await expect(service.list(buyer, listing, { limit: 20 })).rejects.toMatchObject({
    status: 403,
    code: 'NOT_LISTING_OWNER',
  } satisfies Partial<ConversationServiceError>)
  await expect(service.list(seller, crypto.randomUUID(), { limit: 20 })).rejects.toMatchObject({
    status: 404,
    code: 'LISTING_NOT_FOUND',
  } satisfies Partial<ConversationServiceError>)
  expect(reads).toBe(0)
})

test('人数来自全部会话而非当前页；只暴露最小买家字段，游标取创建时间', async () => {
  const service = createChatWatchersService({
    findListingBrief: async () => ({ id: listing, sellerId: seller }),
    listChatWatchers: async () => ({
      total: 18,
      rows: [
        {
          conversationId: conv,
          startedAt: '2026-09-12T09:00:00.123Z',
          startedAtCursor: '2026-09-12T09:00:00.123456Z',
          userId: buyer,
          nickname: '同学甲',
          avatarUrl: 'not-a-url',
          authStatus: 'VERIFIED' as const,
        },
        {
          conversationId: crypto.randomUUID(),
          startedAt: '2026-09-12T08:00:00.000Z',
          startedAtCursor: '2026-09-12T08:00:00.000000Z',
          userId: crypto.randomUUID(),
          nickname: '同学乙',
          avatarUrl: null,
          authStatus: 'UNVERIFIED' as const,
        },
      ],
    }),
  })
  const response = await service.list(seller, listing, { limit: 1 })
  expect(response.total).toBe(18)
  expect(response.items).toEqual([
    {
      user: {
        id: encodePublicId(PUBLIC_ID_PREFIX.user, buyer),
        nickname: '同学甲',
        avatarUrl: null,
        authStatus: 'VERIFIED',
      },
      startedAt: '2026-09-12T09:00:00.123Z',
    },
  ])
  expect(decodeCursor(response.nextCursor ?? '')).toEqual({
    sortKey: '2026-09-12T09:00:00.123456Z',
    id: conv,
  })
})

test('伪造游标返回 422，不打数据库', async () => {
  const service = createChatWatchersService({
    findListingBrief: async () => ({ id: listing, sellerId: seller }),
    listChatWatchers: async () => {
      throw new Error('不应读取')
    },
  })
  await expect(
    service.list(seller, listing, { limit: 20, cursor: 'broken' }),
  ).rejects.toMatchObject({ status: 422 })
})
