import type {
  TransactionReview,
  TransactionReviewCreateInput,
  TransactionReviewRating,
} from '@fish/contracts/transaction-reviews/schema'
import { MAX_REVIEW_IMAGES, REVIEW_BODY_MAX } from '@fish/contracts/transaction-reviews/schema'
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
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { formatRelativeTimeAt } from '../../lib/format'
import { imagePreparationMessage, toUploadableFile, validateImageFile } from '../publish/api'
import { RATING_OPTIONS, RATING_VIEW } from '../transaction-review/rating'
import { reviewSubmitError, uploadReviewImage } from './api'
import { useCreateReview, useMyReview } from './queries'
import { type ReviewFormImage, ReviewImageSlots, reviewSubmitBlockedReason } from './review-images'

export type OrderReviewCardViewProps = {
  loading: boolean
  /** 评价边读失败（非 404，如 5xx/网络）：状态未知 ≠ 没评过，给重试而不是写入口。 */
  error: boolean
  review: TransactionReview | null
  submitting: boolean
  errorMessage: string | null
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  onRetry: () => void
  onSubmit: (input: TransactionReviewCreateInput) => void
  /** 配图上传链的授权锚点（#475）；透传给 ReviewForm。 */
  transactionId: string
}

/**
 * 订单详情的「交易评价」卡（仅 COMPLETED 交易挂载，#445）。
 *
 * 防重复的**第一道闸是读边**：`GET /transactions/:id/review` 拿到已有评价就只读展示，
 * 不再给「写评价」入口；读失败则状态未知，同样不给入口（不能把「不知道」渲染成「没评过」）。
 * 并发下的第二道闸是 POST 的 409 `TRANSACTION_REVIEW_EXISTS`（容器层翻成 alreadyReviewed
 * 后关弹窗、重读边）。评价不可修改，所以已评态没有编辑入口。
 *
 * 提交失败的文案**同时渲染在弹窗内**：radix 弹窗是模态遮罩，只写卡片体内的话
 * 敏感词 422 这类弹窗保持打开的失败用户根本看不见。
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
      ) : props.error ? (
        <div className="mt-4">
          <p className="text-ink-3 text-sm">评价状态读取失败，暂时无法评价。</p>
          <Button className="mt-3 w-full" onClick={props.onRetry} variant="outline">
            重试
          </Button>
        </div>
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
            errorMessage={props.errorMessage}
            onCancel={() => props.onDialogOpenChange(false)}
            onSubmit={props.onSubmit}
            submitting={props.submitting}
            transactionId={props.transactionId}
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
  errorMessage,
  onCancel,
  onSubmit,
  submitting,
  transactionId,
}: {
  errorMessage: string | null
  onCancel: () => void
  onSubmit: (input: TransactionReviewCreateInput) => void
  submitting: boolean
  /** 配图上传链的授权锚点（#475）：`/transactions/:id/review/media/{presign,confirm}`。 */
  transactionId: string
}) {
  const [rating, setRating] = useState<TransactionReviewRating | null>(null)
  const [body, setBody] = useState('')
  const [images, setImages] = useState<ReviewFormImage[]>([])
  const imagesRef = useRef(images)
  imagesRef.current = images
  const controllersRef = useRef(new Map<string, AbortController>())

  /** 卸载：中断在途上传 + 回收预览 URL（预览是本地 objectURL，必须显式释放）。 */
  useEffect(() => {
    const controllers = controllersRef.current
    return () => {
      for (const controller of controllers.values()) controller.abort()
      for (const image of imagesRef.current) {
        if (image.previewUrl !== '') URL.revokeObjectURL(image.previewUrl)
      }
    }
  }, [])

  function updateImage(id: string, patch: Partial<ReviewFormImage>) {
    setImages((previous) =>
      previous.map((image) => (image.id === id ? { ...image, ...patch } : image)),
    )
  }

  async function runUpload(id: string, file: File) {
    const controller = new AbortController()
    controllersRef.current.set(id, controller)
    try {
      const objectKey = await uploadReviewImage(transactionId, file, {
        signal: controller.signal,
      })
      updateImage(id, { status: 'uploaded', objectKey, error: null })
    } catch (error) {
      if (controller.signal.aborted) return
      updateImage(id, {
        status: 'failed',
        objectKey: null,
        error: error instanceof Error ? error.message : '图片上传失败，请重试',
      })
    } finally {
      controllersRef.current.delete(id)
    }
  }

  /** 选图：先预处理（HEIC→JPG）与前端校验，再过上传链；超上限的部分直接忽略。 */
  async function addFiles(files: File[]) {
    const room = MAX_REVIEW_IMAGES - imagesRef.current.length
    for (const raw of files.slice(0, Math.max(room, 0))) {
      const id = crypto.randomUUID()
      const prepared = await toUploadableFile(raw)
      if (prepared === null) {
        setImages((previous) => [
          ...previous,
          {
            id,
            previewUrl: '',
            status: 'failed',
            objectKey: null,
            error: imagePreparationMessage(raw),
            file: null,
          },
        ])
        continue
      }
      const invalid = validateImageFile(prepared)
      if (invalid !== null) {
        setImages((previous) => [
          ...previous,
          {
            id,
            previewUrl: '',
            status: 'failed',
            objectKey: null,
            error: invalid,
            file: null,
          },
        ])
        continue
      }
      const previewUrl = URL.createObjectURL(prepared)
      setImages((previous) => [
        ...previous,
        { id, previewUrl, status: 'uploading', objectKey: null, error: null, file: prepared },
      ])
      await runUpload(id, prepared)
    }
  }

  function removeImage(id: string) {
    controllersRef.current.get(id)?.abort()
    const target = imagesRef.current.find((image) => image.id === id)
    if (target && target.previewUrl !== '') URL.revokeObjectURL(target.previewUrl)
    setImages((previous) => previous.filter((image) => image.id !== id))
  }

  function retryImage(id: string) {
    const target = imagesRef.current.find((image) => image.id === id)
    if (!target || target.file === null) return
    updateImage(id, { status: 'uploading', error: null })
    void runUpload(id, target.file)
  }

  const blockedReason = reviewSubmitBlockedReason(images, submitting)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (rating === null || blockedReason !== null) return
    const trimmed = body.trim()
    // 配图只可能全是 uploaded（blockedReason 已挡住 uploading/failed）：按槽位序提交，下标即 sort_order。
    const imageObjectKeys = images
      .map((image) => image.objectKey)
      .filter((key): key is string => key !== null)
    onSubmit({
      rating,
      ...(trimmed === '' ? {} : { body: trimmed }),
      ...(imageObjectKeys.length > 0 ? { imageObjectKeys } : {}),
    })
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <fieldset className="flex gap-2 border-0 p-0">
        <legend className="sr-only">评分</legend>
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
      </fieldset>

      <div>
        <Textarea
          aria-label="评语"
          maxLength={REVIEW_BODY_MAX}
          onChange={(event) => setBody(event.target.value)}
          placeholder="写点想说的话（可选）"
          value={body}
        />
        <p className="mt-2 text-ink-3 text-xs">最多 {REVIEW_BODY_MAX} 字；留空就是只打分不写字。</p>
      </div>

      <ReviewImageSlots
        disabled={submitting}
        images={images}
        maxImages={MAX_REVIEW_IMAGES}
        onAddFiles={(files) => void addFiles(files)}
        onRemove={removeImage}
        onRetry={retryImage}
      />

      {errorMessage !== null ? (
        <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger text-sm" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {blockedReason !== null ? <p className="text-ink-3 text-xs">{blockedReason}</p> : null}

      <DialogFooter>
        <Button disabled={submitting} onClick={onCancel} type="button" variant="outline">
          取消
        </Button>
        <Button disabled={rating === null || submitting || blockedReason !== null} type="submit">
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

  /** 关弹窗（取消或提交成功）同时清错误残留，别让上一次的失败挂在卡片上。 */
  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open)
    if (!open) setErrorMessage(null)
  }

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
      error={review.isError}
      errorMessage={errorMessage}
      loading={review.isPending}
      onDialogOpenChange={handleDialogOpenChange}
      onRetry={() => void review.refetch()}
      onSubmit={(input) => void handleSubmit(input)}
      review={review.data ?? null}
      submitting={createReview.isPending}
      transactionId={transaction.id}
    />
  )
}
