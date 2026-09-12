import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import type { ComponentProps } from 'react'
import { formatPrice } from '../../lib/format'
import type { ListingView } from '../../lib/mock/store'
import type { ListingStatus, User } from '../../lib/mock/types'
import { AuthBadge } from '../auth/auth-badge'
import { useStartConversation } from '../listing-detail/queries'
import { ListingRow } from '../search/listing-row'
import {
  useBoughtListings,
  useFavoriteListings,
  useFollowedUsers,
  useHistoryListings,
  useMyListings,
  useRemoveListing,
  useSetListingStatus,
  useSoldListings,
} from './queries'

export type MyListType = 'post' | 'fav' | 'sold' | 'bought' | 'history' | 'follow'

const TABS: { value: MyListType; label: string }[] = [
  { value: 'post', label: '我发布的' },
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

      <MyListBody type={type} label={label} />
    </div>
  )
}

function MyListBody({ type, label }: { type: MyListType; label: string }) {
  const post = useMyListings()
  const fav = useFavoriteListings()
  const sold = useSoldListings()
  const bought = useBoughtListings()
  const history = useHistoryListings()
  const follow = useFollowedUsers()

  const source =
    type === 'post'
      ? post
      : type === 'fav'
        ? fav
        : type === 'sold'
          ? sold
          : type === 'bought'
            ? bought
            : type === 'history'
              ? history
              : null

  if (type === 'follow') {
    if (follow.isPending) return <LoadingState />
    if (follow.data?.length === 0) {
      return <EmptyState description="还没有关注的同校同学" emoji="⭐" />
    }
    return <FollowList users={follow.data ?? []} />
  }

  if (!source) return null
  if (source.isPending) return <LoadingState />
  if (source.isError) {
    return <ErrorState message="列表加载失败" onRetry={() => void source.refetch()} />
  }

  const items = source.data ?? []
  const editable = type === 'post' || type === 'sold'

  return (
    <>
      <h2 className="flex items-baseline justify-between px-4 py-3 font-semibold text-[15px]">
        {label}
        <span className="font-normal text-ink-3 text-xs">{items.length} 件</span>
      </h2>

      {items.length === 0 ? (
        <EmptyState description={`${label}还是空的`} emoji="🐟" />
      ) : (
        <div className="divide-y divide-line bg-surface">
          {items.map((item) =>
            editable ? (
              <MyListingRow item={item} key={item.id} />
            ) : (
              <ListingRow item={item} key={item.id} />
            ),
          )}
        </div>
      )}
    </>
  )
}

/**
 * 商品状态 → 徽章文案与配色。
 *
 * 此前这里只有二元判断（SOLD ? 已售出 : 在售），于是 RESERVED / OFFLINE 会被一律
 * 标成「在售」——已下架的闲置看上去还在卖（#12 要求「商品/愿望/交易各状态可展示」）。
 * 四种状态与详情页的 `STATUS_LABEL` 保持同一套说法。
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

/** 我发布/我卖出：行内带 编辑 / 标为已售出 / 重新上架 / 下架删除（#6 写操作）。 */
function MyListingRow({ item }: { item: ListingView }) {
  const navigate = useNavigate()
  const setStatus = useSetListingStatus()
  const remove = useRemoveListing()
  // 「重新上架」只对已下架/已售出的商品有意义（在售与已预定的不能重复上架）。
  const relistable = item.status === 'OFFLINE' || item.status === 'SOLD'
  const badge = STATUS_BADGE[item.status]

  return (
    <div className="flex gap-3 px-4 py-3">
      <Thumb
        className="size-24 rounded-xl"
        emoji={item.emoji}
        emojiClassName="text-[2.4rem]"
        tone={item.tone}
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
          <span className="text-ink-3 text-xs">
            {item.views} 浏览 · {item.wantCount} 想要
          </span>
        </div>
        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          <Button
            onClick={() => void navigate({ to: '/publish', search: { edit: item.id } })}
            size="sm"
            variant="outline"
          >
            编辑
          </Button>
          {relistable ? (
            <Button
              onClick={() => setStatus.mutate({ id: item.id, status: 'ACTIVE' })}
              size="sm"
              variant="outline"
            >
              重新上架
            </Button>
          ) : (
            <Button
              onClick={() => setStatus.mutate({ id: item.id, status: 'SOLD' })}
              size="sm"
              variant="outline"
            >
              标为已售出
            </Button>
          )}
          <Button onClick={() => remove.mutate(item.id)} size="sm" variant="destructive">
            下架删除
          </Button>
        </div>
      </div>
    </div>
  )
}

function FollowList({ users }: { users: User[] }) {
  return (
    <ul className="divide-y divide-line bg-surface">
      {users.map((user) => (
        <li className="flex items-center gap-3 px-4 py-3" key={user.id}>
          <UserAvatar emoji={user.emoji} size="lg" tone={user.tone} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="truncate font-medium text-[15px]">{user.nickname}</span>
              {user.verified ? <AuthBadge status="VERIFIED" /> : null}
            </p>
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              {user.college} · {user.campus}
            </p>
          </div>
          <FollowChatButton peerId={user.id} />
        </li>
      ))}
    </ul>
  )
}

function FollowChatButton({ peerId }: { peerId: string }) {
  const navigate = useNavigate()
  const startConversation = useStartConversation()
  return (
    <Button
      className="shrink-0"
      onClick={() =>
        startConversation.mutate(
          { peerId },
          {
            onSuccess: (conversationId) =>
              void navigate({ to: '/chat/$conversationId', params: { conversationId } }),
          },
        )
      }
      size="sm"
      variant="secondary"
    >
      <MessageCircle className="size-3" />
      聊一聊
    </Button>
  )
}
