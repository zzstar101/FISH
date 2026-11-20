import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import type { AdminReportDetail, ReportTargetEvidence } from '@fish/contracts/reports/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { formatPrice } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { REPORT_STATUS_META, REPORT_TARGET_LABEL, reasonLabel } from '../reports/meta'
import { RATING_VIEW } from '../transaction-review/rating'
import { ForbiddenInline, NotFoundInline } from './admin-filter'
import { adminLoadView, reportHandleError } from './admin-messages'
import { useAdminReportDetail, useReportHandle } from './admin-queries'
import { withoutCursor } from './admin-search'
import { formatAdminDateTime, listingStatusMeta, moderationStatusMeta } from './admin-view'
import { ReportHandleDialog } from './report-handle-dialog'
import type { ReportsSearch } from './reports-page'

/**
 * 举报详情（#467 验收「详情、处理结果」）：举报 + 举报人 + 目标摘要（含商品当前状态，
 * 帮助判断是否还要下架）+ 同目标其它未决举报。处理只写结果，不触发治理。
 */
export function ReportDetailPage({
  reportId,
  search,
}: {
  reportId: string
  /** 来源队列的查询条件：返回/跳转同级详情时带回去（#467 五审 P2）。 */
  search: ReportsSearch
}) {
  const detail = useAdminReportDetail(reportId)

  if (detail.isPending) return <LoadingState label="正在加载举报详情…" />
  if (detail.isError) {
    const view = adminLoadView(detail.error, '举报详情加载失败')
    // 403 / 404 都不给「重试」（#467 五审 P3）：权限不会因重试改变，已删除的举报也不会回来。
    if (view.kind === 'forbidden') return <ForbiddenInline />
    if (view.kind === 'notFound') return <NotFoundInline label="举报" to="/admin/reports" />
    return <ErrorState message={view.message} onRetry={() => void detail.refetch()} />
  }

  return <ReportDetailView detail={detail.data} reportId={reportId} search={search} />
}

function ReportDetailView({
  detail,
  reportId,
  search,
}: {
  detail: AdminReportDetail
  reportId: string
  search: ReportsSearch
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const handle = useReportHandle(reportId)

  const { item } = detail
  const statusMeta = REPORT_STATUS_META[item.report.status]
  const { evidence, target } = item
  const isListingTarget = target.targetType === 'LISTING'
  const isMessageTarget = target.targetType === 'MESSAGE'
  const targetKindLabel = REPORT_TARGET_LABEL[target.targetType]
  const targetUrl = isListingTarget
    ? `/admin/listings/${target.targetId}`
    : `/admin/users/${target.targetId}`
  // 留言/评价/愿望没有独立的管理端详情页；可执行治理的对象是内容作者，公开 ID 在快照里。
  const targetAuthor =
    evidence === null || evidence.targetType === 'MESSAGE'
      ? null
      : evidence.targetType === 'COMMENT' || evidence.targetType === 'REVIEW'
        ? evidence.author
        : evidence.owner
  const targetAuthorUrl = targetAuthor !== null ? `/admin/users/${targetAuthor.id}` : null

  async function submit(input: { result: 'HANDLED' | 'REJECTED'; reason: string }) {
    setDialogError(null)
    try {
      await handle.mutateAsync(input)
      setDialogOpen(false)
    } catch (error) {
      const outcome = reportHandleError(error)
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
            to="/admin/reports"
          >
            ← 举报队列
          </Link>
          <h1 className="mt-1 font-semibold text-[26px] tracking-[-0.03em]">
            举报：{targetKindLabel}「{item.target.label}」
          </h1>
          <p className="mt-1.5 flex items-center gap-2 text-ink-3 text-sm">
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
            <Badge variant="secondary">
              {reasonLabel(item.target.targetType, item.report.reason)}
            </Badge>
            {item.reportCount > 1 ? (
              <Badge variant="warn">共 {item.reportCount} 人举报</Badge>
            ) : null}
          </p>
        </div>
        {item.report.status === 'PENDING' && !conflict ? (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialogOpen(true)
            }}
          >
            处理举报
          </Button>
        ) : null}
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          该举报已被其他管理员处理，列表已刷新。
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">举报内容</h2>
          <p className="text-sm">{item.report.detailText ?? '无补充说明'}</p>
          <p className="text-ink-3 text-xs">
            举报人 {item.reporter.nickname} · 提交于 {formatAdminDateTime(item.report.createdAt)}
            {item.report.handledAt !== null
              ? ` · 处理于 ${formatAdminDateTime(item.report.handledAt)}`
              : ''}
          </p>
          {item.report.handlingReason !== null ? (
            <div className="rounded-xl bg-surface-2 p-3">
              <p className="font-medium text-sm">处理结果</p>
              <p className="mt-1 text-ink-2 text-sm">{item.report.handlingReason}</p>
              {item.report.handledBy !== null ? (
                <p className="mt-1 text-ink-3 text-xs">处理人 {item.report.handledBy.nickname}</p>
              ) : null}
            </div>
          ) : null}
        </Card>

        {item.evidence !== null ? (
          <EvidenceCard evidence={item.evidence} reportId={reportId} />
        ) : null}

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">被举报目标</h2>
          <p className="text-sm">
            {targetKindLabel}「{item.target.label}」
          </p>
          <p className="text-ink-3 text-xs">目标公开 ID：{item.target.targetId}</p>
          {isListingTarget && item.target.listingStatus !== null ? (
            <p className="flex items-center gap-2 text-ink-2 text-sm">
              当前状态：
              <Badge variant={listingStatusMeta(item.target.listingStatus).variant}>
                {listingStatusMeta(item.target.listingStatus).label}
              </Badge>
              {item.target.moderationStatus !== null ? (
                <Badge variant={moderationStatusMeta(item.target.moderationStatus).variant}>
                  {moderationStatusMeta(item.target.moderationStatus).label}
                </Badge>
              ) : null}
            </p>
          ) : null}
          {isMessageTarget ? (
            <a className="text-brand text-sm hover:underline" href="#message-evidence">
              查看消息证据 →
            </a>
          ) : evidence?.targetType === 'COMMENT' ? (
            <div className="flex flex-wrap gap-3">
              {targetAuthorUrl !== null ? (
                <Link className="text-brand text-sm hover:underline" to={targetAuthorUrl}>
                  查看留言作者（可执行治理）→
                </Link>
              ) : null}
              <Link
                className="text-brand text-sm hover:underline"
                params={{ listingId: evidence.listingId }}
                to="/admin/listings/$listingId"
              >
                查看所属商品 →
              </Link>
            </div>
          ) : evidence?.targetType === 'REVIEW' ? (
            <div className="flex flex-wrap gap-3">
              {targetAuthorUrl !== null ? (
                <Link className="text-brand text-sm hover:underline" to={targetAuthorUrl}>
                  查看评价作者（可执行治理）→
                </Link>
              ) : null}
              <a className="text-brand text-sm hover:underline" href="#review-evidence">
                查看评价证据 →
              </a>
            </div>
          ) : evidence?.targetType === 'WISH' ? (
            <div className="flex flex-wrap gap-3">
              {targetAuthorUrl !== null ? (
                <Link className="text-brand text-sm hover:underline" to={targetAuthorUrl}>
                  查看许愿人详情（可执行治理）→
                </Link>
              ) : null}
              <a className="text-brand text-sm hover:underline" href="#wish-evidence">
                查看愿望证据 →
              </a>
            </div>
          ) : (
            <Link className="text-brand text-sm hover:underline" to={targetUrl}>
              {isListingTarget ? '查看商品详情 →' : '查看用户详情（可执行治理）→'}
            </Link>
          )}

          {detail.related.length > 0 ? (
            <div>
              <p className="mt-2 font-medium text-sm">同目标的其它未决举报</p>
              <ul className="mt-1.5 space-y-1.5">
                {detail.related.map((related) => (
                  <li className="text-ink-2 text-xs" key={related.id}>
                    {reasonLabel(item.target.targetType, related.reason)} ·{' '}
                    {formatAdminDateTime(related.createdAt)} ·{' '}
                    <Link
                      className="text-brand hover:underline"
                      params={{ reportId: related.id }}
                      search={withoutCursor(search)}
                      to="/admin/reports/$reportId"
                    >
                      查看
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>

      {dialogOpen ? (
        <ReportHandleDialog
          errorMessage={dialogError}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => void submit(input)}
          pending={handle.isPending}
          targetLabel={item.target.label}
        />
      ) : null}
    </div>
  )
}

const WISH_STATUS_LABEL = {
  ACTIVE: '进行中',
  CLOSED: '已关闭',
  FULFILLED: '已达成',
} as const

const WISH_MODERATION_LABEL = {
  APPROVED: '审核通过',
  PENDING_REVIEW: '待审核',
  REJECTED: '已驳回',
} as const

function wishBudgetLabel(min: number | null, max: number | null): string {
  if (min === null && max === null) return '未填预算'
  if (min !== null && max !== null) return `${formatPrice(min)} – ${formatPrice(max)}`
  return min !== null ? `${formatPrice(min)} 起` : `不超过 ${formatPrice(max as number)}`
}

/**
 * 服务端取证快照卡（#694 M7）：消息/留言/评价/愿望各一种形态，媒体一律经
 * admin 守卫的证据端点流式读取，详情响应里不出现私有 objectKey。
 */
function EvidenceCard({
  evidence,
  reportId,
}: {
  evidence: ReportTargetEvidence
  reportId: string
}) {
  switch (evidence.targetType) {
    case 'MESSAGE':
      return (
        <Card className="gap-3 border border-line p-5" id="message-evidence">
          <h2 className="font-semibold">消息证据（服务端快照）</h2>
          {evidence.kind === 'TEXT' ? (
            <p className="text-sm">{evidence.content}</p>
          ) : evidence.kind === 'IMAGE' ? (
            <img
              alt="被举报图片消息"
              className="max-h-[420px] w-auto rounded-lg border border-line object-contain"
              src={`/api${ADMIN_ROUTES.reportEvidenceMedia(reportId)}`}
            />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: 私聊语音没有字幕轨道；证据仅管理员复核。
            <audio
              className="w-full"
              controls
              src={`/api${ADMIN_ROUTES.reportEvidenceMedia(reportId)}`}
            />
          )}
          {evidence.kind === 'TEXT' ? null : (
            <p className="text-ink-3 text-xs">
              {evidence.kind === 'IMAGE' ? '图片' : '语音'}消息（{evidence.mimeType ?? '未知类型'}，
              {evidence.sizeBytes ?? 0} 字节）
            </p>
          )}
          <p className="text-ink-3 text-xs">
            发送者 {evidence.senderNickname} · 发送于 {formatAdminDateTime(evidence.createdAt)}
            {evidence.recalledAt !== null
              ? ` · 取证时该消息已撤回（${formatAdminDateTime(evidence.recalledAt)}），快照保留`
              : ''}
          </p>
        </Card>
      )
    case 'COMMENT':
      return (
        <Card className="gap-3 border border-line p-5" id="comment-evidence">
          <h2 className="font-semibold">留言证据（服务端快照）</h2>
          <p className="whitespace-pre-wrap text-sm">{evidence.content}</p>
          <p className="text-ink-3 text-xs">
            作者 {evidence.author.nickname} · 发表于 {formatAdminDateTime(evidence.createdAt)}
            {evidence.parentId !== null ? ' · 这是一条回复' : ''}
          </p>
        </Card>
      )
    case 'REVIEW':
      return (
        <Card className="gap-3 border border-line p-5" id="review-evidence">
          <h2 className="font-semibold">评价证据（服务端快照）</h2>
          <p>
            <Badge variant={RATING_VIEW[evidence.rating].variant}>
              {RATING_VIEW[evidence.rating].label}
            </Badge>
          </p>
          {evidence.body !== null ? (
            <p className="whitespace-pre-wrap text-sm">{evidence.body}</p>
          ) : (
            <p className="text-ink-3 text-sm">仅评分，没有文字正文。</p>
          )}
          {evidence.imageCount > 0 ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: evidence.imageCount }, (_, index) => (
                <img
                  alt={`被举报评价配图 ${index + 1}`}
                  className="h-28 w-28 rounded-lg border border-line object-cover"
                  // biome-ignore lint/suspicious/noArrayIndexKey: 快照只存图片数量，序号即身份
                  key={`${reportId}-${index}`}
                  src={`/api${ADMIN_ROUTES.reportEvidenceMedia(reportId, index)}`}
                />
              ))}
            </div>
          ) : null}
          <p className="text-ink-3 text-xs">
            作者 {evidence.author.nickname} · 评价于 {formatAdminDateTime(evidence.createdAt)} ·
            交易编号 {evidence.transactionId}
          </p>
        </Card>
      )
    case 'WISH':
      return (
        <Card className="gap-3 border border-line p-5" id="wish-evidence">
          <h2 className="font-semibold">愿望证据（服务端快照）</h2>
          <p className="font-medium text-sm">「{evidence.keyword}」</p>
          {evidence.description !== null ? (
            <p className="whitespace-pre-wrap text-sm">{evidence.description}</p>
          ) : null}
          <p className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
            <span>
              {evidence.category === null ? '不限分类' : categoryLabel(evidence.category)}
            </span>
            <span>·</span>
            <span>预算 {wishBudgetLabel(evidence.budgetMinCents, evidence.budgetMaxCents)}</span>
            <Badge variant="secondary">{WISH_STATUS_LABEL[evidence.status]}</Badge>
            <Badge variant="secondary">{WISH_MODERATION_LABEL[evidence.moderationStatus]}</Badge>
          </p>
          <p className="text-ink-3 text-xs">
            许愿人 {evidence.owner.nickname} · 发布于 {formatAdminDateTime(evidence.createdAt)}
          </p>
        </Card>
      )
  }
}
