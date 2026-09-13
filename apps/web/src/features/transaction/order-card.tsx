import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { useNavigate } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import type * as React from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { createConversation } from '../chat/api'
import { useCancelTransaction, useConfirmTransaction } from './queries'

type ChipTone = NonNullable<React.ComponentProps<typeof Badge>['variant']>

const STATUS: Record<TransactionDto['status'], { label: string; tone: ChipTone }> = {
  PENDING_MEETUP: { label: '待面交', tone: 'lavender' },
  COMPLETED: { label: '已完成', tone: 'success' },
  CANCELLED: { label: '已取消', tone: 'secondary' },
}

/**
 * 交易卡（#11，#41 接真实）：数据来自 `GET /transactions` 的 TransactionDto。
 * 提案 / 接受 / 拒绝不产生交易行（以会话里的 SYSTEM 消息承载），动作入口在聊天页；
 * 这里是已创建交易的状态机动作：确认面交（双方各一次）与取消。
 */
export function OrderCard({ order }: { order: TransactionDto }) {
  const navigate = useNavigate()
  const confirm = useConfirmTransaction()
  const cancel = useCancelTransaction()
  const status = STATUS[order.status]
  const isBuyer = order.role === 'buyer'
  const inProgress = order.status === 'PENDING_MEETUP'

  const openChat = () => {
    // 交易必有对应会话（conversationId 即定位商品 + 买卖双方），直接创建/复用。
    void createConversation({ listingId: order.listingId }).then((conversationId) =>
      navigate({ to: '/chat/$conversationId', params: { conversationId } }),
    )
  }

  return (
    <article className="rounded-2xl bg-surface p-3">
      <div className="flex items-center gap-2">
        <Badge variant={isBuyer ? 'lavender' : 'brand'}>{isBuyer ? '买入' : '卖出'}</Badge>
        <span className="text-ink-3 text-xs">{formatRelativeTimeAt(order.createdAt)}</span>
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
        <ListingThumb
          alt={order.listing.title}
          className="size-20 rounded-xl"
          coverUrl={order.listing.coverUrl}
          listingId={order.listing.id}
          emojiClassName="text-[2rem]"
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-medium text-[15px] leading-snug">{order.listing.title}</p>
          <p className="mt-1 truncate text-ink-3 text-xs">
            {isBuyer ? '卖家' : '买家'}:{order.counterpart.nickname}
          </p>
        </div>
        {/* 议价结果 amountCents 是成交金额，与挂价各自独立（#11 契约）。 */}
        <span className="shrink-0 font-semibold text-lg">{formatPrice(order.amountCents)}</span>
      </button>

      {inProgress ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={openChat} size="sm" variant="outline">
            <MessageCircle className="size-3" />
            联系 TA
          </Button>

          {isBuyer ? (
            <>
              <Button onClick={() => cancel.mutate(order.id)} size="sm" variant="destructive">
                取消交易
              </Button>
              <Button onClick={() => confirm.mutate(order.id)} size="sm">
                确认面交,完成交易
              </Button>
            </>
          ) : (
            <Button onClick={() => confirm.mutate(order.id)} size="sm">
              确认已交付
            </Button>
          )}
        </div>
      ) : null}
    </article>
  )
}
