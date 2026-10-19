import type { Dispute } from '@fish/contracts/disputes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import { orderStatusView } from '../profile/orders-page'
import { DISPUTE_EMPTY_COPY, DISPUTE_STATUS_META, disputeTypeLabel } from './meta'
import { useMyDisputes } from './queries'
import { disputeCounterpart, shortDisputeId } from './view'

/**
 * 「我的争议」：我发起 + 我被诉的交易争议（游标分页）。
 *
 * `/disputes` 落在 `__root.tsx` 的 `RequireAuth` 分支里，因此这里 `me` 必定存在
 * （仍显式收口，避免类型分支散落）。
 */
export function MyDisputesPage() {
  const { me } = useAuth()
  if (!me) return null
  return <MyDisputesContent key={me.id} viewerId={me.id} />
}

function MyDisputesContent({ viewerId }: { viewerId: string }) {
  const disputes = useMyDisputes(true)
  const items = disputes.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="mx-auto max-w-[980px] space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的争议</h1>
          <p className="mt-1.5 text-ink-3 text-sm">你发起或涉及的交易争议与处理进度。</p>
        </div>
        <Link
          className="text-brand text-sm hover:underline"
          to="/orders"
          search={{ role: 'buyer' }}
        >
          去我的订单
        </Link>
      </div>

      {disputes.isPending ? <LoadingState label="正在加载争议记录…" /> : null}
      {disputes.isError ? (
        <ErrorState message="争议记录加载失败" onRetry={() => void disputes.refetch()} />
      ) : null}

      {disputes.isSuccess && items.length === 0 ? (
        <EmptyState
          description={DISPUTE_EMPTY_COPY.text}
          emoji="⚖️"
          title={DISPUTE_EMPTY_COPY.title}
        />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 overflow-hidden border border-line p-0">
          <ul className="divide-y divide-line">
            {items.map((dispute) => (
              <li key={dispute.id}>
                <DisputeRow dispute={dispute} viewerId={viewerId} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {disputes.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            disabled={disputes.isFetchingNextPage}
            onClick={() => void disputes.fetchNextPage()}
            variant="outline"
          >
            {disputes.isFetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : null}
            {disputes.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}

      {disputes.isFetchNextPageError ? (
        <p className="text-center text-danger text-xs">加载更多失败，请重试</p>
      ) : null}
    </div>
  )
}

function DisputeRow({ dispute, viewerId }: { dispute: Dispute; viewerId: string }) {
  const status = DISPUTE_STATUS_META[dispute.status]
  const tradeStatus = orderStatusView(dispute.transaction.status)
  const counterpart = disputeCounterpart(dispute, viewerId)

  return (
    <Link
      className="block px-5 py-4 transition-colors hover:bg-surface-2"
      params={{ disputeId: dispute.id }}
      to="/disputes/$disputeId"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-sm">
            {disputeTypeLabel(dispute.type)}
            <span className="text-ink-3">·</span>
            <span className="truncate text-ink-2">{dispute.transaction.listingTitle}</span>
          </p>
          <p className="mt-1 truncate text-ink-3 text-xs">
            与 {counterpart.nickname} · 交易{tradeStatus.label} ·{' '}
            {formatPrice(dispute.transaction.amountCents)}
          </p>
          <p className="mt-1 text-ink-3 text-xs">
            {formatRelativeTimeAt(dispute.createdAt)}提交 · 编号 {shortDisputeId(dispute.id)}
          </p>
        </div>
        <Badge shape="pill" variant={status.variant}>
          {status.label}
        </Badge>
      </div>
    </Link>
  )
}
