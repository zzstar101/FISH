import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { useNavigate } from '@tanstack/react-router'
import { HandCoins } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatPrice } from '../../lib/format'
import { describeCreateConversationFailure, describeProposeFailure } from '../chat/api'
import { useCreateConversation, useProposeTransaction } from '../chat/queries'
import { proposalAmountCents } from './propose-model'

type BuyDialogProps = {
  listingId: string
  title: string
  priceCents: number
  free: boolean
  ownerId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 商品已不在售（409 LISTING_NOT_ACTIVE）时由页面重新取详情。 */
  onListingStale: () => void
}

/**
 * 「我想要」：买家发起交易确认。
 *
 * 两步写操作，顺序固定 —— 先把会话建出来（同一个买家的同一个商品会复用既有会话），
 * 再往会话写 `tx.proposal`。提案本身不带商品状态，商品仍是 `ACTIVE`；
 * 只有卖家接受才创建交易行（契约见 `POST /transactions/proposals` 注释）。
 *
 * 两步都有可能「迟到」：提交后用户可能换号或离开，因此捕获提交时的 ownerId，
 * 响应回来时先比对，过期就整条丢弃（与「聊一聊」`handleChat` 同一口径）。
 */
export function BuyDialog({
  listingId,
  title,
  priceCents,
  free,
  ownerId,
  open,
  onOpenChange,
  onListingStale,
}: BuyDialogProps) {
  const navigate = useNavigate()
  const createConversation = useCreateConversation()
  const propose = useProposeTransaction(ownerId)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const ownerRef = useRef(ownerId)
  ownerRef.current = ownerId
  /*
   * 在飞互斥（契约把「提案不重复」明确交给前端）。按钮的 `disabled` 依赖
   * `isPending`，而它要等下一次渲染才为真 —— 双击会在这之前挤进第二次调用，
   * 于是往同一会话写两条 `tx.proposal`。ref 是同步的，堵住这个窗口。
   */
  const inFlightRef = useRef(false)

  const submitting = createConversation.isPending || propose.isPending

  async function submit() {
    if (inFlightRef.current) return

    const cents = proposalAmountCents(priceCents, free)

    inFlightRef.current = true
    setSubmitError(null)
    const requestedBy = ownerId

    try {
      let conversationId: string
      try {
        const conversation = await createConversation.mutateAsync({
          listingId,
          ownerId: requestedBy,
        })
        if (ownerRef.current !== requestedBy) return
        conversationId = conversation.id
      } catch (error) {
        if (ownerRef.current !== requestedBy) return
        setSubmitError(describeCreateConversationFailure(error))
        return
      }

      try {
        await propose.mutateAsync({ conversationId, amountCents: cents })
        if (ownerRef.current !== requestedBy) return
        onOpenChange(false)
        void navigate({
          to: '/messages/$conversationId',
          params: { conversationId },
        })
      } catch (error) {
        if (ownerRef.current !== requestedBy) return
        const view = describeProposeFailure(error)
        setSubmitError(view.message)
        if (view.refresh) onListingStale()
      }
    } finally {
      inFlightRef.current = false
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (submitting) return
        if (!next) setSubmitError(null)
        onOpenChange(next)
      }}
      open={open}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>我想要</DialogTitle>
          <DialogDescription>
            确认后会给卖家发一条交易确认，卖家同意才会生成订单并锁定商品。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
            <span className="text-ink-3">商品</span>
            <span className="mt-1 block line-clamp-2 font-medium">{title}</span>
            <span className="mt-1 block text-ink-3 text-xs">
              挂价 {formatPrice(priceCents)}
              {free ? ' · 免费送，金额固定为 0' : ''}
            </span>
          </p>

          <div>
            <p className="text-ink-3 text-xs">交易金额</p>
            {/* #676：金额只读（改价权归卖家），展示的是挂价本身；服务端同样强制
                `amountCents === listing.priceCents`，不等即 422 PROPOSAL_AMOUNT_MISMATCH。 */}
            <p className="mt-1 rounded-xl bg-surface-2 px-4 py-3 font-medium">
              {formatPrice(proposalAmountCents(priceCents, free))}
            </p>
            <p className="mt-1 text-ink-3 text-xs">
              由卖家设定，不可修改；卖家同意后按此金额成交。
            </p>
          </div>

          {submitError !== null ? (
            <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
              {submitError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            再想想
          </Button>
          <Button disabled={submitting} onClick={() => void submit()} type="button">
            <HandCoins className="size-4" />
            {submitting ? '正在发起…' : '发起交易确认'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
