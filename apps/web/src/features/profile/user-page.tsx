import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Shield } from 'lucide-react'
import { useState } from 'react'
import { toListingCard } from '../../lib/mock/store'
import { AuthBadge } from '../auth/auth-badge'
import { ListingRow } from '../search/listing-row'
import { useIsFollowing, useToggleFollow, useUser, useUserListings } from './queries'

/**
 * 用户主页（fixture）：真实契约没有公开用户资料端点（P1）。
 * 主体数据仍来自 fixture store；对真实 uuid 会走「用户不存在」空态。
 */
export function UserPage({ userId }: { userId: string }) {
  const user = useUser(userId)
  const listings = useUserListings(userId)
  const following = useIsFollowing(userId)
  const follow = useToggleFollow(userId)
  const [reported, setReported] = useState(false)

  if (user.isPending) {
    return (
      <div className="min-h-dvh bg-bg">
        <NavBar onBack={() => window.history.back()} title="主页" />
        <LoadingState />
      </div>
    )
  }
  if (user.isError || !user.data) {
    return (
      <div className="min-h-dvh bg-bg">
        <NavBar onBack={() => window.history.back()} title="主页" />
        <EmptyState
          description={user.isError ? '用户主页加载失败,请返回重试' : '用户不存在'}
          emoji="🫥"
        />
      </div>
    )
  }

  const person = user.data
  const active = listings.data?.filter((item) => item.status === 'ACTIVE') ?? []
  const sold = listings.data?.filter((item) => item.status === 'SOLD') ?? []

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="主页" />
      </div>

      <section className="flex items-center gap-3 bg-surface px-4 py-3">
        <UserAvatar emoji={person.emoji} size="xl" tone={person.tone} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate font-semibold text-lg">{person.nickname}</span>
            <AuthBadge status={person.verified ? 'VERIFIED' : 'UNVERIFIED'} />
          </p>
          <p className="mt-1 truncate text-ink-3 text-xs">
            {person.college} · {person.campus} · {person.joinedAt} 加入
          </p>
        </div>
        <Button
          className="shrink-0"
          onClick={() => follow.mutate()}
          size="sm"
          variant={following.data ? 'secondary' : 'default'}
        >
          {following.data ? '已关注' : '关注'}
        </Button>
      </section>

      <section className="mt-2 grid grid-cols-4 bg-surface py-3">
        {[
          { label: '信用分', value: String(person.credit) },
          { label: '在售', value: String(active.length) },
          { label: '已售出', value: String(sold.length) },
          { label: '入学年份', value: person.joinedAt.slice(0, 4) },
        ].map((item) => (
          <div
            className="flex flex-col items-center gap-1 border-line border-l first:border-l-0"
            key={item.label}
          >
            <span className="font-bold text-xl">{item.value}</span>
            <span className="text-ink-3 text-xs">{item.label}</span>
          </div>
        ))}
      </section>

      <section className="mt-2 flex gap-3 bg-surface px-4 py-3">
        {/* 不设「聊一聊」：真实会话必须挂在具体商品上（POST /conversations 只收 listingId），
            用户主页没有商品上下文，会话入口在商品详情页。 */}
        <Button
          className="flex-1"
          disabled={reported}
          onClick={() => setReported(true)}
          size="lg"
          variant="outline"
        >
          <Shield />
          {reported ? '已举报' : '举报'}
        </Button>
      </section>
      {reported ? (
        <p className="px-4 pt-2 text-ink-3 text-xs">已收到举报,平台会尽快核实处理</p>
      ) : null}

      <section className="mt-2">
        <h2 className="flex items-baseline justify-between px-4 py-3 font-semibold text-[15px]">
          TA 的在售
          <span className="font-normal text-ink-3 text-xs">{active.length} 件</span>
        </h2>
        {listings.isPending ? <LoadingState /> : null}
        {listings.isError ? (
          <ErrorState message="TA 的在售加载失败" onRetry={() => void listings.refetch()} />
        ) : null}
        {active.length === 0 && !listings.isPending && !listings.isError ? (
          <EmptyState description="TA 还没有在售的闲置" emoji="🐟" />
        ) : null}
        {active.length > 0 ? (
          <div className="divide-y divide-line bg-surface">
            {active.map((item) => (
              <ListingRow item={toListingCard(item)} key={item.id} />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}
