import { useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import type { UnfollowFailure } from './following-view'
import { FollowingPageView } from './following-view'
import { useMyFollowing, useUnfollowMutation } from './queries'

export function FollowingPage() {
  const { me } = useAuth()
  if (!me) return null
  return <FollowingContent key={me.id} ownerId={me.id} />
}

function FollowingContent({ ownerId }: { ownerId: string }) {
  const [unfollowFailure, setUnfollowFailure] = useState<UnfollowFailure>(null)
  const following = useMyFollowing(ownerId)
  const unfollow = useUnfollowMutation()

  const items = following.data?.pages.flatMap((page) => page.items) ?? []

  function handleUnfollow(userId: string) {
    setUnfollowFailure(null)
    unfollow.mutate(userId, {
      onSuccess: (result) => {
        if (result.kind === 'failed') {
          setUnfollowFailure({ userId, message: result.message })
        }
      },
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的关注</h1>
        <p className="mt-1.5 text-ink-3 text-sm">你关注的人在这里；取关后对方即刻从列表移除。</p>
      </div>
      <FollowingPageView
        error={following.isError}
        hasNextPage={following.hasNextPage}
        items={items}
        loading={following.isPending}
        loadingMore={following.isFetchingNextPage}
        mutualTotal={following.data?.pages[0]?.mutualTotal ?? null}
        onRetry={() => void following.refetch()}
        onLoadMore={() => void following.fetchNextPage()}
        onUnfollow={handleUnfollow}
        total={following.data?.pages[0]?.total ?? null}
        unfollowFailure={unfollowFailure}
        unfollowingId={unfollow.isPending ? (unfollow.variables ?? null) : null}
      />
    </div>
  )
}
