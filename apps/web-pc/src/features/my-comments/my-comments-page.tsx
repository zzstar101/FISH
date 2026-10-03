import type { MyCommentsKind } from '@fish/contracts/comments/schema'
import { useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import { MyCommentsPageView, type SegmentCounts } from './my-comments-view'
import { useMyComments } from './queries'

export function MyCommentsPage() {
  const { me } = useAuth()
  if (!me) return null
  return <MyCommentsContent key={me.id} ownerId={me.id} />
}

function MyCommentsContent({ ownerId }: { ownerId: string }) {
  const [kind, setKind] = useState<MyCommentsKind>('comment')
  // 两个分段同时挂载：胶囊计数取各自第一页的全量 total（与列表同一次请求），
  // 切分段零等待；当前分段负责提供列表与首屏 loading/error。
  const commentList = useMyComments(ownerId, 'comment')
  const reviewList = useMyComments(ownerId, 'review')

  const active = kind === 'comment' ? commentList : reviewList
  const items = active.data?.pages.flatMap((page) => page.items) ?? []

  const countOf = (failed: boolean, total: number | undefined): number | null =>
    failed ? null : (total ?? null)
  const counts: SegmentCounts = {
    comment: countOf(commentList.isError, commentList.data?.pages[0]?.total),
    review: countOf(reviewList.isError, reviewList.data?.pages[0]?.total),
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的评论</h1>
        <p className="mt-1.5 text-ink-3 text-sm">我发过的商品留言与交易评价，点行进入对应详情。</p>
      </div>
      <MyCommentsPageView
        activeKind={kind}
        counts={counts}
        error={active.isError}
        hasNextPage={active.hasNextPage}
        items={items}
        loading={active.isPending}
        loadingMore={active.isFetchingNextPage}
        onKindChange={setKind}
        onLoadMore={() => void active.fetchNextPage()}
        onRetry={() => void active.refetch()}
      />
    </div>
  )
}
