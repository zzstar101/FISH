import { expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { clearAdminQueries } from './queries'

/**
 * 跨账号缓存清理回归（评审 P1）。
 *
 * 场景：管理员 A 打开 /admin/users 后登出，普通用户 B 登录并进入 /admin。
 * Admin query key 不含用户身份，若不清理，B 可能命中 A 仍 fresh 的缓存。
 * 约定：身份变化时调用 `clearAdminQueries`，清掉全部 `['admin', ...]` 查询，
 * 不影响普通用户查询（`['auth', ...]` 等）。
 */
test('clearAdminQueries 清空全部 admin 查询，不影响其它前缀', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['admin', 'me'], { admin: { id: 'a' } })
  queryClient.setQueryData(['admin', 'users', { cursor: null } as const], { items: [] })
  queryClient.setQueryData(['admin', 'audit-logs', { cursor: null } as const], { items: [] })
  queryClient.setQueryData(['auth', 'me'], { id: 'b' })
  queryClient.setQueryData(['profile'], { ok: true })

  clearAdminQueries(queryClient)

  expect(queryClient.getQueryData(['admin', 'me'])).toBeUndefined()
  expect(queryClient.getQueryData(['admin', 'users', { cursor: null } as const])).toBeUndefined()
  expect(
    queryClient.getQueryData(['admin', 'audit-logs', { cursor: null } as const]),
  ).toBeUndefined()
  // 普通用户缓存不受影响。
  expect(queryClient.getQueryData(['auth', 'me'])).toEqual({ id: 'b' } as never)
  expect(queryClient.getQueryData(['profile'])).toEqual({ ok: true } as never)
})
