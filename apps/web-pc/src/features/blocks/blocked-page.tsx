import type { BlockedUser } from '@fish/contracts/blocks/schema'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import { useMyBlocks, useUnblockUser } from './queries'

/**
 * 黑名单管理页（#466 验收「黑名单管理及解除入口」）：列出我拉黑的人 + 逐行解除。
 * 只列**我拉黑的**（我的视角）——「谁拉黑了我」没有读取路径，被拉黑不是可探测状态。
 */
export function BlockedPage() {
  const { me } = useAuth()
  if (!me) return null
  return <BlockedContent key={me.id} ownerId={me.id} />
}

function BlockedContent({ ownerId }: { ownerId: string }) {
  const blocks = useMyBlocks(ownerId)
  // 提前取出：早期 return 会把联合类型收窄，之后再访问 fetchNextPage 会被推断成 never。
  const loadMore = () => void blocks.fetchNextPage()

  if (blocks.isError) {
    return <ErrorState message="黑名单加载失败" onRetry={() => void blocks.refetch()} />
  }

  const items = blocks.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">黑名单</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            拉黑后你们双方都无法互发消息、也无法新建会话；解除后立即恢复。
          </p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 游标翻页</p>
      </div>

      {blocks.isPending ? <LoadingState label="正在加载黑名单…" /> : null}
      {blocks.isSuccess && items.length === 0 ? (
        <EmptyState
          description="在他人主页点「拉黑」，对方会出现在这里"
          emoji="🚫"
          title="黑名单是空的"
        />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <BlockedRow item={item} key={item.id} ownerId={ownerId} />
          ))}
        </Card>
      ) : null}

      {blocks.hasNextPage ? (
        <div className="flex justify-center">
          <Button disabled={blocks.isFetchingNextPage} onClick={loadMore} variant="outline">
            {blocks.isFetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : null}
            {blocks.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}

      {blocks.isFetchNextPageError ? (
        <ErrorState message="更多黑名单加载失败" onRetry={loadMore} />
      ) : null}
    </div>
  )
}

/** 单行：公开资料 + 拉黑时刻 + 解除按钮（解除是恢复性动作，直接执行不需要确认弹窗）。 */
export function BlockedRow({ item, ownerId }: { item: BlockedUser; ownerId: string }) {
  void ownerId
  const unblock = useUnblockUser(item.id)
  const failure = unblock.data?.kind === 'failed' ? unblock.data.message : null

  return (
    <article className="flex items-center gap-4 p-4">
      <Link params={{ userId: item.id }} to="/users/$userId">
        <UserAvatar
          avatarUrl={item.avatarUrl}
          emoji={item.nickname.slice(0, 1)}
          fallbackClassName="text-sm"
          size="default"
        />
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          className="truncate font-semibold hover:text-brand"
          params={{ userId: item.id }}
          to="/users/$userId"
        >
          {item.nickname}
        </Link>
        <p className="mt-0.5 text-ink-3 text-xs">{formatRelativeTimeAt(item.blockedAt)}拉黑</p>
        {failure !== null ? <p className="mt-1 text-danger text-xs">{failure}</p> : null}
      </div>
      <Button
        disabled={unblock.isPending}
        onClick={() => {
          unblock.reset()
          void unblock.mutateAsync()
        }}
        size="sm"
        variant="outline"
      >
        {unblock.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        解除
      </Button>
    </article>
  )
}
