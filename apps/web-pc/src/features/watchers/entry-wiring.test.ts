import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { routeTree } from '../../routeTree.gen'
import { profileKeys } from '../profile/queries'

/**
 * #381 验收 1：「我的发布」的商品卡有「谁想要」入口。
 *
 * 真渲染 `/pc/mylist`（不是扫源码文本）：每张商品卡都要出现入口按钮。
 * 手法同 `apps/web-pc/src/routes.release.test.ts`。
 */
const ME: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

const LISTING: ListingCard = {
  id: 'lst_01jc000000e00800000000000t',
  title: '考研数学全套',
  priceCents: 2800,
  category: 'BOOKS',
  condition: 'LIKE_NEW',
  status: 'ACTIVE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  moderationStatus: 'APPROVED',
}

async function renderMyList(listings: ListingCard[]): Promise<string> {
  const router = createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: ['/pc/mylist'] }),
  })
  await router.load()

  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME)
  // 我的发布读 profile 域的 listings 查询，不预置就只渲染加载态。
  queryClient.setQueryData(profileKeys.listings(ME.id, 'ALL'), {
    items: listings,
    nextCursor: null,
  })

  return renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  )
}

test('我的发布：每张商品卡都有「谁想要」入口（#381 验收 1）', async () => {
  const html = await renderMyList([LISTING])

  expect(html).toContain('考研数学全套')
  expect((html.match(/谁想要/g) ?? []).length).toBe(1)
})

test('没有商品时不渲染入口（空态页面本来就没有卡片）', async () => {
  const html = await renderMyList([])

  expect(html).not.toContain('谁想要')
})
