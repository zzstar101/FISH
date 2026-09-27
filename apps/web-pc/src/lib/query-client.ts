import { focusManager, MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
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

  void resetPcSession(queryClient, null).then((applied) => {
    // 这次 401 的重置已被更新的登录 / 重置取代时，缓存保持新会话，
    // 也不能再把刚完成认证的用户踢回登录页。
    if (!applied || skip || AUTH_PAGES.has(currentAppPathname())) return

    void router
      .navigate({ to: '/login', search: { redirect: currentHref() } })
      .catch(() => undefined)
  })
}

// React Query 默认只听 visibilitychange。另一浏览器窗口切换同源 Cookie 时，
// PC 页可能一直保持 visible；重新聚焦窗口同样需要触发 /me 身份复核。
if (typeof window !== 'undefined') {
  focusManager.setEventListener((onFocus) => {
    const verify = () => onFocus()
    window.addEventListener('visibilitychange', verify)
    window.addEventListener('focus', verify)
    return () => {
      window.removeEventListener('visibilitychange', verify)
      window.removeEventListener('focus', verify)
    }
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
