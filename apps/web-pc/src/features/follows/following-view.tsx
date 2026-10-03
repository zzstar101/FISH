import type { FollowedUser } from '@fish/contracts/follows/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

/** 单条取关的失败：按条挂在对应行上，不弹全局提示——失败的那条保持原样可重试。 */
export type UnfollowFailure = { userId: string; message: string } | null

export type FollowingViewProps = {
  loading: boolean
  error: boolean
  items: FollowedUser[]
  /** 列表全量计数（服务端 COUNT，与列表同源）；读不到为 null，显示未知而非 0。 */
  total: number | null
  mutualTotal: number | null
  hasNextPage: boolean
  loadingMore: boolean
  unfollowingId: string | null
  unfollowFailure: UnfollowFailure
  onRetry: () => void
  onUnfollow: (userId: string) => void
  onLoadMore: () => void
}

/** 页面顶部的全量计数：`关注 N 人 · 互粉 M 人`，直接取响应的 total / mutualTotal。 */
export function followingCounts(total: number | null, mutualTotal: number | null): string {
  const n = total === null ? '未知' : String(total)
  const m = mutualTotal === null ? '未知' : String(mutualTotal)
  return `关注 ${n} 人 · 互粉 ${m} 人`
}

function FollowedRow({
  row,
  failureMessage,
  unfollowing,
  onUnfollow,
}: {
  row: FollowedUser
  failureMessage: string | null
  unfollowing: boolean
  onUnfollow: (userId: string) => void
}) {
  const isFailureRow = failureMessage !== null
  return (
    <Card
      className={`flex items-center gap-4 border border-line p-4 ${isFailureRow ? 'border-danger/40' : ''}`}
    >
      <Link params={{ userId: row.id }} to="/users/$userId">
        <UserAvatar
          avatarUrl={row.avatarUrl}
          className="size-12"
          emoji={row.nickname.slice(0, 1)}
          size="default"
        />
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          className="block truncate font-medium text-sm hover:text-brand"
          params={{ userId: row.id }}
          to="/users/$userId"
        >
          {row.nickname}
        </Link>
        <div className="mt-1 flex items-center gap-2">
          {row.authStatus === 'VERIFIED' ? <Badge variant="success">已认证</Badge> : null}
          {/* mutual 是服务端按反向关系算的真值，端上不重算。 */}
          {row.mutual ? <Badge variant="brand">互相关注</Badge> : null}
          {isFailureRow ? <p className="text-danger text-xs">{failureMessage}</p> : null}
        </div>
      </div>
      <Button
        aria-label={`取消关注：${row.nickname}`}
        disabled={unfollowing}
        onClick={() => onUnfollow(row.id)}
        size="sm"
        type="button"
        variant="outline"
      >
        {unfollowing ? '取消中…' : '取消关注'}
      </Button>
    </Card>
  )
}

export function FollowingPageView(props: FollowingViewProps) {
  if (props.loading) return <LoadingState label="正在加载我的关注…" />

  if (props.error) {
    return <ErrorState message="我的关注加载失败" onRetry={props.onRetry} />
  }

  if (props.items.length === 0) {
    return (
      <EmptyState
        description="在他人主页点「关注」，对方就会出现在这里。"
        emoji="🫂"
        title="还没有关注的人"
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="font-medium text-ink-2 text-sm tabular-nums">
        {followingCounts(props.total, props.mutualTotal)}
      </p>

      {props.items.map((row) => (
        <FollowedRow
          failureMessage={
            props.unfollowFailure?.userId === row.id ? props.unfollowFailure.message : null
          }
          key={row.id}
          onUnfollow={props.onUnfollow}
          row={row}
          unfollowing={props.unfollowingId === row.id}
        />
      ))}

      {props.hasNextPage ? (
        <div className="flex justify-center">
          <Button disabled={props.loadingMore} onClick={props.onLoadMore} variant="outline">
            {props.loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
            {props.loadingMore ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
