import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { routeTree } from '../../routeTree.gen'
import { profileKeys } from '../profile/queries'

/**
 * #380 验收 1：未认证用户在 PC 有可发现的认证入口。
 *
 * 真渲染 `/pc/profile`（不是扫源码文本）：个人中心徽章与顶栏徽章都必须是
 * 指向 `/pc/verify` 的链接，未认证时给出「去认证」的措辞。
 * 手法同 `apps/web-pc/src/routes.release.test.ts`。
 */
const ME: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

async function renderProfile(user: Me): Promise<string> {
  const router = createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: ['/pc/profile'] }),
  })
  await router.load()

  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
  // 个人中心的徽章读 profile 聚合读模型（不是 Me），不预置就只会渲染加载态。
  queryClient.setQueryData(profileKeys.aggregate(user.id), {
    user,
    stats: { activeListings: 0, activeWishes: 0, completedTransactions: 0 },
    listings: [],
    wishes: [],
    transactions: [],
  })

  return renderToString(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  )
}

function linkCount(html: string, href: string): number {
  return html.split(`href="${href}"`).length - 1
}

describe('校园认证入口（/pc/profile 真渲染）', () => {
  test('未认证时个人中心与顶栏各有一个指向 /verify 的入口', async () => {
    const html = await renderProfile(ME)

    expect(linkCount(html, '/pc/verify')).toBe(2)
    expect(html).toContain('未认证 · 去认证')
    expect(html).toContain('去认证')
  })

  test('已认证时入口仍在（可查看认证状态），但不再劝人去认证', async () => {
    const html = await renderProfile({
      ...ME,
      authStatus: 'VERIFIED',
      verifiedAt: '2026-10-01T02:03:04.000Z',
    })

    expect(linkCount(html, '/pc/verify')).toBe(2)
    expect(html).toContain('已认证')
    expect(html).not.toContain('去认证')
  })
})
