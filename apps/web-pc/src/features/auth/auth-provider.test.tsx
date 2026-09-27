import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { AuthProvider } from './auth-provider'
import { RequireAuth } from './require-auth'

const oldUser: Me = {
  id: '01930000-0000-7000-8000-00000000000a',
  nickname: '旧用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

test('重验身份期间已缓存的旧账号详情不能继续渲染', async () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, oldUser)
  const pending = queryClient.fetchQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: () => new Promise<Me>(() => undefined),
  })
  try {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AuthProvider,
          null,
          createElement(RequireAuth, null, createElement('p', null, 'A 的商品审核详情')),
        ),
      ),
    )
    expect(html).not.toContain('A 的商品审核详情')
    expect(html).toContain('正在恢复登录状态')
  } finally {
    await queryClient.cancelQueries({ queryKey: AUTH_ME_QUERY_KEY, exact: true })
    await pending.catch(() => undefined)
  }
})
