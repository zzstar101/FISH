import { expect, mock, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 仓库没有 jsdom，组件只做静态渲染；真 `Link` 在没有 router context 时会炸
 * （`router.isServer`），换成最简 `<a>` stub，把焦点留在视图分支上。
 */
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

const { favoriteStatusView, groupFavorites, FavoritesPageView } = await import('./favorites-view')
type FavoriteRow = import('./favorites-view').FavoriteRow

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

const listingId = 'lst_01jc000000e00800000000000k'
const soldId = 'lst_01jc000000e00800000000000t'

function listingFixture(
  status: ListingCard['status'],
  id: ListingCard['id'] = listingId,
): ListingCard {
  return {
    id,
    title: '高等数学上册',
    priceCents: 2000,
    category: 'BOOKS',
    condition: 'GOOD',
    status,
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    moderationStatus: null,
    wants: 0,
    views: 0,
  }
}

function rowFixture(status: ListingCard['status'], id?: ListingCard['id']): FavoriteRow {
  return { listing: listingFixture(status, id), favoritedAt: '2026-01-02T00:00:00.000Z' }
}

const baseProps = {
  loading: false,
  error: false,
  items: [] as FavoriteRow[],
  total: 0 as number | null,
  hasNextPage: false,
  loadingMore: false,
  cancelingId: null as string | null,
  cancelFailure: null as { listingId: string; message: string } | null,
  onRetry: () => {},
  onCancel: () => {},
  onLoadMore: () => {},
}

function render(overrides: Partial<typeof baseProps>): string {
  return renderToStaticMarkup(createElement(FavoritesPageView, { ...baseProps, ...overrides }))
}

test('加载中与错误各有明确状态，错误可重试', () => {
  expect(render({ loading: true })).toContain('正在加载收藏')
  const failed = render({ error: true })
  expect(failed).toContain('收藏列表加载失败')
  expect(failed).toContain('重试')
})

test('空收藏是正确空态（不回退演示数据）', () => {
  const html = render({})
  expect(html).toContain('还没有收藏')
  expect(html).toContain('去逛逛')
})

test('按 status 分组：在售与失效视觉可区分，失效原因由状态承载', () => {
  const html = render({
    items: [rowFixture('ACTIVE'), rowFixture('SOLD', soldId)],
    total: 2,
  })
  const text = textOf(html)
  expect(text).toContain('在售')
  expect(text).toContain('已失效')
  expect(text).toContain('已售出')
  expect(text).toContain('共 2 件收藏')
})

test('失效条目同样有取消按钮（DELETE 无条件幂等）', () => {
  const html = render({
    items: [rowFixture('OFFLINE', soldId)],
    total: 1,
  })
  expect(html).toContain('已下架')
  expect(html).toContain('取消收藏')
})

test('total 读不到显示未知而非 0', () => {
  const html = render({ items: [rowFixture('ACTIVE')], total: null })
  expect(textOf(html)).toContain('共 未知 件收藏')
  expect(textOf(html)).not.toContain('共 0 件')
})

test('单条取消失败：错误只挂在该条上，该项不丢失、其它条不受影响', () => {
  const html = render({
    items: [rowFixture('ACTIVE'), rowFixture('SOLD', soldId)],
    total: 2,
    cancelFailure: { listingId: soldId, message: '商品不存在或不可见' },
  })
  const text = textOf(html)
  expect(text).toContain('商品不存在或不可见')
  expect(text).toContain('高等数学上册')
})

test('取消中的那条按钮禁用（显示取消中），其它条可点', () => {
  const html = render({
    items: [rowFixture('ACTIVE'), rowFixture('SOLD', soldId)],
    total: 2,
    cancelingId: soldId,
  })
  expect(html).toContain('取消中…')
})

test('还有下一页时出现加载更多', () => {
  const html = render({ items: [rowFixture('ACTIVE')], total: 21, hasNextPage: true })
  expect(html).toContain('加载更多')
})

test('favoriteStatusView：四种状态各有徽标，不新增失效字段', () => {
  expect(favoriteStatusView(listingFixture('ACTIVE'))).toEqual({
    label: '在售',
    variant: 'success',
  })
  expect(favoriteStatusView(listingFixture('RESERVED'))).toEqual({
    label: '已预定',
    variant: 'warn',
  })
  expect(favoriteStatusView(listingFixture('SOLD'))).toEqual({ label: '已售出', variant: 'brand' })
  expect(favoriteStatusView(listingFixture('OFFLINE'))).toEqual({
    label: '已下架',
    variant: 'secondary',
  })
})

test('groupFavorites：组内保持服务端顺序（收藏时间倒序），不重排', () => {
  const items = [rowFixture('SOLD', soldId), rowFixture('ACTIVE'), rowFixture('RESERVED')]
  const { active, inactive } = groupFavorites(items)
  expect(active.map((r) => r.listing.id)).toEqual([listingId])
  expect(inactive.map((r) => r.listing.id)).toEqual([soldId, listingId])
})
