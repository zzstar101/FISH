import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Check,
  Circle,
  MessageCircle,
  PackageCheck,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import { transactionActionError } from './api'
import { orderStatusView } from './orders-page'
import { useCancelTransaction, useConfirmTransaction, useOrder } from './queries'

export function OrderDetailPage({ transactionId }: { transactionId: string }) {
  const { me } = useAuth()
  if (!me) return null
  return (
    <OrderDetailContent
      key={`${me.id}:${transactionId}`}
      ownerId={me.id}
      transactionId={transactionId}
    />
  )
}

function OrderDetailContent({
  ownerId,
  transactionId,
}: {
  ownerId: string
  transactionId: string
}) {
  const order = useOrder(ownerId, transactionId)
  const confirm = useConfirmTransaction(ownerId)
  const cancel = useCancelTransaction(ownerId)
  const [notice, setNotice] = useState<string | null>(null)

  if (order.isPending) return <LoadingState label="正在加载订单详情…" />
  if (order.isError) {
    return <ErrorState message="订单详情加载失败" onRetry={() => void order.refetch()} />
  }
  if (order.data === null) {
    return (
      <EmptyState
        action={
          <Link
            className="inline-flex h-9 items-center rounded-full bg-brand px-4 font-medium text-sm text-white hover:bg-lavender"
            to="/orders"
            search={{ role: 'buyer' }}
          >
            返回我的订单
          </Link>
        }
        description="订单可能不存在，或当前账号不是交易双方"
        emoji="🧾"
        title="找不到订单"
      />
    )
  }

  const detail = order.data
  const statusView = orderStatusView(detail.status)
  const pendingAction = confirm.isPending || cancel.isPending

  async function runAction(action: 'confirm' | 'cancel') {
    setNotice(null)
    try {
      if (action === 'confirm') await confirm.mutateAsync(detail.id)
      else await cancel.mutateAsync(detail.id)
    } catch (error) {
      const view = transactionActionError(error)
      setNotice(view.message)
      if (view.refresh) await order.refetch()
    }
  }

  return (
    <div className="space-y-6">
      <Link
        className="inline-flex items-center gap-2 text-ink-2 text-sm hover:text-brand"
        search={{ role: detail.role }}
        to="/orders"
      >
        <ArrowLeft className="size-4" />
        返回我的订单
      </Link>

      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-[26px] tracking-[-0.03em]">订单详情</h1>
            <Badge variant={statusView.variant}>{statusView.label}</Badge>
          </div>
          <p className="mt-1.5 text-ink-3 text-sm">
            {detail.role === 'buyer' ? '买入订单' : '卖出订单'} ·{' '}
            {formatRelativeTimeAt(detail.createdAt)}创建
          </p>
        </div>
        <p className="text-ink-3 text-xs">订单号 {detail.id}</p>
      </div>

      {notice !== null ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)] items-start gap-6">
        <div className="space-y-6">
          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-lg">交易商品</h2>
            <div className="mt-5 flex gap-5">
              <Link params={{ listingId: detail.listingId }} to="/listing/$listingId">
                <ListingThumb
                  alt={detail.listing.title}
                  className="size-32 rounded-2xl"
                  coverUrl={detail.listing.coverUrl}
                  listingId={detail.listingId}
                />
              </Link>
              <div className="min-w-0 flex-1">
                <Link
                  className="line-clamp-2 font-semibold text-lg hover:text-brand"
                  params={{ listingId: detail.listingId }}
                  to="/listing/$listingId"
                >
                  {detail.listing.title}
                </Link>
                <p className="mt-4 font-bold text-3xl text-danger">
                  {formatPrice(detail.amountCents)}
                </p>
                <p className="mt-2 text-ink-3 text-sm">
                  商品当前状态：{listingStatusLabel(detail.listing.status)}
                </p>
              </div>
            </div>
          </Card>

          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-lg">面交进度</h2>
            <div className="mt-5 space-y-4">
              <ProgressRow
                done={detail.buyerConfirmedAt !== null}
                label="买家确认完成"
                time={detail.buyerConfirmedAt}
              />
              <ProgressRow
                done={detail.sellerConfirmedAt !== null}
                label="卖家确认完成"
                time={detail.sellerConfirmedAt}
              />
              <ProgressRow
                done={detail.status === 'COMPLETED'}
                label="交易完成"
                time={detail.completedAt}
              />
              {detail.status === 'CANCELLED' ? (
                <ProgressRow done label="交易已取消" time={detail.cancelledAt} />
              ) : null}
            </div>
            <p className="mt-5 text-ink-3 text-xs leading-5">
              双方各确认一次后交易完成；只有服务端返回终态后页面才会显示完成。
            </p>
          </Card>
        </div>

        <aside className="sticky top-24 space-y-4">
          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-base">{detail.role === 'buyer' ? '卖家' : '买家'}</h2>
            <div className="mt-4 flex items-center gap-3">
              <UserAvatar
                avatarUrl={detail.counterpart.avatarUrl}
                className="size-12"
                emoji={detail.counterpart.nickname.slice(0, 1)}
                fallbackClassName="text-lg"
                size="lg"
              />
              <div className="min-w-0">
                <p className="truncate font-semibold">{detail.counterpart.nickname}</p>
                <p className="mt-1 text-ink-3 text-xs">交易对方</p>
              </div>
            </div>
            <Button asChild className="mt-5 w-full" variant="outline">
              <Link
                params={{ conversationId: detail.conversationId }}
                to="/messages/$conversationId"
              >
                <MessageCircle className="size-4" />
                去会话沟通
              </Link>
            </Button>
          </Card>

          <Card className="gap-0 border border-line p-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-brand" />
              <h2 className="font-semibold text-base">交易操作</h2>
            </div>
            {detail.status === 'PENDING_MEETUP' ? (
              <div className="mt-5 space-y-3">
                <Button
                  className="w-full"
                  disabled={pendingAction}
                  onClick={() => void runAction('confirm')}
                >
                  <PackageCheck className="size-4" />
                  {confirm.isPending ? '正在确认…' : '确认完成面交'}
                </Button>
                <Button
                  className="w-full"
                  disabled={pendingAction}
                  onClick={() => void runAction('cancel')}
                  variant="destructive"
                >
                  <XCircle className="size-4" />
                  {cancel.isPending ? '正在取消…' : '取消交易'}
                </Button>
              </div>
            ) : (
              <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-ink-3 text-sm">
                {detail.status === 'COMPLETED'
                  ? '交易已完成，订单为只读状态。'
                  : '交易已取消，订单为只读状态。'}
              </p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}

function ProgressRow({ done, label, time }: { done: boolean; label: string; time: string | null }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`grid size-8 place-items-center rounded-full ${
          done ? 'bg-success-soft text-success' : 'bg-surface-2 text-ink-3'
        }`}
      >
        {done ? <Check className="size-4" /> : <Circle className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{label}</p>
        <p className="mt-0.5 text-ink-3 text-xs">
          {time === null ? '待完成' : `${formatRelativeTimeAt(time)}完成`}
        </p>
      </div>
    </div>
  )
}

function listingStatusLabel(status: TransactionDto['listing']['status']): string {
  if (status === 'ACTIVE') return '在售'
  if (status === 'RESERVED') return '交易中'
  if (status === 'SOLD') return '已售出'
  return '已下架'
}
