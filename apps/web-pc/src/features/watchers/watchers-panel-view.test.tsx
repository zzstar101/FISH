import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  WatchersPanelView,
  type WatchersPanelViewProps,
  watchersTotalLabel,
} from './watchers-panel-view'

/**
 * 「谁想要」面板的静态渲染（web-pc 没有 jsdom；radix 的弹窗外壳走 Portal，
 * 静态渲染下什么都出不来，所以这里测的是弹窗内容）。
 * 钉三件事：**空态文案**、**只渲染契约给的字段**、
 * **404/403 落成业务空态而不是系统错误**（#381 验收 2 / 4 / 5）。
 */
const noop = () => {}

function baseProps(): WatchersPanelViewProps {
  return {
    state: 'ready',
    total: 0,
    items: [],
    errorMessage: null,
    hasNextPage: false,
    fetchingNextPage: false,
    nextPageFailed: false,
    onLoadMore: noop,
    onRetry: noop,
  }
}

function render(overrides: Partial<WatchersPanelViewProps> = {}): string {
  return renderToStaticMarkup(<WatchersPanelView {...baseProps()} {...overrides} />)
}

const BUYER = {
  id: 'usr_01jc000000e00800000000001a',
  nickname: '小北',
  avatarUrl: null,
  authStatus: 'VERIFIED',
} as const

test('名单行渲染契约给的字段：昵称 / 相对时间 / 认证徽章，不编造其它字段', () => {
  const html = render({
    state: 'ready',
    total: 1,
    items: [{ user: BUYER, startedAt: '2026-09-30T10:00:00.000Z' }],
  })

  expect(html).toContain('小北')
  expect(html).toMatch(/(刚刚|\d+分钟前|\d+小时前|昨天|\d+天前)想要/)
  expect(html).toContain('已认证')
  // 契约里没有的字段一律不出现（#381「明确不做」：不合并收藏 / 愿望计数，不编造成交量）。
  expect(html).not.toContain('预算')
  expect(html).not.toContain('成交量')
  expect(html).not.toContain('评分')
})

test('未认证买家渲染成 secondary 徽章（与商品详情页同口径）', () => {
  const html = render({
    state: 'ready',
    total: 1,
    items: [
      { user: { ...BUYER, authStatus: 'UNVERIFIED' }, startedAt: '2026-09-30T10:00:00.000Z' },
    ],
  })

  expect(html).toContain('未认证')
  expect(html).not.toContain('已认证')
})

test('空名单给出明确空态，而不是一块空白', () => {
  const html = render({ state: 'empty', total: 0 })

  expect(html).toContain('还没有人点过')
  expect(html).toContain('我想要')
})

test('人数副标题：取到 total 前、后两种口径', () => {
  expect(watchersTotalLabel(null)).toBe('「我想要」过的买家会出现在这里。')
  expect(watchersTotalLabel(0)).toBe('共 0 人想要')
  expect(watchersTotalLabel(7)).toBe('共 7 人想要')
})

test('404（商品不存在）与 403（不是卖家）都渲染成业务空态，不带重试按钮', () => {
  const missing = render({ state: 'listing-missing', total: null })
  expect(missing).toContain('商品不存在或已删除')
  expect(missing).not.toContain('重试')

  const forbidden = render({ state: 'not-owner', total: null })
  expect(forbidden).toContain('只能查看自己商品的想要的人')
  expect(forbidden).not.toContain('重试')
})

test('系统错误才给重试入口', () => {
  const html = render({ state: 'error', errorMessage: '请求失败，请稍后重试', total: null })

  expect(html).toContain('请求失败，请稍后重试')
  expect(html).toContain('重试')
})

test('还有下一页时给「加载更多」；追加页失败时失败只属于那一页', () => {
  const more = render({
    state: 'ready',
    total: 40,
    hasNextPage: true,
    items: [{ user: BUYER, startedAt: '2026-09-30T10:00:00.000Z' }],
  })
  expect(more).toContain('加载更多')
  expect(more).not.toContain('已显示全部')

  const done = render({
    state: 'ready',
    total: 1,
    hasNextPage: false,
    items: [{ user: BUYER, startedAt: '2026-09-30T10:00:00.000Z' }],
  })
  expect(done).toContain('已显示全部 1 人')
  expect(done).not.toContain('加载更多')

  const failed = render({
    state: 'ready',
    total: 40,
    hasNextPage: true,
    nextPageFailed: true,
    items: [{ user: BUYER, startedAt: '2026-09-30T10:00:00.000Z' }],
  })
  expect(failed).toContain('加载更多失败')
  expect(failed).toContain('小北')
})

test('加载中不给任何名单内容', () => {
  const html = render({ state: 'loading', total: null })

  expect(html).toContain('正在读取想要的人')
  expect(html).not.toContain('已显示全部')
})
