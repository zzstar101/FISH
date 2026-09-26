import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { router } from '../router'
import { isUnauthenticatedError } from './api-client'
import { currentHref } from './redirect'
import { resetPcSession } from './session-cache'

/** 应用内部路径（去掉 router basepath 与尾斜杠），用于比较登录 / 注册页。 */
function currentAppPathname(): string {
  return window.location.pathname.replace(/^\/pc(?=\/|$)/, '').replace(/\/+$/, '') || '/'
}

const AUTH_PAGES = new Set(['/login', '/register'])

/**
 * 全局 401 收口：任何 query / mutation 拿到 `401 + UNAUTHENTICATED`
 * 都回登录页并携带 `/pc/...` 的完整回跳地址。
 *
 * `meta.skipAuthRedirect` 用于豁免「未登录是正常态」的查询，例如 `GET /me`。
 */
function redirectToLoginOnUnauthenticated(error: unknown, skip: boolean): void {
  if (!isUnauthenticatedError(error)) return

  void resetPcSession(queryClient, null).then(() => {
    if (skip || AUTH_PAGES.has(currentAppPathname())) return

    void router
      .navigate({ to: '/login', search: { redirect: currentHref() } })
      .catch(() => undefined)
  })
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) =>
      redirectToLoginOnUnauthenticated(error, Boolean(query.meta?.skipAuthRedirect)),
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) =>
      redirectToLoginOnUnauthenticated(error, Boolean(mutation.meta?.skipAuthRedirect)),
  }),
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})
