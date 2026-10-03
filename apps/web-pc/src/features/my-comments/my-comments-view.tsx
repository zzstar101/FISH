import type { MyCommentItem, MyCommentsKind } from '@fish/contracts/comments/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { ListingThumb } from '../../components/listing-thumb'
import { formatRelativeTimeAt } from '../../lib/format'

/** 分段定义与顺序：kind 取值随 #405 冻结的契约枚举，页面只暴露留言/评价两段。 */
export const MY_COMMENTS_SEGMENTS = [
  { kind: 'comment', label: '商品留言' },
  { kind: 'review', label: '交易评价' },
] as const satisfies readonly { kind: MyCommentsKind; label: string }[]

/**
 * 各分段的计数（该分段列表接口的全量 `total`，与列表同一次请求）。
 * `null` = 读不到（加载中/失败），显示未知而非 0。
 */
export type SegmentCounts = { comment: number | null; review: number | null }

export type MyCommentsViewProps = {
  activeKind: MyCommentsKind
  counts: SegmentCounts
  loading: boolean
  error: boolean
  items: Array<MyCommentItem | TransactionReviewItem>
  hasNextPage: boolean
  loadingMore: boolean
  onKindChange: (kind: MyCommentsKind) => void
  onRetry: () => void
  onLoadMore: () => void
}

const RATING_VIEW: Record<
  TransactionReviewItem['review']['rating'],
  { label: string; variant: 'secondary' | 'warn' | 'success' }
> = {
  POSITIVE: { label: '好评', variant: 'success' },
  NEUTRAL: { label: '中评', variant: 'secondary' },
  NEGATIVE: { label: '差评', variant: 'warn' },
}

/** 留言行：整卡进它所在的商品详情（真实 `listingId`，不靠标题猜）。 */
function CommentRow({ item }: { item: MyCommentItem }) {
  const { comment, listing } = item
  return (
    <Card className="border border-line p-4">
      <Link
        className="flex items-center gap-4"
        params={{ listingId: listing.id }}
        to="/listing/$listingId"
      >
        <ListingThumb
          alt={listing.title}
          className="size-16 rounded-xl"
          coverUrl={listing.coverUrl}
          emojiClassName="text-2xl"
          listingId={listing.id}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {comment.parentId !== null ? <Badge variant="secondary">回复</Badge> : null}
            <span className="text-ink-3 text-xs">{formatRelativeTimeAt(comment.createdAt)}</span>
          </div>
          <p className="mt-1 font-medium text-sm">{comment.content}</p>
          <span className="mt-1 block truncate text-ink-3 text-xs">商品：{listing.title}</span>
        </div>
      </Link>
    </Card>
  )
}

/** 评价行：整卡进订单详情（真实 `transactionId`）。`review.body` 可空 = 只打分没写字。 */
function ReviewRow({ item }: { item: TransactionReviewItem }) {
  const { review, transaction } = item
  const rating = RATING_VIEW[review.rating]
  return (
    <Card className="border border-line p-4">
      <Link
        className="block"
        params={{ transactionId: transaction.id }}
        search={{ role: transaction.role }}
        to="/orders/$transactionId"
      >
        <div className="flex items-center gap-2">
          <Badge variant={rating.variant}>{rating.label}</Badge>
          <span className="text-ink-3 text-xs">{formatRelativeTimeAt(review.createdAt)}</span>
        </div>
        {review.body ? <p className="mt-1 font-medium text-sm">{review.body}</p> : null}
        <span className="mt-1 block truncate text-ink-3 text-xs">
          与 {transaction.counterpart.nickname} 的交易 · {transaction.listing.title}
        </span>
      </Link>
    </Card>
  )
}

/**
 * 行分流：两行形状键互斥（留言行有 `comment` 键、评价行有 `review` 键），
 * `in` 判别即可收窄，不另造中间类型。
 */
function MyCommentsRow({ item }: { item: MyCommentItem | TransactionReviewItem }) {
  return 'comment' in item ? <CommentRow item={item} /> : <ReviewRow item={item} />
}

function EmptyHint({ kind }: { kind: MyCommentsKind }) {
  if (kind === 'review') {
    return (
      <EmptyState
        action={
          <Link
            className="rounded-lg bg-brand px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-lavender"
            search={{ role: 'buyer' }}
            to="/orders"
          >
            去看订单
          </Link>
        }
        description="完成交易后发出的评价会显示在这里"
        emoji="🗣️"
        title="还没有评价"
      />
    )
  }
  return (
    <EmptyState
      action={
        <Link
          className="rounded-lg bg-brand px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-lavender"
          to="/search"
        >
          去逛逛
        </Link>
      }
      description="看到感兴趣的商品，去详情页留言交流"
      emoji="💬"
      title="还没有留言"
    />
  )
}

/** 我的评论页展示层：props 驱动，供静态渲染测试；容器在 my-comments-page.tsx。 */
export function MyCommentsPageView(props: MyCommentsViewProps) {
  if (props.loading) return <LoadingState label="正在加载我的评论…" />

  if (props.error && props.items.length === 0) {
    return <ErrorState message="我的评论加载失败" onRetry={props.onRetry} />
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {MY_COMMENTS_SEGMENTS.map(({ kind, label }) => {
          const active = kind === props.activeKind
          const count = props.counts[kind]
          return (
            <button
              aria-pressed={active}
              className={`inline-flex h-10 items-center gap-2 rounded-xl px-4 font-medium text-sm transition-colors ${
                active ? 'bg-brand text-white' : 'text-ink-2 hover:bg-brand-soft hover:text-brand'
              }`}
              key={kind}
              onClick={() => props.onKindChange(kind)}
              type="button"
            >
              {label}
              <span className={active ? 'text-white/80' : 'text-ink-3'}>
                {count === null ? '—' : count}
              </span>
            </button>
          )
        })}
      </div>

      {props.items.length === 0 ? (
        <EmptyHint kind={props.activeKind} />
      ) : (
        <div className="space-y-3">
          {props.items.map((item) => (
            <MyCommentsRow item={item} key={'comment' in item ? item.comment.id : item.review.id} />
          ))}
        </div>
      )}

      {props.hasNextPage ? (
        <div className="flex justify-center">
          <Button disabled={props.loadingMore} onClick={props.onLoadMore} variant="outline">
            {props.loadingMore ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
      {props.error && props.items.length > 0 ? (
        <p className="text-center text-danger text-xs">
          加载更多失败，
          <button className="font-medium hover:underline" onClick={props.onRetry} type="button">
            重试
          </button>
        </p>
      ) : null}
    </div>
  )
}
