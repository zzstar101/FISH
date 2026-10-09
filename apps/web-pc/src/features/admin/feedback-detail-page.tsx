import type { AdminFeedbackItem } from '@fish/contracts/feedback/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { FEEDBACK_STATUS_META, FEEDBACK_TYPE_LABEL } from '../feedback/meta'
import { ForbiddenInline, NotFoundInline } from './admin-filter'
import { adminLoadView, feedbackHandleError } from './admin-messages'
import { useAdminFeedbackDetail, useFeedbackHandle } from './admin-queries'
import { withoutCursor } from './admin-search'
import { formatAdminDateTime } from './admin-view'
import { FeedbackHandleDialog, type FeedbackHandleSubmit } from './feedback-handle-dialog'
import type { FeedbackSearch } from './feedback-page'

/** 反馈详情（#463）：正文 + 提交人 + 联系方式（仅管理端可见）+ 处理结果 / 回复。 */
export function FeedbackDetailPage({
  feedbackId,
  search,
}: {
  feedbackId: string
  search: FeedbackSearch
}) {
  const detail = useAdminFeedbackDetail(feedbackId)

  if (detail.isPending) return <LoadingState label="正在加载反馈详情…" />
  if (detail.isError) {
    const view = adminLoadView(detail.error, '反馈详情加载失败')
    if (view.kind === 'forbidden') return <ForbiddenInline />
    if (view.kind === 'notFound') return <NotFoundInline label="反馈" to="/admin/feedback" />
    return <ErrorState message={view.message} onRetry={() => void detail.refetch()} />
  }

  return <FeedbackDetailView feedbackId={feedbackId} item={detail.data} search={search} />
}

export function FeedbackDetailView({
  feedbackId,
  item,
  search,
}: {
  feedbackId: string
  item: AdminFeedbackItem
  search: FeedbackSearch
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const handle = useFeedbackHandle(feedbackId)
  const { feedback, submitter } = item
  const statusMeta = FEEDBACK_STATUS_META[feedback.status]

  async function submit(input: FeedbackHandleSubmit) {
    setDialogError(null)
    try {
      await handle.mutateAsync(input)
      setDialogOpen(false)
    } catch (error) {
      const outcome = feedbackHandleError(error)
      if (outcome.conflict) {
        setDialogOpen(false)
        setConflict(true)
      } else {
        setDialogError(outcome.message)
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            className="text-ink-3 text-sm hover:text-brand"
            search={withoutCursor(search)}
            to="/admin/feedback"
          >
            ← 反馈队列
          </Link>
          <h1 className="mt-1 font-semibold text-[26px] tracking-[-0.03em]">
            反馈：{FEEDBACK_TYPE_LABEL[feedback.type]}
          </h1>
          <p className="mt-1.5 flex items-center gap-2 text-ink-3 text-sm">
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          </p>
        </div>
        {feedback.status === 'PENDING' && !conflict ? (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialogOpen(true)
            }}
          >
            处理反馈
          </Button>
        ) : null}
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          该反馈已被其他管理员处理，列表已刷新。
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">反馈内容</h2>
          <p className="whitespace-pre-wrap text-sm">{feedback.content}</p>
          <p className="text-ink-3 text-xs">
            提交人{' '}
            <Link
              className="text-brand hover:underline"
              params={{ userId: submitter.id }}
              to="/admin/users/$userId"
            >
              {submitter.nickname}
            </Link>{' '}
            · 提交于 {formatAdminDateTime(feedback.createdAt)}
          </p>
          <p className="text-sm">
            联系方式：{feedback.contact ?? <span className="text-ink-3">未留</span>}
          </p>
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">处理结果</h2>
          {feedback.status === 'PENDING' ? (
            <p className="text-ink-3 text-sm">尚未处理。</p>
          ) : (
            <>
              {feedback.reply !== null ? (
                <div className="rounded-xl bg-brand-soft/50 p-3">
                  <p className="font-medium text-brand text-xs">给用户的回复</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{feedback.reply}</p>
                </div>
              ) : (
                <p className="text-ink-2 text-sm">直接结单，未回复用户。</p>
              )}
              {feedback.handlingNote !== null ? (
                <div className="rounded-xl bg-surface-2 p-3">
                  <p className="font-medium text-sm">内部备注</p>
                  <p className="mt-1 text-ink-2 text-sm">{feedback.handlingNote}</p>
                </div>
              ) : null}
              <p className="text-ink-3 text-xs">
                {feedback.handledBy !== null ? `处理人 ${feedback.handledBy.nickname} · ` : ''}
                {feedback.handledAt !== null
                  ? `处理于 ${formatAdminDateTime(feedback.handledAt)}`
                  : ''}
              </p>
            </>
          )}
        </Card>
      </div>

      {dialogOpen ? (
        <FeedbackHandleDialog
          errorMessage={dialogError}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => void submit(input)}
          pending={handle.isPending}
        />
      ) : null}
    </div>
  )
}
