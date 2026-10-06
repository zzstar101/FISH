import type { AdminUserDetail } from '@fish/contracts/admin/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ForbiddenInline, NotFoundInline } from './admin-filter'
import { adminLoadView, governanceActionError } from './admin-messages'
import {
  useAdminUserDetail,
  useUserBan,
  useUserLiftRestriction,
  useUserRestrictPublish,
} from './admin-queries'
import { withoutCursor } from './admin-search'
import {
  auditActionLabelOf,
  authStatusMeta,
  formatAdminDateTime,
  listingStatusMeta,
  roleMeta,
} from './admin-view'
import type { GovernanceDialogOutput } from './governance-dialog'
import { GovernanceDialog } from './governance-dialog'
import type { UsersSearch } from './users-page'

/** 商品统计的展示顺序（标签一律取自 `LISTING_STATUS_META`，不在页面里另抄一份中文）。 */
const LISTING_STAT_ORDER = ['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'] as const

/**
 * 用户详情（#467 验收「详情、已有治理状态」+ 治理写：限制发布 / 封禁 / 解除）。
 * 「解除限制」只在**有生效中限制**时出现（契约 `AdminUserDetail.activeRestrictions`
 * 的存在理由：没有生效限制的用户看到解除按钮，只会点出一个必然 409）。
 */
export function UserDetailPage({ userId, search }: { userId: string; search: UsersSearch }) {
  const detail = useAdminUserDetail(userId)

  if (detail.isPending) return <LoadingState label="正在加载用户详情…" />
  if (detail.isError) {
    const view = adminLoadView(detail.error, '用户详情加载失败')
    // 403 / 404 都不给「重试」（#467 五审 P3）：权限不会因重试改变，已删除的用户也不会回来。
    if (view.kind === 'forbidden') return <ForbiddenInline />
    if (view.kind === 'notFound') return <NotFoundInline label="用户" to="/admin/users" />
    return <ErrorState message={view.message} onRetry={() => void detail.refetch()} />
  }

  return <UserDetailView detail={detail.data} search={search} userId={userId} />
}

type UserActionKind = 'restrict' | 'ban' | 'lift'

function UserDetailView({
  detail,
  search,
  userId,
}: {
  detail: AdminUserDetail
  search: UsersSearch
  userId: string
}) {
  const [dialog, setDialog] = useState<UserActionKind | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const restrict = useUserRestrictPublish(userId)
  const ban = useUserBan(userId)
  const lift = useUserLiftRestriction(userId)

  const user = detail.user
  const authMeta = authStatusMeta(user.authStatus)
  const roleView = roleMeta(user.role)

  async function submit(input: GovernanceDialogOutput, kind: UserActionKind) {
    setDialogError(null)
    const body = {
      reason: input.reason,
      // 前缀已在弹窗守卫（asSourceReportId）收窄成品牌类型；存在性与目标匹配仍由服务端 404/422 兜底。
      ...(input.sourceReportId !== undefined ? { sourceReportId: input.sourceReportId } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }
    try {
      if (kind === 'restrict') await restrict.mutateAsync(body)
      else if (kind === 'ban') await ban.mutateAsync(body)
      else await lift.mutateAsync(body)
      setDialog(null)
      setNotice(kind === 'lift' ? '已解除该用户的全部生效限制' : '操作已执行，状态已刷新')
    } catch (error) {
      const outcome = governanceActionError(error)
      if (outcome.conflict) {
        // 状态已被其他管理员改掉：关弹窗、刷详情、在页面层如实提示。
        setDialog(null)
        setNotice(outcome.message)
      } else {
        setDialogError(outcome.message)
      }
    }
  }

  const pending =
    dialog === 'restrict' ? restrict.isPending : dialog === 'ban' ? ban.isPending : lift.isPending

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              className="text-ink-3 text-sm hover:text-brand"
              search={withoutCursor(search)}
              to="/admin/users"
            >
              ← 用户列表
            </Link>
          </div>
          <h1 className="mt-1 flex items-center gap-2 font-semibold text-[26px] tracking-[-0.03em]">
            {user.nickname}
            <Badge variant={authMeta.variant}>{authMeta.label}</Badge>
            <Badge variant={roleView.variant}>{roleView.label}</Badge>
          </h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            {user.studentNoMasked ?? '无学号（微信注册）'} · 注册于{' '}
            {formatAdminDateTime(user.createdAt)}
            {user.lastActivityAt === null
              ? ' · 从未登录'
              : ` · 最近活跃 ${formatAdminDateTime(user.lastActivityAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            onClick={() => {
              setDialogError(null)
              setDialog('restrict')
            }}
            variant="outline"
          >
            限制发布
          </Button>
          <Button
            onClick={() => {
              setDialogError(null)
              setDialog('ban')
            }}
            variant="destructive"
          >
            封禁
          </Button>
          {detail.activeRestrictions.length > 0 ? (
            <Button
              onClick={() => {
                setDialogError(null)
                setDialog('lift')
              }}
              variant="outline"
            >
              解除限制
            </Button>
          ) : null}
        </div>
      </div>

      {notice !== null ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">商品统计</h2>
          <div className="grid grid-cols-4 gap-3 text-center">
            {LISTING_STAT_ORDER.map((status) => (
              <div className="rounded-xl bg-surface-2 p-3" key={status}>
                <p className="font-bold text-xl">{detail.listingStats[status]}</p>
                <p className="mt-0.5 text-ink-3 text-xs">{listingStatusMeta(status).label}</p>
              </div>
            ))}
          </div>
          <Link
            className="text-brand text-sm hover:underline"
            params={{ userId: user.id }}
            search={{ sellerId: user.id }}
            to="/admin/listings"
          >
            查看该用户的商品 →
          </Link>
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">生效中的限制</h2>
          {detail.activeRestrictions.length === 0 ? (
            <p className="text-ink-3 text-sm">无</p>
          ) : (
            <ul className="space-y-2">
              {detail.activeRestrictions.map((restriction) => (
                <li className="rounded-xl bg-surface-2 p-3 text-sm" key={restriction.id}>
                  <div className="flex items-center gap-2">
                    <Badge variant={restriction.type === 'BAN' ? 'danger' : 'warn'}>
                      {restriction.type === 'BAN' ? '封禁' : '限制发布'}
                    </Badge>
                    {restriction.expiresAt !== null ? (
                      <span className="text-ink-3 text-xs">
                        至 {formatAdminDateTime(restriction.expiresAt)}
                      </span>
                    ) : (
                      <span className="text-ink-3 text-xs">永久</span>
                    )}
                  </div>
                  <p className="mt-1 text-ink-2 text-xs">
                    {restriction.reason} · 自 {formatAdminDateTime(restriction.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link
            className="text-brand text-sm hover:underline"
            search={{ targetType: 'USER', targetId: user.id }}
            to="/admin/audit"
          >
            该用户的操作审计 →
          </Link>
        </Card>
      </div>

      <Card className="gap-0 divide-y divide-line border border-line p-0">
        <h2 className="p-4 font-semibold">最近管理操作</h2>
        {detail.recentAuditLogs.length === 0 ? (
          <p className="p-4 text-ink-3 text-sm">暂无针对该用户的管理操作记录。</p>
        ) : (
          detail.recentAuditLogs.map((log) => (
            <div className="flex items-center justify-between gap-4 p-4" key={log.id}>
              <div className="min-w-0">
                <p className="font-medium text-sm">{auditActionLabelOf(log.action)}</p>
                {log.reason !== null ? (
                  <p className="mt-0.5 text-ink-3 text-xs">{log.reason}</p>
                ) : null}
              </div>
              <span className="shrink-0 text-ink-3 text-xs">
                {formatAdminDateTime(log.createdAt)}
              </span>
            </div>
          ))
        )}
      </Card>

      {dialog !== null ? (
        <GovernanceDialog
          description={
            dialog === 'lift'
              ? `将解除用户「${user.nickname}」的全部生效限制（${detail.activeRestrictions.length} 条）。`
              : `将对用户「${user.nickname}」执行${dialog === 'restrict' ? '限制发布' : '封禁'}。封禁/限制期间该用户无法进行写入操作。`
          }
          errorMessage={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(input) => void submit(input, dialog)}
          pending={pending}
          requireTarget={dialog === 'lift' ? 'user-lift' : 'user-restrict'}
          submitLabel={
            dialog === 'restrict' ? '确认限制发布' : dialog === 'ban' ? '确认封禁' : '确认解除'
          }
          title={
            dialog === 'restrict' ? '限制用户发布' : dialog === 'ban' ? '封禁用户' : '解除限制'
          }
        />
      ) : null}
    </div>
  )
}
