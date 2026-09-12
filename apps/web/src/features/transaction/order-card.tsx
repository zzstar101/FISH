import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Thumb } from '@fish/ui/thumb'
import { useNavigate } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import type * as React from 'react'
import { formatPrice, formatRelativeTime } from '../../lib/format'
import type { OrderView } from '../../lib/mock/store'
import type { OrderStatus } from '../../lib/mock/types'
import {
  useAcceptOrder,
  useCancelOrder,
  useContactCounterpart,
  useFinishOrder,
  useRejectOrder,
} from './queries'

type ChipTone = NonNullable<React.ComponentProps<typeof Badge>['variant']>

const STATUS: Record<OrderStatus, { label: string; tone: ChipTone }> = {
  REQUESTED: { label: '待确认', tone: 'lavender' },
  PENDING_MEETUP: { label: '待面交', tone: 'lavender' },
  COMPLETED: { label: '已完成', tone: 'success' },
  REJECTED: { label: '已拒绝', tone: 'secondary' },
  CANCELLED: { label: '已取消', tone: 'secondary' },
}

/** 交易卡（#11）：状态、权限按钮与状态机动作都收敛在这里。 */
export function OrderCard({ order }: { order: OrderView }) {
  const navigate = useNavigate()
  const accept = useAcceptOrder()
  const cancel = useCancelOrder()
  const finish = useFinishOrder()
  const reject = useRejectOrder()
  const contact = useContactCounterpart()
  const status = STATUS[order.status]
  const isBuyer = order.role === 'buy'

  const openChat = () => {
    contact.mutate(
      { peerId: order.counterpartId, listingId: order.listingId },
      {
        onSuccess: (conversationId) =>
          void navigate({ to: '/chat/$conversationId', params: { conversationId } }),
      },
    )
  }

  return (
    <article className="rounded-2xl bg-surface p-3">
      <div className="flex items-center gap-2">
        <Badge variant={isBuyer ? 'lavender' : 'brand'}>{isBuyer ? '买入' : '卖出'}</Badge>
        <span className="text-ink-3 text-xs">{formatRelativeTime(order.minutesAgo)}</span>
        <Badge className="ml-auto" variant={status.tone}>
          {status.label}
        </Badge>
      </div>

      <button
        className="mt-3 flex w-full items-start gap-3 text-left"
        onClick={() =>
          void navigate({
            to: '/detail/$listingId',
            params: { listingId: order.listingId },
          })
        }
        type="button"
      >
        <Thumb
          className="size-20 rounded-xl"
          emoji={order.listing.emoji}
          emojiClassName="text-[2rem]"
          tone={order.listing.tone}
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-medium text-[15px] leading-snug">{order.listing.title}</p>
          <p className="mt-1 truncate text-ink-3 text-xs">
            {order.listing.tradeMethod} · {order.listing.campus}
          </p>
          <p className="mt-0.5 truncate text-ink-3 text-xs">
            {isBuyer ? '卖家' : '买家'}:{order.counterpart.nickname}
          </p>
        </div>
        <span className="shrink-0 font-semibold text-lg">
          {formatPrice(order.listing.priceCents)}
        </span>
      </button>

      {order.status === 'COMPLETED' ||
      order.status === 'CANCELLED' ||
      order.status === 'REJECTED' ? null : (
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={openChat} size="sm" variant="outline">
            <MessageCircle className="size-3" />
            联系 TA
          </Button>

          {isBuyer && order.status === 'PENDING_MEETUP' ? (
            <>
              <Button onClick={() => cancel.mutate(order.id)} size="sm" variant="destructive">
                取消交易
              </Button>
              <Button onClick={() => finish.mutate(order.id)} size="sm">
                确认面交,完成交易
              </Button>
            </>
          ) : null}

          {isBuyer && order.status === 'REQUESTED' ? (
            <Button onClick={() => cancel.mutate(order.id)} size="sm" variant="destructive">
              撤销请求
            </Button>
          ) : null}

          {!isBuyer && order.status === 'REQUESTED' ? (
            <>
              <Button onClick={() => reject.mutate(order.id)} size="sm" variant="destructive">
                拒绝
              </Button>
              <Button onClick={() => accept.mutate(order.id)} size="sm">
                接受交易
              </Button>
            </>
          ) : null}

          {!isBuyer && order.status === 'PENDING_MEETUP' ? (
            <Button onClick={() => finish.mutate(order.id)} size="sm">
              确认已交付
            </Button>
          ) : null}
        </div>
      )}
    </article>
  )
}
