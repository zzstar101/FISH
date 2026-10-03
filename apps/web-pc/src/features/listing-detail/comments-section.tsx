import type { CommentDto, CommentReply } from '@fish/contracts/comments/schema'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@fish/ui/alert-dialog'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Textarea } from '@fish/ui/textarea'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatRelativeTimeAt } from '../../lib/format'
import { currentHref } from '../../lib/redirect'
import { useAuth } from '../auth/auth-provider'
import { describeCommentDeleteFailure, describeCommentFailure } from './comments-api'
import {
  useCommentList,
  useCreateComment,
  useCreateReply,
  useDeleteComment,
} from './comments-queries'

/** 删除确认弹窗的目标：只留 id 与类型，正文不进组件状态。 */
type DeleteTarget = { id: string; kind: 'comment' | 'reply' }

/**
 * 这条留言（或回复）是否归当前访客所有 —— 决定要不要给「删除」入口。
 *
 * 只比**公开 id**：`CommentAuthor.id` 与 `Me.id` 都是 `usr_` 公开 id（契约同一编码），
 * 不要拿 nickname 这类可变展示字段去猜归属。
 */
export function canDeleteComment(
  entry: { author: { id: string } },
  viewerId: string | null,
): boolean {
  return viewerId !== null && entry.author.id === viewerId
}

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
  return (
    <div className="mt-3">
      <Textarea
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
      {error !== null ? <p className="mt-2 text-danger text-xs">{error}</p> : null}
    </div>
  )
}

function ReplyRow({
  reply,
  canDelete,
  onDelete,
}: {
  reply: CommentReply
  canDelete: boolean
  onDelete: () => void
}) {
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
          {canDelete ? (
            <button
              aria-label={`删除 ${reply.author.nickname} 的回复`}
              className="text-ink-3 text-xs hover:text-danger hover:underline"
              onClick={onDelete}
              type="button"
            >
              删除
            </button>
          ) : null}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-ink-2 text-sm leading-6">{reply.content}</p>
      </div>
    </div>
  )
}

function CommentRow({
  comment,
  canReply,
  viewerId,
  authResolved,
  replyOpen,
  replyDraft,
  replyError,
  replyPending,
  onBeginReply,
  onCancelReply,
  onChangeReply,
  onSubmitReply,
  onDelete,
  onDeleteReply,
}: {
  comment: CommentDto
  canReply: boolean
  viewerId: string | null
  authResolved: boolean
  replyOpen: boolean
  replyDraft: string
  replyError: string | null
  replyPending: boolean
  onBeginReply: () => void
  onCancelReply: () => void
  onChangeReply: (value: string) => void
  onSubmitReply: () => void
  onDelete: () => void
  onDeleteReply: (reply: CommentReply) => void
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
              disabled={!authResolved || replyPending}
              onClick={onBeginReply}
              type="button"
            >
              回复
            </button>
            <span className="text-ink-3">{comment.replies.length} 条回复</span>
            {canDeleteComment(comment, viewerId) ? (
              <button
                aria-label={`删除 ${comment.author.nickname} 的留言`}
                className="text-ink-3 hover:text-danger hover:underline"
                onClick={onDelete}
                type="button"
              >
                删除
              </button>
            ) : null}
          </div>

          {comment.replies.length > 0 ? (
            <div className="mt-4 space-y-3 border-line border-l-2 pl-4">
              {comment.replies.map((reply) => (
                <ReplyRow
                  canDelete={canDeleteComment(reply, viewerId)}
                  key={reply.id}
                  onDelete={() => onDeleteReply(reply)}
                  reply={reply}
                />
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
  const deleteComment = useDeleteComment(listingId)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [replyError, setReplyError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const viewerId = me?.id ?? null
  const viewerRef = useRef(viewerId)
  const resetViewerRef = useRef(viewerId)
  viewerRef.current = viewerId

  useEffect(() => {
    if (resetViewerRef.current === viewerId) return
    resetViewerRef.current = viewerId
    setCommentDraft('')
    setCommentError(null)
    setReplyTo(null)
    setReplyDraft('')
    setReplyError(null)
    setDeleteTarget(null)
    setDeleteError(null)
  }, [viewerId])

  const items = comments.data?.pages.flatMap((page) => page.items) ?? []
  const hasAuthError = authError !== null && authError !== undefined
  const authResolved = !isInitializing && !hasAuthError

  function submitComment() {
    const content = commentDraft.trim()
    if (content.length === 0) return
    const submittedBy = viewerId
    setCommentError(null)
    createComment.mutate(content, {
      onSuccess: () => {
        if (viewerRef.current !== submittedBy) return
        setCommentDraft('')
      },
      onError: (error) => {
        if (viewerRef.current !== submittedBy) return
        setCommentError(describeCommentFailure(error))
      },
    })
  }

  function beginReply(commentId: string) {
    if (!authResolved || createReply.isPending) return
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
    const submittedBy = viewerId
    setReplyError(null)
    createReply.mutate(
      { commentId, content },
      {
        onSuccess: () => {
          if (viewerRef.current !== submittedBy) return
          setReplyDraft('')
          setReplyTo(null)
        },
        onError: (error) => {
          if (viewerRef.current !== submittedBy) return
          setReplyError(describeCommentFailure(error))
        },
      },
    )
  }

  /**
   * 确认删除。**先关弹窗再发请求**，失败时把服务端文案落到区块顶部的提示条：
   * 弹窗关掉后错误仍可见，也不会因为重开弹窗而丢失。
   */
  function confirmDelete() {
    if (deleteTarget === null) return
    const target = deleteTarget
    const submittedBy = viewerId
    setDeleteError(null)
    setDeleteTarget(null)
    deleteComment.mutate(target.id, {
      onError: (error) => {
        if (viewerRef.current !== submittedBy) return
        setDeleteError(describeCommentDeleteFailure(error))
      },
    })
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

      {deleteError !== null ? (
        <p className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          {deleteError}
        </p>
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
              onDelete={() => setDeleteTarget({ id: comment.id, kind: 'comment' })}
              onDeleteReply={(reply) => setDeleteTarget({ id: reply.id, kind: 'reply' })}
              onSubmitReply={() => submitReply(comment.id)}
              replyDraft={replyDraft}
              replyError={replyError}
              authResolved={authResolved}
              replyOpen={replyTo === comment.id}
              replyPending={createReply.isPending}
              viewerId={viewerId}
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

      {deleteTarget !== null ? (
        <AlertDialog
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
          open
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {deleteTarget.kind === 'comment' ? '删除这条留言？' : '删除这条回复？'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget.kind === 'comment'
                  ? '删除不可恢复，这条留言下面的回复也会一并删除。'
                  : '删除不可恢复。'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete} variant="destructive">
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Card>
  )
}
