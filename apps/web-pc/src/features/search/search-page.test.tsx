import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { routeTree } from '../../routeTree.gen'

/**
 * 「免费送」筛选的**路由级**回归（#451 审查轮 1 抓到的 P0）。
 *
 * 为什么不能只测 `parseSearchParams({ free: 'true' })`：真实入参不是 URL 字符串，而是路由
 * 默认 `parseSearch`（`defaultParseSearch = parseSearchWith(JSON.parse)`，经 qss `toValue()`）
 * 解析后的对象 —— `?free=true` 到 `validateSearch` 时**已经是布尔** `true`。
 * 只测字符串形态的单测会全绿，而 chip 点不动、URL 直开也不生效。
 * 这个文件跑真路由（parseSearch → validateSearch → 组件），所以能抓到那一类错。
 */

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

/** 页面头部会把当前生效的筛选写出来，用它断言「筛选真的落到了页面状态上」。 */
const FREE_ACTIVE_TEXT = '只看免费送'

function makeRouter(initial: string) {
  return createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
}

function renderWith(router: ReturnType<typeof makeRouter>): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME)

  return renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  )
}

async function renderSearchAt(initial: string): Promise<string> {
  const router = makeRouter(initial)
  await router.load()
  return renderWith(router)
}

test('URL 直开 ?free=true：筛选生效（路由已把参数解析成布尔）', async () => {
  expect(await renderSearchAt('/pc/search?free=true')).toContain(FREE_ACTIVE_TEXT)
})

test('URL 不带 free：筛选不生效', async () => {
  expect(await renderSearchAt('/pc/search')).not.toContain(FREE_ACTIVE_TEXT)
})

test('?free=false 不解成「只看非免费送」——web-pc 没有那一档', async () => {
  expect(await renderSearchAt('/pc/search?free=false')).not.toContain(FREE_ACTIVE_TEXT)
})

test('点 chip 的导航路径（search 载荷为布尔）同样生效', async () => {
  const router = makeRouter('/pc/search')
  await router.load()
  await router.navigate({ to: '/search', search: { free: true } })

  expect(renderWith(router)).toContain(FREE_ACTIVE_TEXT)
})
