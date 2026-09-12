import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, MessageCircle } from 'lucide-react'
import { formatFollowTime, formatPrice } from '../../lib/format'
import { AuthBadge } from '../auth/auth-badge'
import { useListing, useStartConversation, useWatchers } from './queries'

/** 「谁在关注」页：#5 详情页的次级页，展示商品的想要者名单。 */
export function WatchersPage({ listingId }: { listingId: string }) {
  const navigate = useNavigate()
  const listing = useListing(listingId)
  const watchers = useWatchers(listingId)
  const startConversation = useStartConversation()

  const item = listing.data
  const remaining = Math.max((item?.wantCount ?? 0) - (watchers.data?.length ?? 0), 0)

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="谁在关注" />
      </div>

      {listing.isPending ? <LoadingState /> : null}
      {!listing.isPending && !item ? <EmptyState description="商品不存在" emoji="🫥" /> : null}

      {item ? (
        <div className="space-y-2 pt-2">
          <button
            className="flex w-full items-center gap-3 bg-surface px-4 py-3 text-left"
            onClick={() => void navigate({ to: '/detail/$listingId', params: { listingId } })}
            type="button"
          >
            <Thumb
              className="size-14 rounded-xl"
              emoji={item.emoji}
              emojiClassName="text-[1.8rem]"
              tone={item.tone}
            />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-[15px]">{item.title}</p>
              <p className="mt-0.5 font-semibold text-[15px]">{formatPrice(item.priceCents)}</p>
            </div>
            <span className="flex shrink-0 items-center text-ink-3 text-xs">
              查看
              <ChevronRight className="size-4" />
            </span>
          </button>

          <section className="bg-surface px-4 py-4">
            <p className="flex items-baseline gap-1.5">
              <span className="font-bold text-2xl">{item.wantCount}</span>
              <span className="text-[15px]">人想要这件闲置</span>
            </p>
            <p className="mt-1.5 text-ink-3 text-xs">
              按关注时间排序,以下是最近 {watchers.data?.length ?? 0} 位同学,可直接找 TA 聊一聊
            </p>
          </section>

          <section>
            <h2 className="flex items-baseline justify-between px-4 py-3 font-semibold text-[15px]">
              关注的同校同学
              <span className="font-normal text-ink-3 text-xs">
                {watchers.data?.length ?? 0} 人
              </span>
            </h2>
            <ul className="divide-y divide-line bg-surface">
              {watchers.data?.map(({ user, followedMinutesAgo }) => (
                <li className="flex items-center gap-3 px-4 py-3" key={user.id}>
                  <UserAvatar emoji={user.emoji} size="lg" tone={user.tone} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <span className="truncate font-medium text-[15px]">{user.nickname}</span>
                      {user.verified ? <AuthBadge status="VERIFIED" /> : null}
                    </p>
                    <p className="mt-0.5 truncate text-ink-3 text-xs">
                      {user.college} · {user.campus} · {formatFollowTime(followedMinutesAgo)}
                    </p>
                  </div>
                  <Button
                    className="shrink-0"
                    onClick={() =>
                      startConversation.mutate(
                        { peerId: user.id, listingId },
                        {
                          onSuccess: (conversationId) =>
                            void navigate({
                              to: '/chat/$conversationId',
                              params: { conversationId },
                            }),
                        },
                      )
                    }
                    size="sm"
                    variant="secondary"
                  >
                    <MessageCircle className="size-3" />
                    聊一聊
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          {remaining > 0 ? (
            <p className="py-4 text-center text-ink-3 text-xs">
              还有 {remaining} 位同学关注了这件商品
            </p>
          ) : null}

          <div className="px-4 pb-4">
            <Link
              className="flex h-11 items-center justify-center rounded-full bg-brand-soft font-medium text-brand text-sm"
              search={{ goods: listingId }}
              to="/match"
            >
              查看「想买 TA 的同学」匹配结果
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}
