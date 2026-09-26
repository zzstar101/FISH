import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { REPORT_REASON_LABEL, REPORT_STATUS_LABEL } from '../admin/display'
import { useAuth } from '../auth/auth-provider'
import { useMyReports } from './queries'

export function MyReportsPage() {
  const { me, isInitializing } = useAuth()
  const reports = useMyReports()
  const items = reports.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <NavBar onBack={() => window.history.back()} title="我的举报" />
      {isInitializing || (me && reports.isPending) ? (
        <LoadingState label="正在加载举报记录…" />
      ) : null}
      {!isInitializing && !me ? (
        <EmptyState
          action={
            <Link
              className="rounded-lg bg-brand px-5 py-2.5 text-white"
              search={{ redirect: '/my-reports' }}
              to="/login"
            >
              去登录
            </Link>
          }
          description="登录后可查看自己提交的举报及处理状态"
          emoji="🔒"
        />
      ) : null}
      {me && reports.isError && items.length === 0 ? (
        <ErrorState message="举报记录加载失败" onRetry={() => void reports.refetch()} />
      ) : null}
      {me && reports.isSuccess && items.length === 0 ? (
        <EmptyState
          description="遇到可疑商品或用户时，可从对应页面发起举报"
          emoji="🛡️"
          title="暂无举报"
        />
      ) : null}
      {me && items.length > 0 ? (
        <div className="mx-4 mt-4 space-y-3">
          <p className="text-ink-3 text-xs">仅显示你提交的举报；处理结果不等于治理处罚。</p>
          <ul className="space-y-3">
            {items.map((report) => (
              <li className="rounded-2xl bg-surface p-4 shadow-sm" key={report.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-sm">
                    {report.targetType === 'LISTING' ? '商品举报' : '用户举报'}
                  </span>
                  <span className="rounded-full bg-surface-2 px-2.5 py-1 text-ink-2 text-xs">
                    {REPORT_STATUS_LABEL[report.status]}
                  </span>
                </div>
                <p className="mt-2 text-ink-2 text-sm">{REPORT_REASON_LABEL[report.reason]}</p>
                {report.detailText ? (
                  <p className="mt-2 whitespace-pre-wrap text-ink-3 text-sm">{report.detailText}</p>
                ) : null}
                <p className="mt-3 break-all text-ink-3 text-xs">编号：{report.id}</p>
                <p className="mt-1 text-ink-3 text-xs">
                  提交于 {new Date(report.createdAt).toLocaleString('zh-CN')}
                </p>
              </li>
            ))}
          </ul>
          {reports.hasNextPage ? (
            <Button
              className="w-full"
              disabled={reports.isFetchingNextPage}
              onClick={() => void reports.fetchNextPage()}
              variant="outline"
            >
              {reports.isFetchingNextPage ? '正在加载…' : '加载更多'}
            </Button>
          ) : null}
          {reports.isFetchNextPageError ? (
            <p className="text-danger text-sm" role="alert">
              下一页加载失败，请重试
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
