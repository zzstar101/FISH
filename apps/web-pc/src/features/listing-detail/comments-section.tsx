import type { CommentDto, CommentReply } from '@fish/contracts/comments/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Textarea } from '@fish/ui/textarea'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { formatRelativeTimeAt } from '../../lib/format'
import { currentHref } from '../../lib/redirect'
import { useAuth } from '../auth/auth-provider'
import { describeCommentFailure } from './comments-api'
import { useCommentList, useCreateComment, useCreateReply } from './comments-queries'

function SellerBadge() {
  return (
    <Badge className="gap-1" variant="success">
      <ShieldCheck className="size-3" />
      卖家
    </Badge>
  )
}

function CommentComposer({
  value,
  onChange,
  onSubmit,
  pending,
  error,
  placeholder,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  pending: boolean
  error: string | null
  placeholder: string
  onCancel?: () => void
}) {
  const errorId = useId()
  return (
    <div className="mt-3">
      <Textarea
        aria-describedby={error !== null ? errorId : undefined}
        aria-invalid={error !== null}
        aria-label={placeholder}
        className="min-h-[88px] resize-none"
        disabled={pending}
        maxLength={200}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-ink-3 text-xs">{value.length}/200</span>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button disabled={pending} onClick={onCancel} size="sm" type="button" variant="ghost">
              取消
            </Button>
          ) : null}
          <Button
            disabled={pending || value.trim().length === 0}
            onClick={onSubmit}
            size="sm"
            type="button"
          >
            {pending ? '提交中…' : '提交'}
          </Button>
        </div>
      </div>
      {error !== null ? (
        <p className="mt-2 text-danger text-xs" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function ReplyRow({ reply }: { reply: CommentReply }) {
  return (
    <div className="flex gap-3">
      <UserAvatar
        avatarUrl={reply.author.avatarUrl}
        emoji={reply.author.nickname.slice(0, 1)}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-xs">{reply.author.nickname}</span>
          {reply.isSeller ? <SellerBadge /> : null}
          <time className="text-ink-3 text-xs" dateTime={reply.createdAt}>
            {formatRelativeTimeAt(reply.createdAt)}
          </time>
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-ink-2 text-sm leading-6">{reply.content}</p>
      </div>
    </div>
  )
}

function CommentRow({
  comment,
  canReply,
  replyEnabled,
  replyOpen,
  replyDraft,
  replyError,
  replyPending,
  onBeginReply,
  onCancelReply,
  onChangeReply,
  onSubmitReply,
}: {
  comment: CommentDto
  canReply: boolean
  replyEnabled: boolean
  replyOpen: boolean
  replyDraft: string
  replyError: string | null
  replyPending: boolean
  onBeginReply: () => void
  onCancelReply: () => void
  onChangeReply: (value: string) => void
  onSubmitReply: () => void
}) {
  return (
    <div className="py-5">
      <div className="flex gap-3">
        <UserAvatar
          avatarUrl={comment.author.avatarUrl}
          emoji={comment.author.nickname.slice(0, 1)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{comment.author.nickname}</span>
            {comment.isSeller ? <SellerBadge /> : null}
            <time className="text-ink-3 text-xs" dateTime={comment.createdAt}>
              {formatRelativeTimeAt(comment.createdAt)}
            </time>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-ink-2 text-sm leading-6">{comment.content}</p>
          <div className="mt-2 flex items-center gap-3 text-xs">
            <button
              className="text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!replyEnabled || replyPending}
              onClick={onBeginReply}
              type="button"
            >
              回复
            </button>
            <span className="text-ink-3">{comment.replies.length} 条回复</span>
          </div>

          {comment.replies.length > 0 ? (
            <div className="mt-4 space-y-3 border-line border-l-2 pl-4">
              {comment.replies.map((reply) => (
                <ReplyRow key={reply.id} reply={reply} />
              ))}
            </div>
          ) : null}

          {replyOpen && canReply ? (
            <CommentComposer
              error={replyError}
              onCancel={onCancelReply}
              onChange={onChangeReply}
              onSubmit={onSubmitReply}
              pending={replyPending}
              placeholder={`回复 ${comment.author.nickname}…`}
              value={replyDraft}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function CommentsSection({ listingId }: { listingId: string }) {
  const { me, isInitializing, error: authError, refetch: refetchAuth } = useAuth()
  const navigate = useNavigate()
  const comments = useCommentList(listingId)
  const createComment = useCreateComment(listingId)
  const createReply = useCreateReply(listingId)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [replyError, setReplyError] = useState<string | null>(null)

  const items = comments.data?.pages.flatMap((page) => page.items) ?? []
  const hasAuthError = authError !== null && authError !== undefined
  const replyEnabled = !isInitializing && !hasAuthError

  function submitComment() {
    const content = commentDraft.trim()
    if (content.length === 0) return
    setCommentError(null)
    createComment.mutate(content, {
      onSuccess: () => setCommentDraft(''),
      onError: (error) => setCommentError(describeCommentFailure(error)),
    })
  }

  function beginReply(commentId: string) {
    if (!replyEnabled || createReply.isPending) return
    if (me === null) {
      void navigate({ to: '/login', search: { redirect: currentHref() } })
      return
    }
    setReplyTo(commentId)
    setReplyDraft('')
    setReplyError(null)
  }

  function submitReply(commentId: string) {
    const content = replyDraft.trim()
    if (content.length === 0) return
    setReplyError(null)
    createReply.mutate(
      { commentId, content },
      {
        onSuccess: () => {
          setReplyDraft('')
          setReplyTo(null)
        },
        onError: (error) => setReplyError(describeCommentFailure(error)),
      },
    )
  }

  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-semibold text-lg">留言</h2>
          <p className="mt-1 text-ink-3 text-xs">问清楚再决定，卖家与买家都能看到</p>
        </div>
        {items.length > 0 ? (
          <span className="text-ink-3 text-xs">已加载 {items.length} 条</span>
        ) : null}
      </div>

      {isInitializing ? <LoadingState label="正在恢复登录状态…" /> : null}

      {hasAuthError ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm">
          <span>登录状态加载失败，暂时无法留言或回复</span>
          <Button onClick={refetchAuth} size="sm" type="button" variant="outline">
            重试
          </Button>
        </div>
      ) : null}

      {!isInitializing && !hasAuthError && me === null ? (
        <div className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-ink-2 text-sm">
          <Link
            className="font-medium text-brand hover:underline"
            search={{ redirect: currentHref() }}
            to="/login"
          >
            登录
          </Link>
          后可以留言或回复
        </div>
      ) : null}

      {!isInitializing && !hasAuthError && me !== null ? (
        <CommentComposer
          error={commentError}
          onChange={setCommentDraft}
          onSubmit={submitComment}
          pending={createComment.isPending}
          placeholder="问一问商品的情况…"
          value={commentDraft}
        />
      ) : null}

      {comments.isPending ? <LoadingState label="正在加载留言…" /> : null}
      {comments.isError && !comments.isFetchNextPageError ? (
        <ErrorState message="留言加载失败" onRetry={() => void comments.refetch()} />
      ) : null}
      {comments.isSuccess && items.length === 0 ? (
        <EmptyState description="来问第一个问题吧" emoji="💬" title="还没有留言" />
      ) : null}

      {items.length > 0 ? (
        <div className="mt-5 divide-y divide-line">
          {items.map((comment) => (
            <CommentRow
              canReply={me !== null && !isInitializing && !hasAuthError}
              comment={comment}
              key={comment.id}
              onBeginReply={() => beginReply(comment.id)}
              onCancelReply={() => {
                setReplyTo(null)
                setReplyDraft('')
                setReplyError(null)
              }}
              onChangeReply={setReplyDraft}
              onSubmitReply={() => submitReply(comment.id)}
              replyDraft={replyDraft}
              replyError={replyError}
              replyEnabled={replyEnabled}
              replyOpen={replyTo === comment.id}
              replyPending={createReply.isPending}
            />
          ))}
        </div>
      ) : null}

      {comments.isFetchNextPageError ? (
        <ErrorState message="更多留言加载失败" onRetry={() => void comments.fetchNextPage()} />
      ) : null}
      {comments.hasNextPage && !comments.isFetchNextPageError ? (
        <div className="mt-5 flex justify-center">
          <Button
            disabled={comments.isFetchingNextPage}
            onClick={() => void comments.fetchNextPage()}
            variant="outline"
          >
            {comments.isFetchingNextPage ? '正在加载…' : '加载更多留言'}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
