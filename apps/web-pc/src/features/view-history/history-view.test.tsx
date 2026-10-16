import { describe, expect, mock, test } from 'bun:test'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HistoryViewProps } from './history-view'

/**
 * 行内有 `Link`，静态渲染下没有 router context 会炸，换成普通 `<a>`（与仓库其它页面测试同款桩法）。
 * `params` 要插值进 href：否则「已下架不给可点入口」这类断言会因桩永远不输出商品 id 而假通过。
 */
mock.module('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string
    params?: Record<string, string>
    children?: ReactNode
  }) => {
    let href = to
    for (const [key, value] of Object.entries(params ?? {})) {
      href = href.replace(`$${key}`, String(value))
    }
    return createElement('a', { href, ...rest }, children)
  },
}))

const { HistoryView } = await import('./history-view')

const LISTING_ID = 'lst_01jc000000e00800000000000k'

function item(
  viewedAt: string,
  overrides: Partial<ViewHistoryItem['listing']> = {},
): ViewHistoryItem {
  return {
    listing: {
      id: LISTING_ID,
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
      wants: 0,
      views: 0,
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
  nextPageError: false,
  clearing: false,
  clearFailure: null,
  onRetry: () => undefined,
  onLoadMore: () => undefined,
  onRetryNextPage: () => undefined,
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
  test('按天分组：今天/昨天各有一个分组标题，组内渲染商品与状态徽标', () => {
    const html = render({
      // 商品标题刻意不含「今天/昨天」字样，避免分组表头缺失时被标题"顶上"而假通过。
      items: [
        item(TODAY_ISO, { title: '甲商品' }),
        item(YESTERDAY_ISO, { title: '乙商品', status: 'SOLD' }),
      ],
    })

    expect(html).toContain('>今天</h2>')
    expect(html).toContain('>昨天</h2>')
    expect(html).toContain('甲商品')
    expect(html).toContain('乙商品')
    expect(html).toContain('已售出')
  })

  test('已下架不给可点入口，已售出仍可进详情（详情页公开可读）', () => {
    const offline = render({ items: [item(TODAY_ISO, { status: 'OFFLINE' })] })
    expect(offline).not.toContain(`/listing/${LISTING_ID}`)

    const sold = render({ items: [item(TODAY_ISO, { status: 'SOLD' })] })
    expect(sold).toContain(`/listing/${LISTING_ID}`)
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

  test('翻页失败：保留已加载列表 + 行内重试，不整页替换、不显示「加载更多」', () => {
    const html = render({ hasNextPage: true, nextPageError: true })

    expect(html).toContain('更多浏览记录加载失败')
    expect(html).toContain('高等数学上册')
    expect(html).not.toContain('加载更多')
  })

  test('底部保留期说明与契约窗口一致（30 天）', () => {
    expect(textOf(render())).toContain('浏览记录只保留最近 30 天')
  })
})
