import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Field, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { useNavigate } from '@tanstack/react-router'
import { HandCoins } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatPrice } from '../../lib/format'
import { describeCreateConversationFailure, describeProposeFailure } from '../chat/api'
import { useCreateConversation, useProposeTransaction } from '../chat/queries'
import { initialAmountValue, proposalAmountCents, proposalAmountError } from './propose-model'

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
  const [amount, setAmount] = useState(() => initialAmountValue(priceCents, free))
  const [amountError, setAmountError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const ownerRef = useRef(ownerId)
  ownerRef.current = ownerId

  const submitting = createConversation.isPending || propose.isPending

  async function submit() {
    const fieldError = proposalAmountError(amount, free)
    if (fieldError !== null) {
      setAmountError(fieldError)
      return
    }
    const cents = proposalAmountCents(amount, free)
    if (cents === null) return

    setAmountError(null)
    setSubmitError(null)
    const requestedBy = ownerId

    let conversationId: string
    try {
      const conversation = await createConversation.mutateAsync({ listingId, ownerId: requestedBy })
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
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (submitting) return
        if (!next) {
          setSubmitError(null)
          setAmountError(null)
          setAmount(initialAmountValue(priceCents, free))
        }
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

          <Field data-invalid={amountError !== null}>
            <FieldLabel htmlFor="propose-amount">交易金额</FieldLabel>
            <Input
              aria-invalid={amountError !== null}
              disabled={free || submitting}
              id="propose-amount"
              inputMode="decimal"
              onChange={(event) => {
                setAmount(event.target.value)
                setAmountError(null)
              }}
              value={amount}
            />
            {amountError !== null ? <FieldError>{amountError}</FieldError> : null}
            {amountError === null ? (
              <p className="text-ink-3 text-xs">
                不填挂价也可以改：这就是和卖家商定的成交价，卖家接受时以此为准。
              </p>
            ) : null}
          </Field>

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
