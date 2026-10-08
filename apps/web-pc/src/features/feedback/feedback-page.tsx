import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  type Feedback,
  type FeedbackType,
  FeedbackTypeSchema,
} from '@fish/contracts/feedback/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import { FEEDBACK_STATUS_META, FEEDBACK_TYPE_LABEL, validateFeedbackForm } from './meta'
import { useMyFeedback, useSubmitFeedback } from './queries'

/**
 * 意见反馈（#463 PC 用户侧）：提交 + 「我的反馈」（状态与管理员回复）。
 *
 * `/feedback` 落在 `__root.tsx` 的 `RequireAuth` 分支里，`me` 必定存在；按账号 key 重挂，
 * 换号时表单与幂等键一并清空。
 */
export function FeedbackPage() {
  const { me } = useAuth()
  if (!me) return null
  return <FeedbackContent key={me.id} />
}

/** 提交失败文案：服务端错误码优先，其余给通用说法（表单内容保留，可直接重试）。 */
export function feedbackSubmitErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'FEEDBACK_RATE_LIMITED') return error.message
    if (error.code === 'VALIDATION_FAILED') return '内容不符合要求，请检查后重试'
  }
  return '提交失败，内容已保留，请稍后重试'
}

function FeedbackContent() {
  const [type, setType] = useState<FeedbackType | null>(null)
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  // 幂等键：同一份草稿的重试复用同一个键（超时后再点不会重复建单），提交成功后换新。
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID())
  const submit = useSubmitFeedback()

  async function onSubmit() {
    const invalid = validateFeedbackForm({ type, content, contact })
    if (invalid !== null || type === null) {
      setLocalError(invalid)
      return
    }
    setLocalError(null)
    setSubmitted(false)
    try {
      await submit.mutateAsync({
        clientRequestId,
        type,
        content: content.trim(),
        ...(contact.trim() ? { contact: contact.trim() } : {}),
      })
      setType(null)
      setContent('')
      setContact('')
      setClientRequestId(crypto.randomUUID())
      setSubmitted(true)
    } catch {
      // 失败文案由 submit.error 渲染；表单与幂等键保持不变，重试命中同一条。
    }
  }

  return (
    <div className="mx-auto max-w-[980px] space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">意见反馈</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          告诉我们遇到的问题或建议；处理结果会显示在下方「我的反馈」。
        </p>
      </div>

      <Card className="gap-4 border border-line p-6">
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">
            反馈类型 <span className="text-coral">*</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {FeedbackTypeSchema.options.map((option) => (
              <Button
                aria-pressed={type === option}
                key={option}
                onClick={() => setType(option)}
                size="sm"
                variant={type === option ? 'default' : 'outline'}
              >
                {FEEDBACK_TYPE_LABEL[option]}
              </Button>
            ))}
          </div>
        </fieldset>

        <label className="block space-y-1.5">
          <span className="font-medium text-sm">
            问题描述 <span className="text-coral">*</span>
          </span>
          <textarea
            className="min-h-28 w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm focus-visible:ring-3 focus-visible:ring-brand/15 focus:outline-none"
            maxLength={FEEDBACK_CONTENT_MAX + 100}
            onChange={(event) => setContent(event.target.value)}
            placeholder="尽量写清楚发生了什么、在哪个页面、怎么复现"
            value={content}
          />
          <span className="block text-right text-ink-3 text-xs">
            {content.trim().length}/{FEEDBACK_CONTENT_MAX}
          </span>
        </label>

        <label className="block space-y-1.5">
          <span className="font-medium text-sm">联系方式（选填）</span>
          <input
            className="h-10 w-full rounded-xl border border-line bg-white/80 px-3 text-sm focus-visible:ring-3 focus-visible:ring-brand/15 focus:outline-none"
            maxLength={FEEDBACK_CONTACT_MAX}
            onChange={(event) => setContact(event.target.value)}
            placeholder="手机号 / 微信号 / 邮箱，仅平台管理员可见"
            value={contact}
          />
        </label>

        {localError !== null ? (
          <p className="text-danger text-sm" role="alert">
            {localError}
          </p>
        ) : null}
        {submit.isError && localError === null ? (
          <p className="text-danger text-sm" role="alert">
            {feedbackSubmitErrorText(submit.error)}
          </p>
        ) : null}
        {submitted ? (
          <p className="text-success text-sm" role="status">
            已提交，我们会尽快处理。
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button disabled={submit.isPending} onClick={() => void onSubmit()}>
            {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {submit.isPending ? '正在提交…' : '提交反馈'}
          </Button>
        </div>
      </Card>

      <MyFeedbackList />
    </div>
  )
}

function MyFeedbackList() {
  const list = useMyFeedback(true)
  const items = list.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-lg">我的反馈</h2>
      {list.isPending ? <LoadingState label="正在加载反馈记录…" /> : null}
      {list.isError ? (
        <ErrorState message="反馈记录加载失败" onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && items.length === 0 ? (
        <EmptyState
          description="提交过的反馈与处理进度会显示在这里。"
          emoji="💬"
          title="还没有反馈"
        />
      ) : null}
      {items.length > 0 ? (
        <Card className="gap-0 overflow-hidden border border-line p-0">
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id}>
                <FeedbackRow item={item} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {list.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
            variant="outline"
          >
            {list.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
      {list.isFetchNextPageError ? (
        <p className="text-center text-danger text-xs">加载更多失败，请重试</p>
      ) : null}
    </section>
  )
}

export function FeedbackRow({ item }: { item: Feedback }) {
  const status = FEEDBACK_STATUS_META[item.status]
  return (
    <div className="space-y-2 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-sm">{FEEDBACK_TYPE_LABEL[item.type]}</p>
          <p className="mt-1 text-ink-3 text-xs">{formatRelativeTimeAt(item.createdAt)}提交</p>
        </div>
        <Badge shape="pill" variant={status.variant}>
          {status.label}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap text-ink-2 text-sm leading-6">{item.content}</p>
      {item.reply !== null ? (
        <div className="rounded-xl bg-brand-soft/50 px-3 py-2">
          <p className="font-medium text-brand text-xs">平台回复</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{item.reply}</p>
        </div>
      ) : null}
    </div>
  )
}
