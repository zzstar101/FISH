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
  signature: null,
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

/** 关注态同理钉死：页面要锁的是「本人不发查询」「未登录给登录入口」这两条**页面自己的**判断。 */
let followStateResult: Record<string, unknown>
let followStateEnabled: boolean | null = null

mock.module('../follows/queries', () => ({
  useFollowState: (_userId: string, enabled: boolean) => {
    followStateEnabled = enabled
    return followStateResult
  },
  useFollowMutation: () => ({ isPending: false, mutate: () => undefined, variables: null }),
  useUnfollowMutation: () => ({ isPending: false, mutate: () => undefined, variables: null }),
}))

/** 「登录后关注」在渲染期读 `window.location` 拼回跳；静态渲染没有 window，钉死一个值。 */
mock.module('../../lib/redirect', () => ({
  currentHref: () => `/pc/users/${USER_ID}`,
  sanitizeRedirect: (value: unknown) => value,
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

/**
 * 同上：页面自己的「去个人中心」「登录后关注」也是 `Link`，静态渲染下换成普通 `<a>`。
 * `search` 里的 redirect 回跳参数落成 data 属性，供「保留回跳」的断言读取。
 */
mock.module('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
  }: {
    to: string
    search?: { redirect?: string }
    children?: ReactNode
  }) => createElement('a', { 'data-redirect': search?.redirect, href: to }, children),
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

function render(me: Me | null = ME): string {
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
  followStateEnabled = null
  followStateResult = { data: undefined }
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
    followStateResult = { data: { kind: 'loaded', following: true, mutual: false } }

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
    // 登录用户看别人主页：发关注态查询，渲染真实的关注钮（默认态未关注）。
    expect(followStateEnabled).toBe(true)
    expect(html).toContain('已关注')
  })

  /** 个性签名（#445）：公开 DTO 的 signature 有就渲染，没有就不出现。 */
  test('renders the public signature only when present', () => {
    profileResult = {
      data: { ...PROFILE, signature: '卖二手书的' },
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: () => undefined,
    }
    listingsResult = idleListings()

    expect(render()).toContain('卖二手书的')

    profileResult = {
      data: PROFILE,
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: () => undefined,
    }
    expect(render()).not.toContain('卖二手书的')
  })

  /** 未登录访客：不发关注态查询，给「登录后关注」入口而不是可点的假按钮。 */
  test('a guest gets a 登录后关注 entry and never queries the follow state', () => {
    profileResult = {
      data: PROFILE,
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: () => undefined,
    }
    listingsResult = idleListings()

    const html = render(null)

    expect(html).toContain('登录后关注')
    // 验收标准「保留回跳」：登录链接必须带着当前页地址。
    expect(html).toContain(`data-redirect="/pc/users/${USER_ID}"`)
    expect(followStateEnabled).toBe(false)
    expect(html).not.toContain('>已关注<')
  })

  /** 互相关注由服务端算好随响应给出，页面只渲染、不重算。 */
  test('renders the mutual hint from the server state', () => {
    profileResult = {
      data: PROFILE,
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: () => undefined,
    }
    listingsResult = idleListings()
    followStateResult = { data: { kind: 'loaded', following: true, mutual: true } }

    const html = render()

    expect(html).toContain('你们互相关注')
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
