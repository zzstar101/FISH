import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from './lib/session-cache'
import { routeTree } from './routeTree.gen'

const USER: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '审查用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
  signature: null,
}

function routerAt(entry: string) {
  return createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
}

function matchedRouteIds(entry: string): string[] {
  const router = routerAt(entry)
  const location = router.parseLocation(router.history.location)
  return router.matchRoutes(location).map((match) => match.routeId)
}

async function renderAt(entry: string, user: Me | null): Promise<string> {
  const router = routerAt(entry)
  await router.load()
  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)

  return renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  )
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1
}

describe('PC release route boundaries', () => {
  test('deep links resolve inside the PC route tree', () => {
    expect(matchedRouteIds('/pc/search?q=keyboard').at(-1)).toBe('/search')
    expect(matchedRouteIds('/pc/listing/lst_01jc000000e00800000000000t').at(-1)).toBe(
      '/listing/$listingId',
    )
    // 他人主页与商品详情同为免登录公开页（`__root.tsx` 的白名单），
    // basepath + 动态段组合别在这里被改坏。
    expect(matchedRouteIds('/pc/users/usr_01jc000000e00800000000000c').at(-1)).toBe(
      '/users/$userId',
    )
    expect(matchedRouteIds('/pc/messages/cnv_01jc000000e00800000000001a').at(-1)).toBe(
      '/messages/$conversationId',
    )
    expect(matchedRouteIds('/pc/orders/txn_01jc000000e00800000000004t').at(-1)).toBe(
      '/orders/$transactionId',
    )
  })

  /**
   * 他人主页与商品详情一样是**免登录公开页**：`__root.tsx` 的白名单漏掉它，
   * 匿名访客就会被 `RequireAuth` 弹去登录 —— 而契约明确要求这两个端点匿名可读。
   * 断言页面本体渲染出来了：走登录守卫时渲染的是 `Navigate`，看不到这行加载态。
   */
  test('the public user profile renders for an anonymous visitor', async () => {
    const html = await renderAt('/pc/users/usr_01jc000000e00800000000000c', null).catch(
      (error: unknown) => {
        // 白名单被摘掉时 `RequireAuth` 会走 `currentHref()`，在 SSR 下抛 `window is not defined`。
        // 原始报错指向环境，容易被误读成「测试坏了」，换成能说明问题的信息。
        throw new Error(
          `匿名渲染他人主页失败 —— 多半是 /users/$userId 从 __root.tsx 的免登录白名单里掉了。\n原因：${String(error)}`,
        )
      },
    )
    expect(html).toContain('正在加载用户资料')
  })

  test('unknown /pc paths resolve to the root not-found boundary', () => {
    const router = routerAt('/pc/no-such-route')
    const location = router.parseLocation(router.history.location)
    const matches = router.matchRoutes(location)

    expect(matches).toHaveLength(1)
    expect(matches[0]?.routeId).toBe('__root__')
    expect(matches[0]?._notFound).toBe(true)
  })

  test('root route keeps provider, error and not-found boundaries wired', () => {
    const router = routerAt('/pc/')
    const root = router.routesById.__root__

    expect(router.options.notFoundMode).toBe('root')
    expect('shellComponent' in root.options).toBe(true)
    expect(root.options.errorComponent).toBeDefined()
    expect(root.options.notFoundComponent).toBeDefined()
  })

  test('unknown PC paths render one PC shell for both auth states', async () => {
    for (const user of [USER, null]) {
      const html = await renderAt('/pc/no-such-route', user)
      expect(html).toContain('页面不存在')
      expect(count(html, '<header')).toBe(1)
      expect(count(html, 'aria-label="主导航"')).toBe(1)
    }
  })
})
