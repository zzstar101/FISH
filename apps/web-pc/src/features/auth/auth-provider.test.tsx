import { expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { AuthProvider } from './auth-provider'
import { RequireAuth } from './require-auth'

const oldUser: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '旧用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

function renderGuardedChild(queryClient: QueryClient) {
  return renderToStaticMarkup(
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
}

test('首次还没有任何身份结果时才显示恢复态', () => {
  const queryClient = new QueryClient()
  const html = renderGuardedChild(queryClient)

  expect(html).not.toContain('A 的商品审核详情')
  expect(html).toContain('正在恢复登录状态')
})

test('后台重验已有身份时保留业务视图，切窗口不再丢页面状态', async () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, oldUser)
  const pending = queryClient.fetchQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: () => new Promise<Me>(() => undefined),
  })
  try {
    const html = renderGuardedChild(queryClient)

    // 回前台触发的 /me 重验是后台行为：旧身份的业务视图必须保持挂载，
    // 否则发布草稿、滚动位置、已打开弹窗都会在每次 focus 时被重置。
    expect(html).toContain('A 的商品审核详情')
    expect(html).not.toContain('正在恢复登录状态')
  } finally {
    await queryClient.cancelQueries({ queryKey: AUTH_ME_QUERY_KEY, exact: true })
    await pending.catch(() => undefined)
  }
})
