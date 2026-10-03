import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Loader2, ShieldCheck, UserRoundPlus } from 'lucide-react'
import { useState } from 'react'
import { currentHref } from '../../lib/redirect'
import { useAuth } from '../auth/auth-provider'
import { FollowButtonView, followButtonState } from '../follows/follow-button'
import { useFollowMutation, useFollowState, useUnfollowMutation } from '../follows/queries'
import { PcListingCard } from '../listings/listing-card'
import { usePublicProfile, useUserActiveListings } from './queries'
import { isUserNotFound, profileStats } from './view'

/**
 * 他人主页（`/users/$userId`）。
 *
 * 这条路由在 `__root.tsx` 里属于**免登录白名单**：契约明确要求他人主页对未登录
 * 访客也可读（`USER_ROUTES` 两个端点都不挂 `requireAuth`）。
 */
export function UserProfilePage({ userId }: { userId: string }) {
  const { me, isInitializing } = useAuth()
  const profile = usePublicProfile(userId)
  // 资料没拿到之前不查在售：契约对不存在的用户返回 404 而不是空列表，
  // 并发发出会先闪一下「TA 暂无在售商品」再被覆盖。
  const listings = useUserActiveListings(userId, profile.isSuccess)
  const items = listings.data?.pages.flatMap((page) => page.items) ?? []

  // 关注态以服务端为准：读用 GET 的真实结果，写成功后写缓存的是服务端返回值，
  // 失败只显示错误文本、绝不本地翻转。未登录与本人都不发这条查询。
  const followState = useFollowState(userId, me?.id !== undefined && me.id !== userId)
  const followMutation = useFollowMutation()
  const unfollowMutation = useUnfollowMutation()
  const [followError, setFollowError] = useState<string | null>(null)

  /** 已关注 → 取关（DELETE 幂等）；未关注 → 关注（POST 幂等）。 */
  function handleFollowToggle() {
    const data = followState.data
    if (data === undefined || data.kind !== 'loaded') return
    setFollowError(null)
    const mutate = data.following ? unfollowMutation : followMutation
    mutate.mutate(userId, {
      onSuccess: (result) => {
        if (result.kind === 'failed') setFollowError(result.message)
      },
    })
  }

  if (profile.isPending) return <LoadingState label="正在加载用户资料…" />

  if (profile.isError) {
    if (isUserNotFound(profile.error)) {
      return (
        <EmptyState description="这位用户不存在，或者已不可见。" emoji="🔍" title="用户不存在" />
      )
    }
    return <ErrorState message="用户资料加载失败" onRetry={() => void profile.refetch()} />
  }

  const user = profile.data
  const isSelf = me?.id === user.id

  return (
    <div className="space-y-6">
      <Card className="gap-0 border border-line p-6">
        <div className="flex items-center gap-6">
          <UserAvatar
            avatarUrl={user.avatarUrl}
            className="size-20"
            emoji={user.nickname.slice(0, 1)}
            fallbackClassName="text-2xl"
            size="xl"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate font-semibold text-2xl">{user.nickname}</h1>
              {user.authStatus === 'VERIFIED' ? (
                <Badge className="gap-1" variant="success">
                  <ShieldCheck className="size-3.5" />
                  已认证
                </Badge>
              ) : (
                <Badge variant="secondary">未认证</Badge>
              )}
            </div>
            {/* 契约的公开 DTO 只有七个字段，这里只出其中三个统计，不补任何编造指标。 */}
            <dl className="mt-4 flex gap-8">
              {profileStats(user).map((stat) => (
                <div key={stat.label}>
                  <dd className="font-bold text-xl tabular-nums">{stat.value}</dd>
                  <dt className="mt-0.5 text-ink-3 text-xs">{stat.label}</dt>
                </div>
              ))}
            </dl>
          </div>
          {isSelf ? (
            <Button asChild variant="outline">
              <Link to="/profile">这是你的公开主页 · 去个人中心</Link>
            </Button>
          ) : isInitializing ? null : me === null ? (
            <Button asChild variant="outline">
              <Link search={{ redirect: currentHref() }} to="/login">
                <UserRoundPlus className="size-4" />
                登录后关注
              </Link>
            </Button>
          ) : (
            <div>
              <FollowButtonView
                mutual={followState.data?.kind === 'loaded' ? followState.data.mutual : false}
                onToggle={handleFollowToggle}
                state={followButtonState({
                  errorMessage:
                    followState.data?.kind === 'failed' ? followState.data.message : null,
                  pending: followMutation.isPending || unfollowMutation.isPending,
                  read:
                    followState.data === undefined
                      ? 'loading'
                      : followState.data.kind === 'loaded'
                        ? followState.data.following
                          ? 'following'
                          : 'notFollowing'
                        : followState.data.kind === 'notFound'
                          ? 'notFound'
                          : 'unknown',
                })}
              />
              {followError !== null ? <p className="text-danger text-xs">{followError}</p> : null}
            </div>
          )}
        </div>
      </Card>

      <section aria-label="TA 的在售商品" className="space-y-5">
        <div className="flex items-end justify-between gap-6">
          <h2 className="font-semibold text-[22px] tracking-[-0.03em]">在售商品</h2>
          <p className="text-ink-3 text-xs">只展示在售；已下架与已售出不在列表中。</p>
        </div>

        {listings.isPending ? <LoadingState label="正在加载在售商品…" /> : null}

        {listings.isError ? (
          // 防御性兜底：资料查询成功才发这条查询（见上方 `enabled`），所以正常情况下
          // 同一个 userId 不会再 404。只有资料来自 30s 缓存、而用户在两次请求之间被删掉
          // 时才会走到这里 —— 那时给「用户不存在」比「加载失败」准确。
          isUserNotFound(listings.error) ? (
            <EmptyState
              description="这位用户不存在，或者已不可见。"
              emoji="🔍"
              title="用户不存在"
            />
          ) : (
            <ErrorState message="在售商品加载失败" onRetry={() => void listings.refetch()} />
          )
        ) : null}

        {listings.isSuccess && items.length === 0 ? (
          <EmptyState description="TA 目前没有在售的商品。" emoji="🐟" title="暂无在售商品" />
        ) : null}

        {items.length > 0 ? (
          <div className="grid grid-cols-4 gap-5">
            {items.map((item) => (
              <PcListingCard item={item} key={item.id} />
            ))}
          </div>
        ) : null}

        {listings.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              disabled={listings.isFetchingNextPage}
              onClick={() => void listings.fetchNextPage()}
              variant="outline"
            >
              {listings.isFetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : null}
              {listings.isFetchingNextPage ? '正在加载…' : '加载更多'}
            </Button>
          </div>
        ) : null}

        {listings.isFetchNextPageError ? (
          <p className="text-center text-danger text-xs">加载更多失败，请重试</p>
        ) : null}
      </section>
    </div>
  )
}
