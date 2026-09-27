import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import {
  AUDIT_ACTION_LABEL,
  AUTH_STATUS_LABEL,
  formatDateTime,
  RESTRICTION_TYPE_LABEL,
  statusLabel,
  USER_ROLE_LABEL,
} from './display'
import { GovernancePanel } from './governance-panel'
import { useAdminUser } from './queries'

/**
 * 用户详情（#73 设计 §4.2）：用户概要 + 商品统计（按状态分桶）+ 最近 Admin 操作记录。
 * 不返回密码哈希 / 完整学号等敏感凭据。
 */
export function UserDetailPage() {
  const { userId } = useParams({ from: '/admin/users/$userId' })
  const { sourceReportId } = useSearch({ from: '/admin/users/$userId' })
  const detail = useAdminUser(userId)

  if (detail.isPending) return <LoadingState label="正在加载用户详情…" />
  if (detail.isError) {
    return <ErrorState message="用户详情加载失败" onRetry={() => void detail.refetch()} />
  }

  const data = detail.data

  const { user, listingStats, activeRestrictions, recentAuditLogs } = data

  // 三个治理按钮按**真实状态**收敛（评审 m6）：后端是唯一真相，但「没有任何生效
  // 限制时仍显示解除按钮」会让操作者照着一个必然 409 的按钮点。反过来，生效中的
  // 限制也要显式列出来——否则页面看不出该用户到底受哪种限制、什么时候到期。
  const hasPublishRestrict = activeRestrictions.some((item) => item.type === 'PUBLISH_RESTRICT')
  const hasBan = activeRestrictions.some((item) => item.type === 'BAN')

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
              {user.studentNoMasked ?? '未绑定学号'} · 注册于 {formatDateTime(user.createdAt)}
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
        {/* 交易查询入口（#73 PR4）：交易页的 buyerId / sellerId 是 URL-only 参数，
            这里正是它们的来源。买家与卖家分成两个链接——同一个请求里同时带两个 id
            会被后端 AND 起来，结果恒为空。 */}
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3 text-sm">
          <span className="text-ink-3">交易记录</span>
          <Link
            className="text-brand hover:underline"
            search={{ buyerId: user.id }}
            to="/admin/transactions"
          >
            作为买家
          </Link>
          <Link
            className="text-brand hover:underline"
            search={{ sellerId: user.id }}
            to="/admin/transactions"
          >
            作为卖家
          </Link>
        </div>
      </Card>

      {/* 治理（#73 PR3）：限制发布 / 封禁 / 解除限制。按钮集合随当前生效中的限制收敛：
          - 没有任何生效限制 → 只给「限制发布」「封禁用户」，「解除限制」留给真有限制的人；
          - 已有同类限制 → 后端会用 409 拒绝重复施加，这里提前收起来；
          - 解除限制一次解除全部（后端口径），所以只在存在任一限制时出现。
          仍然不做「前端替后端判状态」的猜测：这里只是去掉必然失败的入口。 */}
      <GovernancePanel
        actions={[
          ...(hasPublishRestrict
            ? []
            : [
                {
                  action: 'restrict-publish' as const,
                  label: '限制发布',
                  tone: 'danger' as const,
                  description: '禁止该用户发布与编辑商品，留言 / 聊天仍可用',
                },
              ]),
          ...(hasBan
            ? []
            : [
                {
                  action: 'ban' as const,
                  label: '封禁用户',
                  tone: 'danger' as const,
                  description: '禁止全部写入口（发布 / 留言 / 聊天 / 交易），浏览仍可用',
                },
              ]),
          ...(activeRestrictions.length === 0
            ? []
            : [
                {
                  action: 'lift-restriction' as const,
                  label: '解除限制',
                  description: '解除该用户全部生效中的限制（限制发布与封禁一起解）',
                },
              ]),
        ]}
        targetId={user.id}
        sourceReportId={sourceReportId}
      />

      {activeRestrictions.length > 0 ? (
        <Card className="p-4">
          <h2 className="mb-3 font-semibold text-[15px]">生效中的限制</h2>
          <ul className="divide-y divide-line">
            {activeRestrictions.map((restriction) => (
              <li className="flex items-center justify-between gap-3 py-2.5" key={restriction.id}>
                <div className="flex items-center gap-2">
                  <Badge shape="pill" variant="danger">
                    {statusLabel(RESTRICTION_TYPE_LABEL, restriction.type)}
                  </Badge>
                  <span className="text-sm text-ink-3">{restriction.reason}</span>
                </div>
                <span className="text-sm text-ink-3">
                  {restriction.expiresAt ? `至 ${formatDateTime(restriction.expiresAt)}` : '永久'}
                  {' · '}
                  {formatDateTime(restriction.createdAt)}起
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

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
