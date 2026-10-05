import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { routeTree } from '../../routeTree.gen'
import { isDeletableListing, MyListingPrice } from './mylist-page'
import { profileKeys } from './queries'

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

test('0 元商品显示免费送，而不是 ¥0.00', () => {
  const html = renderToStaticMarkup(createElement(MyListingPrice, { cents: 0 }))

  expect(html).toContain('免费送')
  expect(html).not.toContain('¥0.00')
})

test('付费商品保持价格展示', () => {
  const html = renderToStaticMarkup(createElement(MyListingPrice, { cents: 16000 }))

  expect(textOf(html)).toContain('¥160')
})

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

/** 服务端可删的那一档：已下架 + 不过审 + 非平台下架。 */
const DELETABLE: ListingCard = {
  id: 'lst_01jc000000e00800000000000t',
  title: '考研数学全套',
  priceCents: 2800,
  category: 'BOOKS',
  condition: 'LIKE_NEW',
  status: 'OFFLINE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  moderationStatus: 'BLOCKED',
  governanceDelisted: null,
}

function card(overrides: Partial<ListingCard>): ListingCard {
  return { ...DELETABLE, ...overrides }
}

/*
 * 判据必须与服务端 `store.deleteListingAtomic` 一一对应（见 `isDeletableListing` 注释）。
 * 这里逐条打散，任何一条被放宽都会红。
 */
test('可删判据：OFFLINE + BLOCKED + 非治理下架', () => {
  expect(isDeletableListing(card({}))).toBe(true)

  // 治理下架（平台下架）形态与「不过审」完全相同，按下去必然 409，不能给按钮。
  expect(isDeletableListing(card({ governanceDelisted: true }))).toBe(false)
  // 字段缺席（老 mock 记录）按「不是治理下架」处理，与契约 `.optional()` 同口径。
  expect(isDeletableListing(card({ governanceDelisted: undefined }))).toBe(true)

  // 服务端判据要求 moderation_status === 'BLOCKED'。
  expect(isDeletableListing(card({ moderationStatus: 'APPROVED' }))).toBe(false)
  expect(isDeletableListing(card({ moderationStatus: 'REVIEW' }))).toBe(false)

  // 服务端判据要求 status === 'OFFLINE'。
  expect(isDeletableListing(card({ status: 'ACTIVE' }))).toBe(false)
  expect(isDeletableListing(card({ status: 'SOLD' }))).toBe(false)
})

async function renderMyList(listings: ListingCard[]): Promise<string> {
  return renderMyListPages([listings])
}

/** #446：缓存形状是 infinite 的 `pages[]`；末页 `nextCursor` 非空即还有下一页。 */
async function renderMyListPages(
  pages: ListingCard[][],
  { lastPageHasNext = false }: { lastPageHasNext?: boolean } = {},
): Promise<string> {
  const router = createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: ['/pc/mylist'] }),
  })
  await router.load()

  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME)
  queryClient.setQueryData(profileKeys.listings(ME.id, 'ALL'), {
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

test('不过审的已下架商品：卡片上有「删除」入口', async () => {
  const html = await renderMyList([card({})])

  expect(html).toContain('考研数学全套')
  expect(html).toContain('删除')
})

test('在售商品没有「删除」入口（只有下架）', async () => {
  const html = await renderMyList([card({ status: 'ACTIVE', moderationStatus: 'APPROVED' })])

  expect(html).toContain('下架')
  expect(html).not.toContain('删除')
})

test('平台下架的商品没有「删除」入口（按下去必然 409）', async () => {
  const html = await renderMyList([card({ governanceDelisted: true })])

  expect(html).not.toContain('删除')
})

test('翻页：两页商品都渲染，末页无游标时不给「加载更多」(#446)', async () => {
  const html = await renderMyListPages([
    [card({ id: 'lst_01jc000000e00800000000001a', title: '第一页商品' })],
    [card({ id: 'lst_01jc000000e00800000000002b', title: '第二页商品' })],
  ])

  expect(html).toContain('第一页商品')
  expect(html).toContain('第二页商品')
  expect(html).not.toContain('加载更多')
})

test('翻页：还有下一页时给「加载更多」入口', async () => {
  const html = await renderMyListPages(
    [[card({ id: 'lst_01jc000000e00800000000001a', title: '第一页商品' })]],
    { lastPageHasNext: true },
  )

  expect(html).toContain('加载更多')
})
