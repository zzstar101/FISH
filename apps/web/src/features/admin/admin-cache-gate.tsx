import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useAuth } from '../auth/auth-provider'
import { clearAdminQueries } from './queries'

/**
 * 身份变化时的 Admin 缓存清理闸（评审 P1 修复）。
 *
 * Admin 查询缓存与用户身份无关（key 不含 user id），若不处理：管理员 A 登出后
 * 普通用户 B 在同一 SPA 登录，B 打开 `/admin` 时 `useAdminMe()` 可能命中
 * A 仍 fresh 的缓存（`staleTime: 60_000`），子页面也会渲染 A 已缓存的
 * 用户 / 审计数据 —— 服务器权限没有被绕过，但这是明确的跨账号泄露窗口。
 *
 * 本组件挂在根布局（AuthProvider 内），在登录身份（user id，含登录 → 登出）
 * 变化时清空全部 `['admin', ...]` 查询。用 ref 记录上一个身份，只在变化时
 * resetQueries，避免每次渲染都误清。
 *
 * 注意：不使用 `useMe()` 返回的 id 之外的派生值（如 nickname），避免同一账号
 * 改昵称也被当成换号。登出时 `me` 为 null，同样触发清理。
 */
export function AdminCacheGate() {
  const queryClient = useQueryClient()
  const { me } = useAuth()
  const lastUserIdRef = useRef<string | null>(me?.id ?? null)

  useEffect(() => {
    const userId = me?.id ?? null
    if (lastUserIdRef.current === userId) return
    lastUserIdRef.current = userId
    void clearAdminQueries(queryClient)
  }, [me?.id, queryClient])

  return null
}
