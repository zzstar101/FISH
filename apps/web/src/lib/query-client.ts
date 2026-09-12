import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { router } from '../router'
import { isUnauthenticatedError } from './api-client'
import { currentHref } from './redirect'

/** 已经在这两个页面时不再跳转，否则 401 会自激成死循环。 */
const AUTH_PAGES = ['/login', '/register']

/**
 * 全局 401 收口：任何 query（后续 #4–#12 的业务读接口）拿到
 * `401 + UNAUTHENTICATED` 都会把人送回登录页并带上回跳地址。
 *
 * `meta.skipAuthRedirect` 用于豁免「未登录是正常态」的查询，例如 `GET /me`。
 */
function redirectToLoginOnUnauthenticated(error: unknown, skip: boolean): void {
  if (skip || !isUnauthenticatedError(error)) return
  if (AUTH_PAGES.includes(window.location.pathname)) return

  void router.navigate({ to: '/login', search: { redirect: currentHref() } }).catch(() => undefined)
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
