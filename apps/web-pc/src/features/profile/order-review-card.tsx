import type {
  TransactionReview,
  TransactionReviewCreateInput,
  TransactionReviewRating,
} from '@fish/contracts/transaction-reviews/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Textarea } from '@fish/ui/textarea'
import { Star } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { formatRelativeTimeAt } from '../../lib/format'
import { RATING_OPTIONS, RATING_VIEW } from '../transaction-review/rating'
import { reviewSubmitError } from './api'
import { useCreateReview, useMyReview } from './queries'

export type OrderReviewCardViewProps = {
  loading: boolean
  review: TransactionReview | null
  submitting: boolean
  errorMessage: string | null
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  onSubmit: (input: TransactionReviewCreateInput) => void
}

/**
 * 订单详情的「交易评价」卡（仅 COMPLETED 交易挂载，#445）。
 *
 * 防重复的**第一道闸是读边**：`GET /transactions/:id/review` 拿到已有评价就只读展示，
 * 不再给「写评价」入口；并发下的第二道闸是 POST 的 409 `TRANSACTION_REVIEW_EXISTS`
 * （容器层翻成 alreadyReviewed 后关弹窗、重读边）。评价不可修改，所以已评态没有编辑入口。
 */
export function OrderReviewCardView(props: OrderReviewCardViewProps) {
  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-center gap-2">
        <Star className="size-5 text-brand" />
        <h2 className="font-semibold text-base">交易评价</h2>
      </div>

      {props.loading ? (
        <p className="mt-4 text-ink-3 text-sm">正在读取评价状态…</p>
      ) : props.review !== null ? (
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <Badge variant={RATING_VIEW[props.review.rating].variant}>
              {RATING_VIEW[props.review.rating].label}
            </Badge>
            <span className="text-ink-3 text-xs">
              {formatRelativeTimeAt(props.review.createdAt)}
            </span>
          </div>
          {props.review.body ? (
            <p className="mt-2 font-medium text-sm">{props.review.body}</p>
          ) : null}
          <p className="mt-2 text-ink-3 text-xs">你已评价过这笔交易；评价发出后不可修改。</p>
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-ink-3 text-sm leading-5">
            交易已完成，给对方打个分吧。双方各一条，提交后不可修改。
          </p>
          <Button
            className="mt-3 w-full"
            onClick={() => props.onDialogOpenChange(true)}
            variant="outline"
          >
            写评价
          </Button>
        </div>
      )}

      {props.errorMessage !== null ? (
        <p className="mt-3 text-danger text-sm" role="alert">
          {props.errorMessage}
        </p>
      ) : null}

      <Dialog onOpenChange={props.onDialogOpenChange} open={props.dialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-xl">评价这笔交易</DialogTitle>
            <DialogDescription>三档评分加可选评语；提交后不可修改。</DialogDescription>
          </DialogHeader>
          <ReviewForm
            onCancel={() => props.onDialogOpenChange(false)}
            onSubmit={props.onSubmit}
            submitting={props.submitting}
          />
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/**
 * 评价表单（不依赖 radix 的纯表单，单独导出供静态渲染测试）。
 * 评语 trim 后为空 = 只打分不写字（契约允许，落库为 null）。
 */
export function ReviewForm({
  onCancel,
  onSubmit,
  submitting,
}: {
  onCancel: () => void
  onSubmit: (input: TransactionReviewCreateInput) => void
  submitting: boolean
}) {
  const [rating, setRating] = useState<TransactionReviewRating | null>(null)
  const [body, setBody] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (rating === null) return
    const trimmed = body.trim()
    onSubmit({ rating, ...(trimmed === '' ? {} : { body: trimmed }) })
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div aria-label="评分" className="flex gap-2" role="group">
        {RATING_OPTIONS.map((option) => {
          const active = option === rating
          return (
            <button
              aria-pressed={active}
              className={`h-10 flex-1 rounded-xl border font-medium text-sm transition-colors ${
                active
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-line text-ink-2 hover:border-brand/40 hover:text-brand'
              }`}
              key={option}
              onClick={() => setRating(option)}
              type="button"
            >
              {RATING_VIEW[option].label}
            </button>
          )
        })}
      </div>

      <div>
        <Textarea
          aria-label="评语"
          maxLength={200}
          onChange={(event) => setBody(event.target.value)}
          placeholder="写点想说的话（可选）"
          value={body}
        />
        <p className="mt-2 text-ink-3 text-xs">最多 200 字；留空就是只打分不写字。</p>
      </div>

      <DialogFooter>
        <Button disabled={submitting} onClick={onCancel} type="button" variant="outline">
          取消
        </Button>
        <Button disabled={rating === null || submitting} type="submit">
          {submitting ? '正在提交…' : '提交评价'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** 容器：查询状态与提交错误 → 展示 props。挂载方保证交易已 COMPLETED。 */
export function OrderReviewCard({
  ownerId,
  onStale,
  transaction,
}: {
  ownerId: string
  /** 提交失败且属「终态漂移」时由父级刷新订单（与 MeetupPanel 的 onStale 同款接缝）。 */
  onStale: () => void
  transaction: TransactionDto
}) {
  const review = useMyReview(ownerId, transaction.id)
  const createReview = useCreateReview(ownerId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(input: TransactionReviewCreateInput) {
    setErrorMessage(null)
    try {
      await createReview.mutateAsync({ input, transactionId: transaction.id })
      setDialogOpen(false)
    } catch (error) {
      const view = reviewSubmitError(error)
      setErrorMessage(view.message)
      if (view.alreadyReviewed) {
        setDialogOpen(false)
        void review.refetch()
      }
      if (view.refresh) onStale()
    }
  }

  return (
    <OrderReviewCardView
      dialogOpen={dialogOpen}
      errorMessage={errorMessage}
      loading={review.isPending}
      onDialogOpenChange={setDialogOpen}
      onSubmit={(input) => void handleSubmit(input)}
      review={review.data ?? null}
      submitting={createReview.isPending}
    />
  )
}
