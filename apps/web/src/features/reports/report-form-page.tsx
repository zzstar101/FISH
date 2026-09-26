import {
  LISTING_REPORT_REASONS,
  type ReportReason,
  ReportReasonSchema,
  ReportTargetTypeSchema,
  USER_REPORT_REASONS,
} from '@fish/contracts/reports/schema'
import { ListingIdSchema, UserIdSchema } from '@fish/contracts/system/public-id'
import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { REPORT_REASON_LABEL } from '../admin/display'
import { useAuth } from '../auth/auth-provider'
import { useSubmitReport } from './queries'

export function ReportFormPage({ targetType, targetId }: { targetType: string; targetId: string }) {
  const type = ReportTargetTypeSchema.safeParse(targetType)
  const id = type.success
    ? (type.data === 'LISTING' ? ListingIdSchema : UserIdSchema).safeParse(targetId)
    : null

  if (!type.success || !id?.success) {
    return <EmptyState title="举报目标不可用" description="请从商品或用户主页重新进入" emoji="🫥" />
  }

  return <AccountScopedReportForm targetType={type.data} targetId={id.data} />
}

/** 表单的 mutation 结果属于一次具体的账号和目标；任一变化均需卸载旧表单。 */
export function reportFormScopeKey(targetType: string, targetId: string, userId: string | null) {
  return `${targetType}:${targetId}:${userId ?? 'anonymous'}`
}

function AccountScopedReportForm({
  targetType,
  targetId,
}: {
  targetType: 'LISTING' | 'USER'
  targetId: `lst_${string}` | `usr_${string}`
}) {
  const { me } = useAuth()
  return (
    <ReportForm
      key={reportFormScopeKey(targetType, targetId, me?.id ?? null)}
      targetType={targetType}
      targetId={targetId}
    />
  )
}

function ReportForm({
  targetType,
  targetId,
}: {
  targetType: 'LISTING' | 'USER'
  targetId: `lst_${string}` | `usr_${string}`
}) {
  const { me, isInitializing } = useAuth()
  const submit = useSubmitReport()
  const reasons = targetType === 'LISTING' ? LISTING_REPORT_REASONS : USER_REPORT_REASONS
  const [reason, setReason] = useState<ReportReason>(reasons[0])
  const [detailText, setDetailText] = useState('')
  const title = targetType === 'LISTING' ? '举报商品' : '举报用户'

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submit.mutate({
      targetType,
      targetId,
      reason,
      ...(detailText.trim() ? { detailText: detailText.trim() } : {}),
    })
  }

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <NavBar onBack={() => window.history.back()} title={title} />
      {isInitializing ? <LoadingState label="正在确认登录状态…" /> : null}
      {!isInitializing && !me ? (
        <div className="px-4 py-8 text-center">
          <p className="text-ink-2">登录后才能提交举报</p>
          <Link
            className="mt-4 inline-block rounded-lg bg-brand px-5 py-2.5 text-white"
            search={{ redirect: `/report/${targetType}/${targetId}` }}
            to="/login"
          >
            去登录
          </Link>
        </div>
      ) : null}
      {!isInitializing && me && submit.data ? (
        <section className="mx-4 mt-6 rounded-2xl bg-surface p-5 shadow-sm" role="status">
          <h1 className="font-semibold text-lg">
            {submit.data.created ? '举报已提交' : '此前已提交过举报'}
          </h1>
          <p className="mt-2 text-ink-2 text-sm">平台会核实处理。处理举报不代表自动处罚对方。</p>
          <p className="mt-3 break-all text-ink-3 text-xs">举报编号：{submit.data.report.id}</p>
          <Link
            className="mt-5 inline-block rounded-lg bg-brand px-5 py-2.5 text-white"
            to="/my-reports"
          >
            查看我的举报
          </Link>
        </section>
      ) : null}
      {!isInitializing && me && !submit.data ? (
        <form
          className="mx-4 mt-5 space-y-5 rounded-2xl bg-surface p-5 shadow-sm"
          onSubmit={onSubmit}
        >
          <div>
            <h1 className="font-semibold text-lg">{title}</h1>
            <p className="mt-1 text-ink-3 text-sm">请选择最符合情况的原因，平台会核实处理。</p>
          </div>
          <label className="block text-sm" htmlFor="report-reason">
            举报原因
            <select
              className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2.5"
              id="report-reason"
              onChange={(event) => setReason(ReportReasonSchema.parse(event.target.value))}
              value={reason}
            >
              {reasons.map((item) => (
                <option key={item} value={item}>
                  {REPORT_REASON_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm" htmlFor="report-detail">
            补充说明（选填，最多 200 字）
            <textarea
              className="mt-2 min-h-28 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5"
              id="report-detail"
              maxLength={200}
              onChange={(event) => setDetailText(event.target.value)}
              placeholder="描述你遇到的问题，不要填写密码或联系方式"
              value={detailText}
            />
          </label>
          {submit.isError ? (
            <p className="text-danger text-sm" role="alert">
              {submit.error instanceof ApiError ? submit.error.message : '提交失败，请稍后重试'}
            </p>
          ) : null}
          <Button className="w-full" disabled={submit.isPending} type="submit">
            {submit.isPending ? '正在提交…' : '提交举报'}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
