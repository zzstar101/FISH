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
    expect(matchedRouteIds('/pc/login').at(-1)).toBe('/login')
    expect(matchedRouteIds('/pc/search?q=keyboard').at(-1)).toBe('/search')
    expect(matchedRouteIds('/pc/listing/lst_01jc000000e00800000000000t').at(-1)).toBe(
      '/listing/$listingId',
    )
    expect(matchedRouteIds('/pc/messages/cnv_01jc000000e00800000000001a').at(-1)).toBe(
      '/messages/$conversationId',
    )
    expect(matchedRouteIds('/pc/orders/txn_01jc000000e00800000000004t').at(-1)).toBe(
      '/orders/$transactionId',
    )
  })

  test('unknown /pc paths resolve to the root not-found boundary', () => {
    const router = routerAt('/pc/no-such-route')
    const location = router.parseLocation(router.history.location)
    const matches = router.matchRoutes(location)

    expect(matches).toHaveLength(1)
    expect(matches[0]?.routeId).toBe('__root__')
    expect(matches[0]?._notFound).toBe(true)
  })

  test('the retired register route no longer resolves', () => {
    const router = routerAt('/pc/register')
    const location = router.parseLocation(router.history.location)
    const matches = router.matchRoutes(location)

    expect(matches).toHaveLength(1)
    expect(matches[0]?._notFound).toBe(true)
  })

  test('login page offers the scan panel and nothing else', async () => {
    const html = await renderAt('/pc/login', null)

    expect(html).toContain('欢迎回来')
    expect(html).toContain('正在生成登录二维码')
    expect(html).not.toContain('账号密码')
    expect(html).not.toContain('注册')
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
