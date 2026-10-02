import { describe, expect, mock, test } from 'bun:test'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HistoryViewProps } from './history-view'

/**
 * 行内有 `Link`，静态渲染下没有 router context 会炸，换成普通 `<a>`（与仓库其它页面测试同款桩法）。
 */
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

const { HistoryView } = await import('./history-view')

function item(
  viewedAt: string,
  overrides: Partial<ViewHistoryItem['listing']> = {},
): ViewHistoryItem {
  return {
    listing: {
      id: 'lst_01jc000000e00800000000000k',
      title: '高等数学上册',
      priceCents: 2000,
      category: 'BOOKS',
      condition: 'GOOD',
      status: 'ACTIVE',
      urgent: false,
      negotiable: false,
      free: false,
      coverUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      moderationStatus: null,
      ...overrides,
    },
    viewedAt,
  }
}

const NOW = new Date('2026-10-02T12:00:00')
const TODAY_ISO = NOW.toISOString()
const YESTERDAY_ISO = new Date(NOW.getTime() - 24 * 60 * 60 * 1_000).toISOString()

const BASE: HistoryViewProps = {
  loading: false,
  error: false,
  items: [item(TODAY_ISO)],
  hasNextPage: false,
  loadingMore: false,
  clearing: false,
  clearFailure: null,
  onRetry: () => undefined,
  onLoadMore: () => undefined,
  onClear: () => undefined,
  now: NOW,
}

function render(overrides: Partial<HistoryViewProps> = {}): string {
  return renderToStaticMarkup(createElement(HistoryView, { ...BASE, ...overrides }))
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

describe('HistoryView', () => {
  test('按天分组：今天/昨天两个标题，组内渲染商品与状态徽标', () => {
    const html = render({
      items: [
        item(TODAY_ISO, { title: '今天看的' }),
        item(YESTERDAY_ISO, { title: '昨天看的', status: 'SOLD' }),
      ],
    })

    expect(html).toContain('今天')
    expect(html).toContain('昨天')
    expect(html).toContain('今天看的')
    expect(html).toContain('昨天看的')
    expect(html).toContain('已售出')
  })

  test('失效商品保留展示：下架/售出条目仍在列表里', () => {
    const html = render({
      items: [
        item(TODAY_ISO, { title: '已下架商品', status: 'OFFLINE' }),
        item(TODAY_ISO, { title: '已卖掉商品', status: 'SOLD' }),
      ],
    })

    expect(html).toContain('已下架')
    expect(html).toContain('已售出')
    expect(html).toContain('已下架商品')
    expect(html).toContain('已卖掉商品')
  })

  test('空列表为空态，不出现清空按钮与「加载更多」', () => {
    const html = render({ items: [] })

    expect(html).toContain('还没有浏览记录')
    expect(html).not.toContain('>清空<')
    expect(html).not.toContain('加载更多')
  })

  test('加载失败给错误态', () => {
    expect(render({ error: true })).toContain('浏览记录加载失败')
  })

  test('清空失败时列表保持原样，只多一行文案', () => {
    const html = render({ clearFailure: '网络异常，请稍后重试' })

    expect(textOf(html)).toContain('网络异常，请稍后重试')
    expect(html).toContain('高等数学上册')
  })

  test('清空中按钮禁用并改文案', () => {
    const html = render({ clearing: true })

    expect(textOf(html)).toContain('正在清空…')
  })

  test('还有下一页时给「加载更多」，加载中禁用', () => {
    expect(render({ hasNextPage: true })).toContain('加载更多')
    expect(render({ hasNextPage: true, loadingMore: true })).toContain('正在加载…')
  })

  test('底部保留期说明与契约窗口一致（30 天）', () => {
    expect(textOf(render())).toContain('浏览记录只保留最近 30 天')
  })
})
