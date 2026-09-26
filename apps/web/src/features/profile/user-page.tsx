import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Shield } from 'lucide-react'
import { AuthBadge } from '../auth/auth-badge'
import { useAuth } from '../auth/auth-provider'
import { ListingRow } from '../search/listing-row'
import { useUser, useUserListings } from './queries'

/** 他人主页只使用 `/users/:id/public` 与 `/users/:id/listings` 的公开读模型。 */
export function UserPage({ userId }: { userId: string }) {
  const { me } = useAuth()
  const user = useUser(userId)
  const listings = useUserListings(userId)

  if (user.isPending) {
    return (
      <div className="min-h-dvh bg-bg">
        <NavBar onBack={() => window.history.back()} title="主页" />
        <LoadingState />
      </div>
    )
  }
  if (user.isError) {
    return (
      <div className="min-h-dvh bg-bg">
        <NavBar onBack={() => window.history.back()} title="主页" />
        <ErrorState message="用户主页加载失败" onRetry={() => void user.refetch()} />
      </div>
    )
  }
  if (!user.data) {
    return (
      <div className="min-h-dvh bg-bg">
        <NavBar onBack={() => window.history.back()} title="主页" />
        <EmptyState description="这位用户不存在或无法访问" emoji="🫥" />
      </div>
    )
  }

  const person = user.data
  const active = listings.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="主页" />
      </div>
      <section className="flex items-center gap-3 bg-surface px-4 py-4">
        <UserAvatar avatarUrl={person.avatarUrl} emoji={person.nickname.slice(0, 1)} size="xl" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate font-semibold text-lg">{person.nickname}</span>
            <AuthBadge status={person.authStatus} />
          </p>
          <p className="mt-1 text-ink-3 text-xs">加入 {person.joinedDays} 天 · 校内面交</p>
        </div>
      </section>
      <section className="mt-2 grid grid-cols-3 bg-surface py-3">
        {[
          { label: '在售', value: person.activeCount },
          { label: '卖出', value: person.soldCount },
          { label: '加入天数', value: person.joinedDays },
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
      {me?.id !== person.id ? (
        <section className="mt-2 bg-surface px-4 py-3">
          <Link
            className="flex items-center justify-center gap-2 rounded-lg border border-line px-4 py-2.5 text-ink-2 text-sm"
            params={{ targetType: 'USER', targetId: person.id }}
            to="/report/$targetType/$targetId"
          >
            <Shield className="size-4" /> 举报用户
          </Link>
        </section>
      ) : null}
      <section className="mt-2">
        <h2 className="flex items-baseline justify-between px-4 py-3 font-semibold text-[15px]">
          TA 的在售
          <span className="font-normal text-ink-3 text-xs">{person.activeCount} 件</span>
        </h2>
        {listings.isPending ? <LoadingState /> : null}
        {listings.isError && active.length === 0 ? (
          <ErrorState message="TA 的在售加载失败" onRetry={() => void listings.refetch()} />
        ) : null}
        {listings.isSuccess && active.length === 0 ? (
          <EmptyState description="TA 还没有在售的闲置" emoji="🐟" />
        ) : null}
        {active.length > 0 ? (
          <div className="divide-y divide-line bg-surface">
            {active.map((item) => (
              <ListingRow item={item} key={item.id} />
            ))}
          </div>
        ) : null}
        {listings.hasNextPage ? (
          <Button
            className="mx-4 mt-4"
            disabled={listings.isFetchingNextPage}
            onClick={() => void listings.fetchNextPage()}
            variant="outline"
          >
            {listings.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        ) : null}
        {listings.isFetchNextPageError ? (
          <p className="px-4 pt-3 text-danger text-sm" role="alert">
            下一页加载失败，请重试
          </p>
        ) : null}
      </section>
    </div>
  )
}
