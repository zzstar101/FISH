import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import {
  AUDIT_ACTION_LABEL,
  AUTH_STATUS_LABEL,
  formatDateTime,
  statusLabel,
  USER_ROLE_LABEL,
} from './display'
import { useAdminUser } from './queries'

/**
 * 用户详情（#73 设计 §4.2）：用户概要 + 商品统计（按状态分桶）+ 最近 Admin 操作记录。
 * 不返回密码哈希 / 完整学号等敏感凭据。
 */
export function UserDetailPage() {
  const { userId } = useParams({ from: '/admin/users/$userId' })
  const detail = useAdminUser(userId)

  if (detail.isPending) return <LoadingState label="正在加载用户详情…" />
  if (detail.isError) {
    return <ErrorState message="用户详情加载失败" onRetry={() => void detail.refetch()} />
  }

  const data = detail.data as {
    user: {
      id: string
      studentNoMasked: string
      nickname: string
      campus: string | null
      authStatus: string
      role: string
      createdAt: string
      listingCount: number
      lastActivityAt: string | null
    }
    listingStats: { ACTIVE: number; RESERVED: number; SOLD: number; OFFLINE: number }
    recentAuditLogs: {
      id: string
      action: string
      targetType: string
      reason: string | null
      createdAt: string
    }[]
  }

  const { user, listingStats, recentAuditLogs } = data

  return (
    <div className="space-y-4">
      <Link
        className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"
        to="/admin/users"
      >
        <ChevronLeft className="size-4" /> 返回用户列表
      </Link>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-full bg-brand/10 font-bold text-brand">
            {user.nickname.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 font-semibold">
              {user.nickname}
              <Badge shape="pill" variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                {statusLabel(USER_ROLE_LABEL, user.role)}
              </Badge>
            </p>
            <p className="mt-1 text-sm text-ink-3">
              {user.studentNoMasked} · {user.campus ?? '校区未填'} · 注册于{' '}
              {formatDateTime(user.createdAt)}
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm text-ink-2">
          认证状态：{statusLabel(AUTH_STATUS_LABEL, user.authStatus)} · 发布商品累计{' '}
          {user.listingCount} 件 · 最近活动 {formatDateTime(user.lastActivityAt)}
        </p>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-[15px]">商品统计（按状态）</h2>
        <div className="grid grid-cols-4 gap-2 text-center">
          <StatCell label="在售" value={listingStats.ACTIVE} />
          <StatCell label="已预留" value={listingStats.RESERVED} />
          <StatCell label="已售出" value={listingStats.SOLD} />
          <StatCell label="已下架" value={listingStats.OFFLINE} />
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-[15px]">最近 Admin 操作记录</h2>
        {recentAuditLogs.length === 0 ? (
          <p className="text-sm text-ink-3">暂无操作记录</p>
        ) : (
          <ul className="divide-y divide-line">
            {recentAuditLogs.map((log) => (
              <li className="flex items-center justify-between gap-3 py-2.5" key={log.id}>
                <div className="min-w-0">
                  <p className="text-sm">{statusLabel(AUDIT_ACTION_LABEL, log.action)}</p>
                  {log.reason ? (
                    <p className="mt-0.5 truncate text-xs text-ink-3">{log.reason}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-ink-3">{formatDateTime(log.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-surface-2 py-3">
      <p className="font-bold text-lg">{value}</p>
      <p className="mt-0.5 text-xs text-ink-3">{label}</p>
    </div>
  )
}
