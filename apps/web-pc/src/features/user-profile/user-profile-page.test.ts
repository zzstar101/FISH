import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../lib/api-client'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { AuthProvider } from '../auth/auth-provider'

const USER_ID = 'usr_01jc000000e00800000000000c'

const ME: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '本人',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

/**
 * 页面分支只看这两个 hook 的返回值，这里把它们钉死。仓库没有 jsdom，组件只做静态渲染，
 * 不必把 TanStack 的缓存内部形态拖进测试 —— 要锁的是「资料没拿到就不查在售」「404 渲染成
 * 用户不存在」这两条**页面自己的**判断。
 */
let profileResult: Record<string, unknown>
let listingsResult: Record<string, unknown>
let listingsEnabled: boolean | null = null

mock.module('./queries', () => ({
  usePublicProfile: () => profileResult,
  useUserActiveListings: (_userId: string, enabled: boolean) => {
    listingsEnabled = enabled
    return listingsResult
  },
}))

/**
 * 卡片本身在别处有自己的测试；这里只关心页面**把在售条目传下去了**。
 * 真卡片内部用 `Link`，静态渲染时没有 router context 会炸（`router.isServer`），
 * 换成最简 stub，把测试焦点留在页面的分支判断上。
 */
mock.module('../listings/listing-card', () => ({
  PcListingCard: ({ item }: { item: { id: string; title: string } }) =>
    createElement('a', { href: `/pc/listing/${item.id}` }, item.title),
}))

/** 同上：页面自己的「去个人中心」也是一个 `Link`，静态渲染下换成普通 `<a>`。 */
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

const { UserProfilePage } = await import('./user-profile-page')

const PROFILE = {
  id: USER_ID,
  nickname: '橙子',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  joinedDays: 7,
  activeCount: 1,
  soldCount: 0,
}

const CARD = {
  id: 'lst_01jc000000e00800000000000t',
  title: '二手自行车',
  priceCents: 12000,
  category: 'TRANSPORT',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  moderationStatus: null,
}

/** hook 返回形状的最小实现：页面读到哪个字段就补哪个。 */
function idleListings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: undefined,
    isPending: true,
    isError: false,
    isSuccess: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    refetch: () => undefined,
    fetchNextPage: () => undefined,
    ...overrides,
  }
}

function render(me: Me = ME): string {
  const client = new QueryClient()
  client.setQueryData(AUTH_ME_QUERY_KEY, me)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AuthProvider, null, createElement(UserProfilePage, { userId: USER_ID })),
    ),
  )
}

beforeEach(() => {
  listingsEnabled = null
})

describe('UserProfilePage', () => {
  test('renders the profile stats and the active listings', () => {
    profileResult = {
      data: PROFILE,
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: () => undefined,
    }
    listingsResult = idleListings({
      data: { pages: [{ items: [CARD], nextCursor: null }] },
      isPending: false,
      isSuccess: true,
    })

    const html = render()

    expect(html).toContain('橙子')
    expect(html).toContain('加入天数')
    expect(html).toContain('在售商品')
    expect(html).toContain('卖出')
    expect(html).toContain('二手自行车')
    // 契约的公开 DTO 只有七个字段，页面上不得出现编造指标。
    expect(html).not.toContain('好评')
    // 看的是别人的主页，不该出现「自己的公开主页」那条提示。
    expect(html).not.toContain('这是你的公开主页')
    expect(listingsEnabled).toBe(true)
  })

  /** 验收标准「访问自己主页时的表现明确」：明确的表现就是这条提示 + 回个人中心的出口。 */
  test('marks your own page and offers the way back to 个人中心', () => {
    profileResult = {
      data: PROFILE,
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: () => undefined,
    }
    listingsResult = idleListings()

    const html = render({ ...ME, id: USER_ID })

    expect(html).toContain('这是你的公开主页')
    expect(html).toContain('去个人中心')
  })

  /**
   * 契约对**不存在的用户**返回 404 而不是空列表（`USER_ROUTES.activeListings` 注释），
   * 所以端上有两件事必须同时成立：渲染成「用户不存在」，且**根本不发**在售查询 ——
   * 否则会先闪一下「TA 暂无在售商品」再被 404 覆盖。
   */
  test('a USER_NOT_FOUND renders 用户不存在 and never queries the listings', () => {
    profileResult = {
      isPending: false,
      isError: true,
      error: new ApiError('USER_NOT_FOUND', 404, '用户不存在或不可见'),
      isSuccess: false,
      refetch: () => undefined,
    }
    listingsResult = idleListings()

    const html = render()

    // 钉住**标题**（`>用户不存在<`）：描述里也有「用户不存在」四个字，
    // 只断言 toContain('用户不存在') 的话，标题被改错也不会红。
    expect(html).toContain('>用户不存在<')
    expect(html).not.toContain('暂无在售商品')
    expect(listingsEnabled).toBe(false)
  })

  test('a non-404 failure renders a load error, not 用户不存在', () => {
    profileResult = {
      isPending: false,
      isError: true,
      error: new ApiError('INTERNAL_ERROR', 500, '服务异常'),
      isSuccess: false,
      refetch: () => undefined,
    }
    listingsResult = idleListings()

    const html = render()

    expect(html).toContain('用户资料加载失败')
    expect(html).not.toContain('用户不存在')
  })
})
