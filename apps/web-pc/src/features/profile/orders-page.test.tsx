import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { routeTree } from '../../routeTree.gen'
import { profileKeys } from './queries'

const ME: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
  signature: null,
}

function order(id: string, title: string): TransactionDto {
  return {
    id,
    conversationId: 'cnv_01jc000000e00800000000001a',
    listingId: 'lst_01jc000000e00800000000000t',
    buyerId: ME.id,
    sellerId: 'usr_01jc000000e00800000000000b',
    role: 'buyer',
    listing: {
      id: 'lst_01jc000000e00800000000000t',
      title,
      priceCents: 12000,
      status: 'SOLD',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    amountCents: 11000,
    status: 'COMPLETED',
    buyerConfirmedAt: '2026-01-02T00:00:00.000Z',
    sellerConfirmedAt: '2026-01-02T00:00:00.000Z',
    completedAt: '2026-01-02T00:00:00.000Z',
    cancelledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
}

/**
 * #446：订单列表转 infinite 翻页。真路由 + 预置缓存渲染，锁三件事：
 * 两页订单都渲染、末页无游标不给「加载更多」、还有下一页时给入口。
 */
async function renderOrders(pages: TransactionDto[][], { lastPageHasNext = false } = {}) {
  const router = createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: ['/pc/orders?role=buyer'] }),
  })
  await router.load()

  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME)
  queryClient.setQueryData(profileKeys.orders(ME.id, 'buyer', 'ALL'), {
    pages: pages.map((items, index) => ({
      items,
      nextCursor: index < pages.length - 1 || lastPageHasNext ? 'cursor-next' : null,
    })),
    pageParams: pages.map((_, index) => (index === 0 ? null : 'cursor-next')),
  })

  return renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  )
}

test('订单翻页：两页都渲染，末页无游标时没有「加载更多」', async () => {
  const html = await renderOrders([
    [order('txn_01jc000000e00800000000004a', '第一页订单')],
    [order('txn_01jc000000e00800000000004b', '第二页订单')],
  ])

  expect(html).toContain('第一页订单')
  expect(html).toContain('第二页订单')
  expect(html).not.toContain('加载更多')
})

test('订单翻页：还有下一页时给「加载更多」入口', async () => {
  const html = await renderOrders([[order('txn_01jc000000e00800000000004a', '第一页订单')]], {
    lastPageHasNext: true,
  })

  expect(html).toContain('第一页订单')
  expect(html).toContain('加载更多')
})
