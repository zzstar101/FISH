import type { ListingCard, ListingStatus } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ComponentProps } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice } from '../../lib/format'
import { toListingCard } from '../../lib/mock/store'
import type { User } from '../../lib/mock/types'
import { ListingRow } from '../search/listing-row'
import { OrderCard } from '../transaction/order-card'
import { useTransactions } from '../transaction/queries'
import {
  useFavoriteListings,
  useFollowedUsers,
  useHistoryListings,
  useMyListingLists,
  useSetListingStatus,
} from './queries'

export type MyListType = 'post' | 'active' | 'fav' | 'sold' | 'bought' | 'history' | 'follow'

const TABS: { value: MyListType; label: string }[] = [
  { value: 'post', label: '我发布的' },
  // 「在售」：个人中心统计格的落地分页，只看 ACTIVE（与统计口径一致，Sourcery #35）。
  { value: 'active', label: '在售' },
  { value: 'fav', label: '我的收藏' },
  { value: 'sold', label: '我卖出的' },
  { value: 'bought', label: '我买到的' },
  { value: 'history', label: '浏览历史' },
  { value: 'follow', label: '我的关注' },
]

/** 我的列表（#12）：同一组件按 tab 换数据源（截图 13 / 14）。 */
export function MyListPage({ type }: { type: MyListType }) {
  const label = TABS.find((item) => item.value === type)?.label ?? '我发布的'

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title={label} />
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
          {TABS.map((tab) => (
            <Link
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${
                tab.value === type ? 'bg-brand text-white' : 'bg-surface-2 text-ink-2'
              }`}
              key={tab.value}
              search={{ type: tab.value }}
              to="/mylist"
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </div>

      <MyListBody label={label} type={type} />
    </div>
  )
}

function MyListBody({ type, label }: { type: MyListType; label: string }) {
  // post / active / sold 共用一次 sellerId 读路径（fetchMyListingLists 一次拉三份）。
  const mine = useMyListingLists()
  const fav = useFavoriteListings()
  const history = useHistoryListings()
  const follow = useFollowedUsers()
  const bought = useTransactions('buyer')

  if (type === 'follow') {
    if (follow.isPending) return <LoadingState />
    if (follow.data?.length === 0) {
      return <EmptyState description="还没有关注的同校同学" emoji="⭐" />
    }
    return <FollowList users={follow.data ?? []} />
  }

  if (type === 'bought') {
    if (bought.isPending) return <LoadingState />
    if (bought.isError) {
      return <ErrorState message="交易加载失败" onRetry={() => void bought.refetch()} />
    }
    const orders = bought.data ?? []
    return (
      <>
        <ListHeader count={orders.length} label={label} />
        {orders.length === 0 ? (
          <EmptyState description={`${label}还是空的`} emoji="🐟" />
        ) : (
          <div className="space-y-2.5 px-3">
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        )}
      </>
    )
  }

  // 「我发布的 / 在售 / 我卖出的」：真实 sellerId 读路径，行内带契约允许的写操作。
  if (type === 'post' || type === 'active' || type === 'sold') {
    if (mine.isPending) return <LoadingState />
    if (mine.isError) {
      return <ErrorState message="列表加载失败" onRetry={() => void mine.refetch()} />
    }
    const items =
      type === 'post'
        ? (mine.data?.all ?? [])
        : type === 'active'
          ? (mine.data?.active ?? [])
          : (mine.data?.sold ?? [])

    return (
      <>
        <ListHeader count={items.length} label={label} />
        {items.length === 0 ? (
          <EmptyState description={`${label}还是空的`} emoji="🐟" />
        ) : (
          <div className="divide-y divide-line bg-surface">
            {items.map((item) => (
              <MyListingRow item={item} key={item.id} />
            ))}
          </div>
        )}
      </>
    )
  }

  // 收藏 / 浏览历史：fixture 数据（ListingView），转成契约卡形状复用同一套行渲染。
  const fixtureQuery = type === 'fav' ? fav : history
  if (fixtureQuery.isPending) return <LoadingState />
  if (fixtureQuery.isError) {
    return <ErrorState message="列表加载失败" onRetry={() => void fixtureQuery.refetch()} />
  }
  const rows = (fixtureQuery.data ?? []).map(toListingCard)

  return (
    <>
      <ListHeader count={rows.length} label={label} />
      {rows.length === 0 ? (
        <EmptyState description={`${label}还是空的`} emoji="🐟" />
      ) : (
        <div className="divide-y divide-line bg-surface">
          {rows.map((item) => (
            <ListingRow item={item} key={item.id} />
          ))}
        </div>
      )}
    </>
  )
}

function ListHeader({ label, count }: { label: string; count: number }) {
  return (
    <h2 className="flex items-baseline justify-between px-4 py-3 font-semibold text-[15px]">
      {label}
      <span className="font-normal text-ink-3 text-xs">{count} 件</span>
    </h2>
  )
}

/**
 * 商品状态 → 徽章文案与配色。措辞与详情页 `STATUS_LABEL` 的**非 ACTIVE** 三种一致；
 * ACTIVE 这里必须给出「在售」徽章（详情页由 CTA 文案承担状态表达）。
 */
const STATUS_BADGE: Record<
  ListingStatus,
  { label: string; variant: ComponentProps<typeof Badge>['variant'] }
> = {
  ACTIVE: { label: '在售', variant: 'success' },
  RESERVED: { label: '已预定', variant: 'lavender' },
  SOLD: { label: '已售出', variant: 'secondary' },
  OFFLINE: { label: '已下架', variant: 'secondary' },
}

/**
 * 我发布/在售/卖出的行：编辑 / 重新上架 / 下架。
 * #6 契约的写模型没有「标为已售出」（SOLD 由交易流程写）也没有删除端点，
 * 所以行内操作只有这三个：编辑仅 ACTIVE/OFFLINE 可用，上下架走 offline/online 端点。
 */
function MyListingRow({ item }: { item: ListingCard }) {
  const navigate = useNavigate()
  const setStatus = useSetListingStatus()
  const badge = STATUS_BADGE[item.status]
  const editable = item.status === 'ACTIVE' || item.status === 'OFFLINE'

  return (
    <div className="flex gap-3 px-4 py-3">
      <ListingThumb
        alt={item.title}
        className="size-24 rounded-xl"
        coverUrl={item.coverUrl}
        listingId={item.id}
        emojiClassName="text-[2.4rem]"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <button
          className="line-clamp-2 text-left text-[15px] leading-snug"
          onClick={() =>
            void navigate({ to: '/detail/$listingId', params: { listingId: item.id } })
          }
          type="button"
        >
          {item.title}
        </button>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="font-bold text-lg">{formatPrice(item.priceCents)}</span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          {editable ? (
            <>
              <Button
                onClick={() => void navigate({ to: '/publish', search: { edit: item.id } })}
                size="sm"
                variant="outline"
              >
                编辑
              </Button>
              {item.status === 'OFFLINE' ? (
                <Button
                  onClick={() => setStatus.mutate({ id: item.id, status: 'ACTIVE' })}
                  size="sm"
                  variant="outline"
                >
                  重新上架
                </Button>
              ) : (
                <Button
                  onClick={() => setStatus.mutate({ id: item.id, status: 'OFFLINE' })}
                  size="sm"
                  variant="outline"
                >
                  下架
                </Button>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 我的关注（fixture）：真实契约没有关注关系端点。 */
function FollowList({ users }: { users: User[] }) {
  return (
    <ul className="divide-y divide-line bg-surface">
      {users.map((user) => (
        <li className="flex items-center gap-3 px-4 py-3" key={user.id}>
          <UserAvatar emoji={user.emoji} size="lg" tone={user.tone} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="truncate font-medium text-[15px]">{user.nickname}</span>
              {user.verified ? <Badge variant="success">已认证</Badge> : null}
            </p>
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              {user.college} · {user.campus}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
