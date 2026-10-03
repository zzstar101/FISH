import { describe, expect, mock, test } from 'bun:test'
import type { FollowedUser } from '@fish/contracts/follows/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FollowingViewProps } from './following-view'

/**
 * 行内有跳到他人主页的 `Link`，静态渲染下没有 router context 会炸（`router.isServer`），
 * 换成普通 `<a>`（与 user-profile-page.test 同一桩法）。
 */
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

const { FollowingPageView, followingCounts } = await import('./following-view')

const ROW: FollowedUser = {
  id: 'usr_01jc000000e00800000000000c',
  nickname: '橙子',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  mutual: false,
}

const BASE: FollowingViewProps = {
  loading: false,
  error: false,
  items: [ROW],
  total: 3,
  mutualTotal: 1,
  hasNextPage: false,
  loadingMore: false,
  unfollowingId: null,
  unfollowFailure: null,
  onRetry: () => undefined,
  onUnfollow: () => undefined,
  onLoadMore: () => undefined,
}

function render(overrides: Partial<FollowingViewProps> = {}): string {
  return renderToStaticMarkup(createElement(FollowingPageView, { ...BASE, ...overrides }))
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

describe('followingCounts', () => {
  test('全量计数直接进文案，不拿分页长度冒充', () => {
    expect(followingCounts(3, 1)).toBe('关注 3 人 · 互粉 1 人')
  })

  test('计数读不到显示未知而非 0', () => {
    expect(followingCounts(null, null)).toBe('关注 未知 人 · 互粉 未知 人')
  })
})

describe('FollowingPageView', () => {
  test('列表行渲染昵称、互粉徽标与取消关注钮', () => {
    const html = render({
      items: [
        { ...ROW, mutual: true, authStatus: 'VERIFIED' },
        { ...ROW, id: 'usr_01jc000000e00800000000000d', nickname: '阿岚', mutual: false },
      ],
    })

    expect(html).toContain('橙子')
    expect(html).toContain('互相关注')
    expect(html).toContain('已认证')
    expect(textOf(html)).toContain('取消关注')
    expect(html).toContain('关注 3 人 · 互粉 1 人')
  })

  test('空列表为空态，不出现计数条', () => {
    const html = render({ items: [] })

    expect(html).toContain('还没有关注的人')
    expect(html).not.toContain('关注 3 人')
  })

  test('加载失败给错误态与重试', () => {
    expect(render({ error: true })).toContain('我的关注加载失败')
  })

  test('取关失败按行显示失败文案，该行保留可重试', () => {
    const html = render({ unfollowFailure: { userId: ROW.id, message: '网络异常，请稍后重试' } })

    expect(textOf(html)).toContain('网络异常，请稍后重试')
    expect(textOf(html)).toContain('取消关注')
  })

  test('还有下一页时给「加载更多」', () => {
    expect(render({ hasNextPage: true })).toContain('加载更多')
  })

  test('取关中的行禁用按钮并显示「取消中…」', () => {
    expect(render({ unfollowingId: ROW.id })).toContain('取消中…')
  })
})
