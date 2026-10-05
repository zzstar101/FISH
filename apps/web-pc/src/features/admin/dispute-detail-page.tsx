import type {
  AdminDisputeDetail,
  AdminDisputeResolveInput,
  DisputeAttachment,
  DisputeStatus,
} from '@fish/contracts/disputes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { ForbiddenInline } from './admin-filter'
import { adminLoadOutcome, disputeResolveError } from './admin-messages'
import { useAdminDisputeDetail, useDisputeResolve } from './admin-queries'
import { withoutCursor } from './admin-search'
import {
  disputeResolutionMeta,
  disputeStatusMeta,
  disputeTypeLabel,
  formatAdminDateTime,
  transactionStatusMeta,
} from './admin-view'
import { DisputeResolveDialog } from './dispute-resolve-dialog'
import type { DisputesSearch } from './disputes-page'

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  // 不是「商品卡片」：服务端存的是消息正文，而 LISTING 消息的正文就是商品公开 id
  //（`apps/api/src/modules/messages/service.ts`），所以这里只能显示 `lst_…` 引用。
  LISTING: '商品引用',
  MEDIA: '图片/语音',
  SYSTEM: '系统消息',
  TEXT: '文字',
}

/**
 * 处理按钮与冲突横幅的显示条件。抽成纯函数是为了让「409 之后再不可提交」这条
 * 有测试可断言：仓库没有 DOM 测试设施（无 jsdom/happy-dom），静态渲染碰不到点击路径。
 */
export function disputeResolvePanel(state: { status: DisputeStatus; conflict: boolean }): {
  canResolve: boolean
  showConflictBanner: boolean
} {
  return {
    canResolve: state.status === 'PENDING' && !state.conflict,
    showConflictBanner: state.conflict,
  }
}

/**
 * 附件缩略图。签名链接约 15 分钟过期，管理员在详情页挂久了再滚到附件区只会看到碎图，
 * 所以给一条能解释原因、指向刷新动作的提示，而不是让 `<img>` 静默失败。
 */
function AttachmentThumb({ attachment }: { attachment: DisputeAttachment }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <p className="flex h-28 w-40 items-center justify-center rounded-xl border border-line bg-surface-2 px-2 text-center text-ink-3 text-xs">
        签名链接已过期，刷新页面重新获取
      </p>
    )
  }

  return (
    <a href={attachment.url} rel="noreferrer" target="_blank">
      <img
        alt={`附件 ${attachment.width}×${attachment.height}`}
        className="h-28 w-40 rounded-xl border border-line object-cover"
        onError={() => setFailed(true)}
        src={attachment.url}
      />
    </a>
  )
}

/**
 * 争议详情（#465 验收「详情、处理结论」）：争议内容 + 关联交易 + 附件 + 聊天证据 +
 * 同交易其它未决争议。处理只写结论与原因，不触发治理动作。
 */
export function DisputeDetailPage({
  disputeId,
  search,
}: {
  disputeId: string
  search: DisputesSearch
}) {
  const detail = useAdminDisputeDetail(disputeId)

  if (detail.isPending) return <LoadingState label="正在加载争议详情…" />
  if (detail.isError) {
    const outcome = adminLoadOutcome(detail.error)
    // 权限被撤的管理员要看得出是权限问题，而不是一个重试多少次都不会好的失败态。
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return (
      <ErrorState
        message={outcome.kind === 'error' ? outcome.message : '争议详情加载失败'}
        onRetry={() => void detail.refetch()}
      />
    )
  }

  return <DisputeDetailView detail={detail.data} disputeId={disputeId} search={search} />
}

/** 具名导出供静态渲染测试（同 `ModerationRow`）。 */
export function DisputeDetailView({
  detail,
  disputeId,
  search,
}: {
  detail: AdminDisputeDetail
  disputeId: string
  search: DisputesSearch
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const resolve = useDisputeResolve(disputeId)

  const { dispute } = detail.item
  const { transaction } = dispute
  const statusMeta = disputeStatusMeta(dispute.status)
  const panel = disputeResolvePanel({ status: dispute.status, conflict })

  async function submit(input: AdminDisputeResolveInput) {
    setDialogError(null)
    try {
      await resolve.mutateAsync(input)
      setDialogOpen(false)
    } catch (error) {
      const outcome = disputeResolveError(error)
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
            to="/admin/disputes"
          >
            ← 争议队列
          </Link>
          <h1 className="mt-1 font-semibold text-[26px] tracking-[-0.03em]">
            争议：{disputeTypeLabel(dispute.type)}「{transaction.listingTitle}」
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-ink-3 text-sm">
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
            {dispute.resolution !== null ? (
              <Badge variant={disputeResolutionMeta(dispute.resolution).variant}>
                {disputeResolutionMeta(dispute.resolution).label}
              </Badge>
            ) : null}
            <Badge variant="secondary">{formatPrice(transaction.amountCents)}</Badge>
            {detail.item.disputeCount > 1 ? (
              <Badge variant="warn">同交易共 {detail.item.disputeCount} 起</Badge>
            ) : null}
          </p>
        </div>
        {panel.canResolve ? (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialogOpen(true)
            }}
          >
            处理争议
          </Button>
        ) : null}
      </div>

      {panel.showConflictBanner ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          该争议已被处理或已撤回，列表已刷新。
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">争议内容</h2>
          <p className="whitespace-pre-wrap break-words text-sm">
            {dispute.detailText ?? '无补充说明'}
          </p>
          <p className="text-ink-3 text-xs">
            发起人 {dispute.initiator.nickname} → 被诉方 {dispute.respondent.nickname} · 提交于{' '}
            {formatAdminDateTime(dispute.createdAt)}
          </p>
          {dispute.resolutionNote !== null ? (
            <div className="rounded-xl bg-surface-2 p-3">
              <p className="font-medium text-sm">处理结论</p>
              <p className="mt-1 text-ink-2 text-sm">{dispute.resolutionNote}</p>
              <p className="mt-1 text-ink-3 text-xs">
                {dispute.handledBy !== null ? `处理人 ${dispute.handledBy.nickname}` : '处理人未知'}
                {dispute.handledAt !== null ? ` · ${formatAdminDateTime(dispute.handledAt)}` : ''}
              </p>
            </div>
          ) : null}
          {dispute.withdrawnAt !== null ? (
            <p className="rounded-xl bg-surface-2 p-3 text-ink-2 text-sm">
              发起人已于 {formatAdminDateTime(dispute.withdrawnAt)} 撤回，该争议不可再处理。
            </p>
          ) : null}
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">关联交易</h2>
          <p className="flex items-center gap-2 text-sm">
            <span>「{transaction.listingTitle}」</span>
            <Badge variant={transactionStatusMeta(transaction.status).variant}>
              {transactionStatusMeta(transaction.status).label}
            </Badge>
          </p>
          <p className="text-ink-2 text-sm">
            成交价 {formatPrice(transaction.amountCents)} · 买家 {transaction.buyer.nickname} · 卖家{' '}
            {transaction.seller.nickname}
          </p>
          <p className="text-ink-3 text-xs">
            创建于 {formatAdminDateTime(transaction.createdAt)}
            {transaction.completedAt !== null
              ? ` · 完成于 ${formatAdminDateTime(transaction.completedAt)}`
              : ''}
            {transaction.cancelledAt !== null
              ? ` · 取消于 ${formatAdminDateTime(transaction.cancelledAt)}`
              : ''}
          </p>
          <Link
            className="text-brand text-sm hover:underline"
            search={{ listingId: transaction.listingId }}
            to="/admin/transactions"
          >
            查看该商品的交易记录 →
          </Link>
          <Link
            className="text-brand text-sm hover:underline"
            params={{ listingId: transaction.listingId }}
            to="/admin/listings/$listingId"
          >
            查看商品详情（可执行治理）→
          </Link>

          {detail.related.length > 0 ? (
            <div>
              <p className="mt-2 font-medium text-sm">同交易的其它未决争议</p>
              <ul className="mt-1.5 space-y-1.5">
                {detail.related.map((related) => (
                  <li className="text-ink-2 text-xs" key={related.id}>
                    {disputeTypeLabel(related.type)} · {related.initiator.nickname} →{' '}
                    {related.respondent.nickname} · {formatAdminDateTime(related.createdAt)} ·{' '}
                    <Link
                      className="text-brand hover:underline"
                      params={{ disputeId: related.id }}
                      search={withoutCursor(search)}
                      to="/admin/disputes/$disputeId"
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

      <Card className="gap-3 border border-line p-5">
        <h2 className="font-semibold">附件（{detail.attachments.length}）</h2>
        {detail.attachments.length === 0 ? (
          <p className="text-ink-3 text-sm">没有附件。</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {detail.attachments.map((attachment) => (
              <li className="w-40" key={attachment.id}>
                <AttachmentThumb attachment={attachment} />
                <p className="mt-1 text-ink-3 text-xs">
                  {attachment.width}×{attachment.height} ·{' '}
                  {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB ·{' '}
                  {formatRelativeTimeAt(attachment.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink-3 text-xs">
          附件读取走短期签名链接（约 15 分钟过期），管理端不持有对象键。
        </p>
      </Card>

      <Card className="gap-3 border border-line p-5">
        <h2 className="font-semibold">聊天证据（{detail.evidence.length}）</h2>
        {detail.evidence.length === 0 ? (
          <p className="text-ink-3 text-sm">没有关联聊天证据。</p>
        ) : (
          <ul className="space-y-3">
            {detail.evidence.map((evidence) => (
              <li className="rounded-xl bg-surface-2 p-3" key={evidence.message.id}>
                <p className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
                  <Badge variant="secondary">
                    {EVIDENCE_TYPE_LABEL[evidence.message.type] ?? evidence.message.type}
                  </Badge>
                  <span>
                    {evidence.message.senderNickname ?? '系统'} ·{' '}
                    {formatAdminDateTime(evidence.message.createdAt)}
                  </span>
                  {evidence.message.recalledAt !== null ? (
                    <Badge variant="warn">发送者已撤回</Badge>
                  ) : null}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-ink-2 text-sm">
                  {evidence.message.content}
                </p>
                <p className="mt-1 text-ink-3 text-xs">
                  由 {evidence.addedBy.nickname} 关联于 {formatAdminDateTime(evidence.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink-3 text-xs">
          只展示被关联的单条消息，不提供整段会话；证据不可编辑、不可替换。「商品引用」是消息正文
          里记的商品公开 ID，不含标题。
        </p>
      </Card>

      {dialogOpen ? (
        <DisputeResolveDialog
          errorMessage={dialogError}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => void submit(input)}
          pending={resolve.isPending}
          subjectLabel={`${disputeTypeLabel(dispute.type)}「${transaction.listingTitle}」`}
        />
      ) : null}
    </div>
  )
}
