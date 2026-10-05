import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { routeTree } from '../../routeTree.gen'
import { wishKeys } from './queries'

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

const WISH: WishDto = {
  id: 'wsh_01jc000000e00800000000003t',
  userId: ME.id,
  keyword: '考研数学书',
  category: 'BOOKS',
  budgetMinCents: 1000,
  budgetMaxCents: 5000,
  description: null,
  acceptSimilar: true,
  status: 'ACTIVE',
  matchCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/**
 * 走**真实 routeTree** 渲染（不 mock 路由）：审查轮 1 实证过 wish.tsx 不渲染 Outlet 时
 * `/wish/$wishId` 会静默回落许愿墙、静态测试还全绿 —— 这条测试就是钉住那类回归的。
 */
async function renderWishRoute(path: string): Promise<{ html: string; queryClient: QueryClient }> {
  const router = createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()

  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME)
  queryClient.setQueryData(wishKeys.detail(ME.id, WISH.id), WISH)

  const html = renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  )
  return { html, queryClient }
}

test('真实路由：/wish/$wishId 挂载详情页，渲染愿望关键词与匹配入口', async () => {
  const { html } = await renderWishRoute(`/pc/wish/${WISH.id}`)

  expect(html).toContain('考研数学书')
  expect(html).toContain('查看匹配结果')
  // 详情页独有的返回链接（许愿墙本身没有）
  expect(html).toContain('返回许愿墙')
})

test('真实路由：/wish 仍是许愿墙，不受详情路由加入影响', async () => {
  const { html } = await renderWishRoute('/pc/wish')

  // 「许愿墙」三字由侧栏导航恒渲染，拿它断言是空转；钉 WishPage 独有的页头文案。
  expect(html).toContain('愿望按 page/pageSize 分页')
  expect(html).not.toContain('返回许愿墙')
})
