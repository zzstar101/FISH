import type { DisputeType } from '@fish/contracts/disputes/schema'
import { DisputeTypeSchema } from '@fish/contracts/disputes/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Field, FieldLabel } from '@fish/ui/field'
import { RadioGroup, RadioGroupItem } from '@fish/ui/radio-group'
import { Textarea } from '@fish/ui/textarea'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Scale } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { formatPrice } from '../../lib/format'
import { DISPUTE_TYPE_OPTIONS, MAX_DISPUTE_DETAIL_LENGTH } from './meta'
import { useStartDispute } from './queries'
import { disputeFailureText } from './view'

/**
 * 发起交易争议弹窗。只从**本人订单详情**打开，交易由调用方给定 —— 契约里没有
 * `respondentId`，被诉方由服务端从交易推导，端上不需要也不可能指定。
 */
export function StartDisputeDialog({
  open,
  onOpenChange,
  transaction,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionDto
}) {
  const navigate = useNavigate()
  const [type, setType] = useState<DisputeType | null>(null)
  const [detail, setDetail] = useState('')
  const { isPending, error, mutate, reset } = useStartDispute()

  // 关闭时清场（同举报弹窗）：在 `open` 变 true 时清会让重开的第一帧闪一下旧内容。
  useEffect(() => {
    if (open) return
    setType(null)
    setDetail('')
    reset()
  }, [open, reset])

  const trimmed = detail.trim()
  // 契约：OTHER 必填说明；其余类型说明选填。端上先挡住必然 422 的提交。
  const canSubmit = type !== null && (type !== 'OTHER' || trimmed !== '') && !isPending

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (type === null || isPending) return
    if (type === 'OTHER' && trimmed === '') return
    mutate(
      {
        transactionId: transaction.id,
        type,
        // 契约是 `trim().min(1).max(1000).optional()`：空串要**省略字段**。
        ...(trimmed === '' ? {} : { detailText: trimmed }),
      },
      {
        onSuccess: (result) => {
          // `created: false` 时服务端返回的是同一交易同一方向已有的未决争议 ——
          // 同样直接进入详情，不让用户以为「没提交上」而反复点。
          void navigate({
            to: '/disputes/$disputeId',
            params: { disputeId: result.dispute.id },
          }).then(() => onOpenChange(false))
        },
      },
    )
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="size-5 text-brand" />
              发起交易争议
            </DialogTitle>
            <DialogDescription>
              {transaction.listing.title} · {formatPrice(transaction.amountCents)}
              <br />
              提交后平台会核实交易过程，结论与进度可在「我的争议」查看。
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel>争议类型</FieldLabel>
            <RadioGroup
              onValueChange={(value) => setType(DisputeTypeSchema.parse(value))}
              value={type ?? ''}
            >
              {DISPUTE_TYPE_OPTIONS.map((option) => (
                <label
                  className="flex cursor-pointer items-center gap-3 text-sm"
                  htmlFor={`dispute-type-${option.key}`}
                  key={option.key}
                >
                  <RadioGroupItem id={`dispute-type-${option.key}`} value={option.key} />
                  {option.label}
                </label>
              ))}
            </RadioGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="dispute-detail">
              情况说明{type === 'OTHER' ? '' : '（选填）'}
            </FieldLabel>
            <Textarea
              id="dispute-detail"
              maxLength={MAX_DISPUTE_DETAIL_LENGTH}
              onChange={(event) => setDetail(event.target.value)}
              placeholder={
                type === null
                  ? '选择争议类型后填写具体经过'
                  : (DISPUTE_TYPE_OPTIONS.find((option) => option.key === type)?.hint ??
                    '填写具体经过')
              }
              rows={4}
              value={detail}
            />
            <p className="text-right text-ink-3 text-xs">
              {detail.length}/{MAX_DISPUTE_DETAIL_LENGTH}
            </p>
            {type === 'OTHER' && trimmed === '' ? (
              <p className="text-danger text-xs">选择「其他」时必须填写说明</p>
            ) : null}
          </Field>

          {error !== null ? (
            <Alert variant="destructive">
              <AlertTitle>发起失败</AlertTitle>
              <AlertDescription>
                {disputeFailureText(error instanceof ApiError ? error.code : null)}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              disabled={isPending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {isPending ? '正在提交…' : '提交争议'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
