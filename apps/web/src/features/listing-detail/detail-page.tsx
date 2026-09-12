import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { cn } from '@fish/ui/lib/utils'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Thumb, type Tone } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, Clock, Eye, Heart, MapPin, MessageCircle, Share2 } from 'lucide-react'
import { useState } from 'react'
import { formatDiscount, formatRelativeTime, formatYuan } from '../../lib/format'
import type { ListingStatus } from '../../lib/mock/types'
import { AuthBadge } from '../auth/auth-badge'
import { ListingList } from '../home/listing-card'
import { useIsFollowing, useToggleFollow } from '../profile/queries'
import {
  useAddComment,
  useComments,
  useListing,
  useSimilarListings,
  useStartConversation,
  useToggleFavorite,
} from './queries'

const STATUS_LABEL: Record<ListingStatus, string> = {
  ACTIVE: '',
  RESERVED: '已预定',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

const GALLERY_TONES: Tone[] = ['violet', 'sky', 'mint', 'rose']

/** 「成色 99新」这类「标签 + 值」组合（原自研 `ChipPair`，现由 Badge 组合而成）。 */
function AttrPair({ label, value }: { label: string; value: string }) {
  return (
    <Badge className="h-7 gap-1.5 px-2.5" variant="secondary">
      <span className="text-ink-3">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </Badge>
  )
}

export function DetailPage({ listingId }: { listingId: string }) {
  const navigate = useNavigate()
  const listing = useListing(listingId)
  const similar = useSimilarListings(listingId)
  const comments = useComments(listingId)
  const addComment = useAddComment(listingId)
  const favorite = useToggleFavorite(listingId)
  const startConversation = useStartConversation()
  const [draft, setDraft] = useState('')
  // 卖家 id 只在拿到数据后才知道，这里按 data 取值（hook 必须无条件调用）。
  const sellerId = listing.data?.sellerId ?? ''
  const following = useIsFollowing(sellerId)
  const follow = useToggleFollow(sellerId)

  if (listing.isPending) return <LoadingState />
  if (listing.isError) {
    return <ErrorState message="商品加载失败" onRetry={() => void listing.refetch()} />
  }
  if (!listing.data) {
    return (
      <div className="min-h-dvh bg-bg pt-2">
        <NavBar onBack={() => window.history.back()} title="商品详情" />
        <EmptyState description="这件闲置可能已经被下架了" emoji="🫥" title="找不到商品" />
      </div>
    )
  }

  const item = listing.data
  const disabled = item.status !== 'ACTIVE'
  const ctaLabel = disabled ? STATUS_LABEL[item.status] || '不可交易' : '我想要'
  const discount = formatDiscount(item.priceCents, item.originalPriceCents)

  const openChat = () => {
    startConversation.mutate(
      { peerId: item.sellerId, listingId: item.id },
      {
        onSuccess: (conversationId) => {
          void navigate({ to: '/chat/$conversationId', params: { conversationId } })
        },
      },
    )
  }

  return (
    <div className="relative min-h-dvh bg-bg pb-20">
      {/* 浮动按钮（截图：返回 / 分享） */}
      <div className="absolute top-3 left-3 z-30 flex flex-col gap-3">
        <button
          aria-label="返回"
          className="flex size-9 items-center justify-center rounded-full bg-black/25 text-white backdrop-blur"
          onClick={() => window.history.back()}
          type="button"
        >
          <ChevronLeft className="size-5" />
        </button>
        <button
          aria-label="分享"
          className="flex size-9 items-center justify-center rounded-full bg-black/25 text-white backdrop-blur"
          type="button"
        >
          <Share2 className="size-[18px]" />
        </button>
      </div>

      <DetailGallery emoji={item.emoji} tone={item.tone} />

      <section className="bg-surface px-4 py-3">
        <div className="flex items-end gap-2">
          <span className="font-bold text-[28px] leading-none">
            {item.free ? '免费送' : `¥${formatYuan(item.priceCents)}`}
          </span>
          {item.originalPriceCents ? (
            <span className="text-ink-3 text-sm line-through">
              ¥{formatYuan(item.originalPriceCents)}
            </span>
          ) : null}
          {discount ? <Badge variant="secondary">{discount}</Badge> : null}
          <Link
            className="ml-auto text-ink-3 text-sm"
            params={{ listingId }}
            to="/watchers/$listingId"
          >
            {item.wantCount} 人想要
          </Link>
        </div>

        <h1 className="mt-2.5 font-semibold text-xl leading-snug">{item.title}</h1>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3 text-xs">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" />
            {formatRelativeTime(item.publishedMinutesAgo)}发布
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3.5" />
            {item.views} 人看过
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3.5" />
            {item.campus}
          </span>
        </div>
      </section>

      <section className="mt-2 bg-surface px-4 py-4">
        <h2 className="font-semibold text-[15px]">宝贝描述</h2>
        <div className="mt-2 space-y-1 text-[15px] text-ink-2 leading-relaxed">
          {item.description.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <AttrPair label="成色" value={item.condition} />
          <AttrPair label="分类" value={item.category} />
          <AttrPair label="交易" value={item.tradeMethod} />
          <AttrPair label="校区" value={item.campus} />
        </div>
      </section>

      <section className="mt-2 flex items-center gap-3 bg-surface px-4 py-3">
        <Link
          className="flex min-w-0 flex-1 items-center gap-3"
          params={{ userId: item.seller.id }}
          to="/user/$userId"
        >
          <UserAvatar emoji={item.seller.emoji} size="lg" tone={item.seller.tone} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="truncate font-semibold text-[15px]">{item.seller.nickname}</span>
              <AuthBadge status={item.seller.verified ? 'VERIFIED' : 'UNVERIFIED'} />
              <span className="shrink-0 text-ink-3 text-xs">信用 {item.seller.credit}</span>
            </p>
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              {item.seller.college} · {item.seller.campus} · 在售 {item.sellerActiveCount} 件
            </p>
          </div>
        </Link>
        <Button
          className="shrink-0"
          onClick={() => follow.mutate()}
          size="sm"
          variant={following.data ? 'secondary' : 'default'}
        >
          {following.data ? '已关注' : '关注'}
        </Button>
      </section>

      <section className="mt-2 bg-surface px-4 py-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold text-[15px]">留言</h2>
          <span className="text-ink-3 text-xs">{comments.data?.length ?? 0} 条</span>
        </div>
        <ul className="mt-3 space-y-3.5">
          {comments.data?.map((comment) => (
            <li className="flex gap-2.5" key={comment.id}>
              <UserAvatar emoji={comment.user.emoji} size="sm" tone={comment.user.tone} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  <span className="font-medium text-sm">{comment.user.nickname}</span>
                  {comment.user.verified ? <Badge variant="success">已认证</Badge> : null}
                  <span className="ml-auto shrink-0 text-ink-3 text-xs">
                    {formatRelativeTime(comment.minutesAgo)}
                  </span>
                </p>
                <p className="mt-1 text-[15px] text-ink-2 leading-snug">{comment.text}</p>
              </div>
            </li>
          ))}
          {comments.data?.length === 0 ? (
            <li className="text-ink-3 text-sm">还没有留言,来问第一个问题吧</li>
          ) : null}
        </ul>

        <form
          className="mt-4 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!draft.trim()) return
            addComment.mutate(draft.trim(), { onSuccess: () => setDraft('') })
          }}
        >
          <Input
            className="h-10 min-w-0 flex-1 rounded-full border-0 px-4"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="想问问成色、能不能便宜点…"
            value={draft}
          />
          <Button disabled={addComment.isPending} type="submit">
            发送
          </Button>
        </form>
      </section>

      <section className="mt-2 px-3 py-4">
        <h2 className="mb-3 font-semibold text-[15px]">同类好物</h2>
        {similar.isPending ? <LoadingState /> : null}
        {similar.isError ? (
          <ErrorState message="同类好物加载失败" onRetry={() => void similar.refetch()} />
        ) : null}
        {similar.data && similar.data.length > 0 ? <ListingList items={similar.data} /> : null}
        {similar.data?.length === 0 ? <p className="text-ink-3 text-sm">暂时没有同类闲置</p> : null}
      </section>

      <div className="pb-safe fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 border-line border-t bg-surface/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <button
            className="flex w-12 shrink-0 flex-col items-center text-ink-3 text-[10px]"
            onClick={() => favorite.mutate()}
            type="button"
          >
            <Heart className={cn('size-5', item.favorited && 'text-brand')} />
            {item.favorited ? '已收藏' : '收藏'}
          </button>
          <Button
            className="flex-1"
            disabled={disabled || startConversation.isPending}
            onClick={openChat}
            variant="outline"
          >
            <MessageCircle className="size-3.5" />
            聊一聊
          </Button>
          <Button className="flex-1" disabled={disabled} onClick={openChat}>
            {ctaLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 图片轮播：Mock 阶段没有真实图片，用同一个 emoji 在 4 个底色间切换。 */
function DetailGallery({ emoji, tone }: { emoji: string; tone: Tone }) {
  const [index, setIndex] = useState(0)
  const tones = [tone, ...GALLERY_TONES.filter((item) => item !== tone)].slice(0, 4)

  return (
    <div className="relative">
      <div
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto"
        onScroll={(event) => {
          const target = event.currentTarget
          setIndex(Math.round(target.scrollLeft / Math.max(target.clientWidth, 1)))
        }}
      >
        {tones.map((item) => (
          <Thumb
            className="aspect-square w-full shrink-0 snap-center rounded-none"
            emoji={emoji}
            emojiClassName="text-[6rem]"
            key={item}
            tone={item}
          />
        ))}
      </div>
      <span className="absolute right-3 bottom-3 rounded-full bg-black/35 px-2 py-0.5 text-white text-xs">
        {index + 1}/{tones.length}
      </span>
    </div>
  )
}
