import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatFollowTime, formatPrice } from '../../lib/format'
import { AuthBadge } from '../auth/auth-badge'
import { useListing, useWatchers } from './queries'

/** 「谁在关注」页：#5 详情页的次级页，展示商品的想要者名单。 */
export function WatchersPage({ listingId }: { listingId: string }) {
  const navigate = useNavigate()
  const listing = useListing(listingId)
  const watchers = useWatchers(listingId)

  const item = listing.data

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
            <ListingThumb
              alt={item.title}
              className="size-14 rounded-xl"
              coverUrl={item.coverUrl}
              listingId={item.id}
              emojiClassName="text-[1.8rem]"
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
              <span className="font-bold text-2xl">{watchers.data?.length ?? 0}</span>
              <span className="text-[15px]">位同学想要这件闲置</span>
            </p>
            <p className="mt-1.5 text-ink-3 text-xs">按关注时间排序,以下是最近关注的同学</p>
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
                </li>
              ))}
            </ul>
          </section>

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
