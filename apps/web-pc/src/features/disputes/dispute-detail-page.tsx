import type {
  DisputeAttachment,
  DisputeDetail,
  DisputeEvidence,
  DisputeType,
} from '@fish/contracts/disputes/schema'
import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@fish/ui/alert-dialog'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Clock,
  ImagePlus,
  Loader2,
  MessageSquareQuote,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { type ChangeEvent, useRef, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import { orderStatusView } from '../profile/orders-page'
import { EvidencePickerDialog } from './evidence-picker-dialog'
import {
  DISPUTE_RESOLUTION_META,
  DISPUTE_STATUS_META,
  disputeTypeLabel,
  MAX_DISPUTE_ATTACHMENTS,
} from './meta'
import { useDispute, useUploadDisputeAttachment, useWithdrawDispute } from './queries'
import {
  canAddDisputeAttachment,
  canSupplementDispute,
  canWithdrawDispute,
  disputeFailureText,
  disputeMessagePreview,
  disputeViewerRole,
  shortDisputeId,
} from './view'

/**
 * 争议详情（当事人视角）。
 *
 * - 发起人：`PENDING` 时可撤回、补附件（≤6）、从交易会话选聊天证据；
 * - 被诉方：只读（服务端写入方只有发起人，被诉方调写接口会 404）；
 * - 404 `DISPUTE_NOT_FOUND` 对当事人之外的人也是这个码，端上按「不存在或无权查看」渲染。
 */
export function DisputeDetailPage({ disputeId }: { disputeId: string }) {
  const { me } = useAuth()
  if (!me) return null
  return (
    <DisputeDetailContent key={`${me.id}:${disputeId}`} disputeId={disputeId} viewerId={me.id} />
  )
}

function DisputeDetailContent({ disputeId, viewerId }: { disputeId: string; viewerId: string }) {
  const dispute = useDispute(disputeId)

  if (dispute.isPending) return <LoadingState label="正在加载争议详情…" />
  if (dispute.isError) {
    if (dispute.error instanceof ApiError && dispute.error.code === 'DISPUTE_NOT_FOUND') {
      return (
        <EmptyState
          action={
            <Button asChild variant="outline">
              <Link to="/disputes">返回我的争议</Link>
            </Button>
          }
          description="争议不存在，或当前账号不是这笔交易的当事人"
          emoji="🔍"
          title="找不到争议"
        />
      )
    }
    return <ErrorState message="争议详情加载失败" onRetry={() => void dispute.refetch()} />
  }

  const detail = dispute.data
  const status = DISPUTE_STATUS_META[detail.status]
  const viewerRole = disputeViewerRole(detail, viewerId)
  const canWithdraw = canWithdrawDispute(detail, viewerId)
  const canSupplement = canSupplementDispute(detail, viewerId)
  const canAddAttachment = canAddDisputeAttachment(detail, viewerId, detail.attachments.length)

  return (
    <div className="space-y-6">
      <Link
        className="inline-flex items-center gap-2 text-ink-2 text-sm hover:text-brand"
        to="/disputes"
      >
        <ArrowLeft className="size-4" />
        返回我的争议
      </Link>

      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-[26px] tracking-[-0.03em]">争议详情</h1>
            <Badge shape="pill" variant={status.variant}>
              {status.label}
            </Badge>
          </div>
          <p className="mt-1.5 text-ink-3 text-sm">
            {disputeTypeLabel(detail.type)} ·{' '}
            {viewerRole === 'initiator' ? '你是发起人' : '你是被诉方'} ·{' '}
            {formatRelativeTimeAt(detail.createdAt)}提交
          </p>
        </div>
        <p className="text-ink-3 text-xs">争议编号 {shortDisputeId(detail.id)}</p>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <div className="space-y-6">
          <TradeSummaryCard dispute={detail} viewerId={viewerId} />
          <DetailTextCard detailText={detail.detailText} type={detail.type} />
          <EvidenceCard
            canSupplement={canSupplement}
            disputeId={detail.id}
            evidence={detail.evidence}
            transactionId={detail.transaction.id}
          />
          <AttachmentCard
            attachments={detail.attachments}
            canAdd={canAddAttachment}
            disputeId={detail.id}
            supplementAllowed={canSupplement}
          />
        </div>

        <aside className="space-y-4">
          <ConclusionCard detail={detail} />
          <ActionCard
            canSupplement={canSupplement}
            canWithdraw={canWithdraw}
            disputeId={detail.id}
            viewerRole={viewerRole}
          />
          <PartiesCard dispute={detail} viewerId={viewerId} />
        </aside>
      </div>
    </div>
  )
}

function TradeSummaryCard({ dispute, viewerId }: { dispute: DisputeDetail; viewerId: string }) {
  const transaction = dispute.transaction
  const tradeStatus = orderStatusView(transaction.status)
  return (
    <Card className="gap-0 border border-line p-6">
      <h2 className="font-semibold text-lg">交易信息</h2>
      <div className="mt-5 space-y-3 text-sm">
        <div className="flex items-start justify-between gap-4">
          <Link
            className="line-clamp-2 font-medium hover:text-brand"
            params={{ listingId: transaction.listingId }}
            to="/listing/$listingId"
          >
            {transaction.listingTitle}
          </Link>
          <span className="shrink-0 font-bold text-danger">
            {formatPrice(transaction.amountCents)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
          <span>买家 {transaction.buyer.nickname}</span>
          <span>·</span>
          <span>卖家 {transaction.seller.nickname}</span>
          <span>·</span>
          <Badge shape="pill" variant={tradeStatus.variant}>
            交易{tradeStatus.label}
          </Badge>
        </div>
        <Link
          className="inline-flex items-center gap-1 text-brand text-sm hover:underline"
          params={{ transactionId: transaction.id }}
          search={{ role: viewerId === transaction.buyer.id ? 'buyer' : 'seller' }}
          to="/orders/$transactionId"
        >
          查看订单详情
        </Link>
      </div>
    </Card>
  )
}

function DetailTextCard({ detailText, type }: { detailText: string | null; type: DisputeType }) {
  return (
    <Card className="gap-0 border border-line p-6">
      <h2 className="font-semibold text-lg">争议说明</h2>
      <p className="mt-3 text-ink-3 text-sm">类型：{disputeTypeLabel(type)}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6">
        {detailText ?? '发起时未填写补充说明。'}
      </p>
    </Card>
  )
}

function EvidenceCard({
  canSupplement,
  disputeId,
  evidence,
  transactionId,
}: {
  canSupplement: boolean
  disputeId: string
  evidence: DisputeEvidence[]
  transactionId: string
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <MessageSquareQuote className="size-5 text-brand" />
          <h2 className="font-semibold text-lg">聊天证据</h2>
        </div>
        {canSupplement ? (
          <Button onClick={() => setPickerOpen(true)} size="sm" variant="outline">
            选择聊天证据
          </Button>
        ) : null}
      </div>

      {evidence.length === 0 ? (
        <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-ink-3 text-sm">
          还没有关联聊天证据。
          {canSupplement ? '可以从这笔交易的会话里选一条消息作为证据。' : ''}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {evidence.map((item) => (
            <li
              className="rounded-xl border border-line px-4 py-3"
              key={`${item.message.id}:${item.addedBy.id}`}
            >
              <p className="text-ink-3 text-xs">
                {item.message.senderNickname ?? '系统'} ·{' '}
                {formatRelativeTimeAt(item.message.createdAt)}
              </p>
              <p className="mt-1 text-sm leading-6">{disputeMessagePreview(item.message)}</p>
            </li>
          ))}
        </ul>
      )}

      {canSupplement ? (
        <EvidencePickerDialog
          disputeId={disputeId}
          existingMessageIds={evidence.map((item) => item.message.id)}
          onOpenChange={setPickerOpen}
          open={pickerOpen}
          transactionId={transactionId}
        />
      ) : null}
    </Card>
  )
}

function AttachmentCard({
  attachments,
  canAdd,
  disputeId,
  supplementAllowed,
}: {
  attachments: DisputeAttachment[]
  canAdd: boolean
  disputeId: string
  supplementAllowed: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadDisputeAttachment(disputeId)

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    upload.mutate(file)
  }

  const uploadErrorMessage =
    upload.error === null
      ? null
      : upload.error instanceof ApiError
        ? disputeFailureText(upload.error.code)
        : upload.error instanceof Error
          ? upload.error.message
          : '图片上传失败，请重试'

  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <ImagePlus className="size-5 text-brand" />
          <h2 className="font-semibold text-lg">图片附件</h2>
        </div>
        <span className="text-ink-3 text-xs">
          {attachments.length}/{MAX_DISPUTE_ATTACHMENTS}
        </span>
      </div>

      {attachments.length === 0 ? (
        <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-ink-3 text-sm">
          还没有上传图片附件。
          {supplementAllowed ? '可以补充商品现状、聊天截图等图片。' : ''}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {attachments.map((attachment, index) => (
            <a
              className="group block overflow-hidden rounded-xl border border-line"
              href={attachment.url}
              key={attachment.id}
              rel="noreferrer"
              target="_blank"
            >
              <img
                alt={`争议附件 ${index + 1}（${attachment.mimeType}）`}
                className="aspect-square w-full object-cover transition-transform group-hover:scale-[1.02]"
                src={attachment.url}
              />
              <span className="block px-2 py-1.5 text-ink-3 text-xs">
                {attachment.uploadedBy.nickname} · {formatRelativeTimeAt(attachment.createdAt)}
              </span>
            </a>
          ))}
        </div>
      )}

      {canAdd ? (
        <div className="mt-4 space-y-2">
          <input
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            className="hidden"
            onChange={handleFile}
            ref={inputRef}
            type="file"
          />
          <Button
            disabled={upload.isPending}
            onClick={() => inputRef.current?.click()}
            size="sm"
            variant="outline"
          >
            {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {upload.isPending ? '正在上传…' : '上传图片'}
          </Button>
          <p className="text-ink-3 text-xs leading-5">
            支持 JPG / PNG / WebP / HEIC，单张不超过 5MB，最多 {MAX_DISPUTE_ATTACHMENTS} 张。
          </p>
          {uploadErrorMessage !== null ? (
            <p className="text-danger text-xs" role="alert">
              {uploadErrorMessage}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

function ConclusionCard({ detail }: { detail: DisputeDetail }) {
  const status = DISPUTE_STATUS_META[detail.status]
  const resolution = detail.resolution === null ? null : DISPUTE_RESOLUTION_META[detail.resolution]

  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-brand" />
        <h2 className="font-semibold text-base">处理进度</h2>
      </div>

      {detail.status === 'PENDING' ? (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Clock className="size-4 text-warn" />
            <span>平台正在核实，请耐心等待。</span>
          </div>
          <p className="text-ink-3 text-xs leading-5">
            处理期间可以继续补充图片与聊天证据；结论会作为最终结论展示在这里。
          </p>
        </div>
      ) : null}

      {detail.status === 'RESOLVED' && resolution === null ? (
        <div className="mt-4 space-y-3">
          <Badge shape="pill" variant={status.variant}>
            {status.label}
          </Badge>
          <p className="text-ink-2 text-sm leading-6">平台已处理，未提供结论说明。</p>
          <p className="text-ink-3 text-xs">
            {detail.handledBy === null ? '平台' : detail.handledBy.nickname} ·{' '}
            {detail.handledAt === null ? '已处理' : `${formatRelativeTimeAt(detail.handledAt)}处理`}
          </p>
        </div>
      ) : null}

      {detail.status === 'RESOLVED' && resolution !== null ? (
        <div className="mt-4 space-y-3">
          <Badge shape="pill" variant={resolution.variant}>
            {resolution.label}
          </Badge>
          <p className="text-ink-2 text-sm leading-6">{resolution.description}</p>
          {detail.resolutionNote !== null ? (
            <div className="rounded-xl bg-surface-2 px-4 py-3">
              <p className="text-ink-3 text-xs">处理说明</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{detail.resolutionNote}</p>
            </div>
          ) : null}
          <p className="text-ink-3 text-xs">
            {detail.handledBy === null ? '平台' : detail.handledBy.nickname} ·{' '}
            {detail.handledAt === null ? '已处理' : `${formatRelativeTimeAt(detail.handledAt)}处理`}
          </p>
        </div>
      ) : null}

      {detail.status === 'WITHDRAWN' ? (
        <div className="mt-4 space-y-2">
          <Badge shape="pill" variant={status.variant}>
            已撤回
          </Badge>
          <p className="text-ink-3 text-xs">
            {detail.withdrawnAt === null
              ? '发起人已撤回该争议。'
              : `${formatRelativeTimeAt(detail.withdrawnAt)}由发起人撤回。`}
          </p>
        </div>
      ) : null}
    </Card>
  )
}

function ActionCard({
  canSupplement,
  canWithdraw,
  disputeId,
  viewerRole,
}: {
  canSupplement: boolean
  canWithdraw: boolean
  disputeId: string
  viewerRole: 'initiator' | 'respondent'
}) {
  const withdraw = useWithdrawDispute(disputeId)
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <Card className="gap-0 border border-line p-6">
      <h2 className="font-semibold text-base">我的操作</h2>

      {viewerRole === 'respondent' ? (
        <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-ink-3 text-sm leading-6">
          你是被诉方，只能查看材料与结论；补充材料由发起人提交。
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {canWithdraw ? (
            <AlertDialog
              onOpenChange={(open) => {
                setConfirmOpen(open)
                // 关闭即清空上一次失败的 mutation 状态，下次打开看到的是干净的确认框。
                if (!open) withdraw.reset()
              }}
              open={confirmOpen}
            >
              <AlertDialogTrigger asChild>
                <Button variant="destructive">
                  <XCircle className="size-4" />
                  撤回争议
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>撤回这条争议？</AlertDialogTitle>
                  <AlertDialogDescription>
                    撤回后争议进入终态，不能撤销或重新发起同一条争议。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {/* 失败原因放在弹窗内：否则会被遮罩挡住的页面级 Alert 用户根本看不到。 */}
                {withdraw.error !== null ? (
                  <Alert variant="destructive">
                    <AlertTitle>撤回失败</AlertTitle>
                    <AlertDescription>
                      {disputeFailureText(
                        withdraw.error instanceof ApiError ? withdraw.error.code : null,
                      )}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={withdraw.isPending}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={withdraw.isPending}
                    onClick={(event) => {
                      event.preventDefault()
                      withdraw.mutate(undefined, {
                        onSuccess: () => setConfirmOpen(false),
                      })
                    }}
                    variant="destructive"
                  >
                    {withdraw.isPending ? '正在撤回…' : '确认撤回'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}

          {canSupplement ? (
            <p className="text-ink-3 text-xs leading-5">争议处理中，可以继续补充图片与聊天证据。</p>
          ) : null}

          {!canWithdraw && !canSupplement ? (
            <p className="rounded-xl bg-surface-2 px-4 py-3 text-ink-3 text-sm">
              该争议已结束，不能继续操作。
            </p>
          ) : null}
        </div>
      )}
    </Card>
  )
}

function PartiesCard({ dispute, viewerId }: { dispute: DisputeDetail; viewerId: string }) {
  const isInitiator = dispute.initiator.id === viewerId
  return (
    <Card className="gap-0 border border-line p-6">
      <h2 className="font-semibold text-base">争议双方</h2>
      <div className="mt-4 space-y-3">
        <PartyRow
          label={isInitiator ? '发起人（你）' : '发起人'}
          nickname={dispute.initiator.nickname}
        />
        <PartyRow
          label={isInitiator ? '被诉方' : '被诉方（你）'}
          nickname={dispute.respondent.nickname}
        />
      </div>
    </Card>
  )
}

function PartyRow({ label, nickname }: { label: string; nickname: string }) {
  return (
    <div className="flex items-center gap-3">
      <UserAvatar
        avatarUrl={null}
        className="size-10"
        emoji={nickname.slice(0, 1)}
        fallbackClassName="text-base"
        size="lg"
      />
      <div className="min-w-0">
        <p className="truncate font-medium text-sm">{nickname}</p>
        <p className="mt-0.5 text-ink-3 text-xs">{label}</p>
      </div>
    </div>
  )
}
