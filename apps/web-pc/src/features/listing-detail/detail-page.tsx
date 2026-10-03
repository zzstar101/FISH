import type { ListingStatus } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  Flag,
  HandCoins,
  Heart,
  Home,
  Images,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PriceText } from '../../components/price-text'
import { ApiError } from '../../lib/api-client'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel, conditionLabel } from '../../lib/labels'
import { currentHref } from '../../lib/redirect'
import { useAuth } from '../auth/auth-provider'
import { describeCreateConversationFailure } from '../chat/api'
import { useCreateConversation } from '../chat/queries'
import { useFavoriteMutation, useFavoriteState, useUnfavoriteMutation } from '../favorites/queries'
import { useDetailTracking } from '../recommendation/use-detail-tracking'
import { ReportEntry } from '../reports/report-entry'
import { canReportUser } from '../reports/view'
import { BuyDialog } from './buy-dialog'
import { CommentsSection } from './comments-section'
import type { FavoriteReadState } from './favorite-button'
import { FavoriteButtonView, favoriteButtonState } from './favorite-button'
import { ListingGallery } from './listing-gallery'
import { ListingNoLine } from './listing-no-line'
import { useListingDetail } from './queries'

const STATUS_LABEL: Record<ListingStatus, string | null> = {
  ACTIVE: '在售',
  RESERVED: '已预定',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

export function ListingDetailPage({ listingId }: { listingId: string }) {
  const { me, isInitializing, error: authError, refetch: refetchAuth } = useAuth()
  const navigate = useNavigate()
  const viewerId = me?.id ?? null
  const detail = useListingDetail(listingId, viewerId)
  // 详情页行为埋点：必须等详情真的加载出来才上报——加载中和 404（商品不存在）都不该记
  // 一次浏览，所以钩子仍放在提前返回之前，但把「数据已就绪」传进去，由钩子决定发不发。
  useDetailTracking(listingId, detail.data !== null && detail.data !== undefined)
  const createConversation = useCreateConversation()
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatUnavailable, setChatUnavailable] = useState(false)
  const [buyOpen, setBuyOpen] = useState(false)
  // 收藏态以服务端为准：读用 GET 的真实结果，写成功后写缓存的是服务端返回值，
  // 失败只显示错误文本、绝不本地翻转（#193 并入 #190 的用户可见要求）。
  const favoriteStateQuery = useFavoriteState(listingId, viewerId)
  const favoriteMutation = useFavoriteMutation()
  const unfavoriteMutation = useUnfavoriteMutation()
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  const favoritePending = favoriteMutation.isPending || unfavoriteMutation.isPending
  const viewerRef = useRef(viewerId)
  const resetViewerRef = useRef(viewerId)
  viewerRef.current = viewerId

  useEffect(() => {
    if (resetViewerRef.current === viewerId) return
    resetViewerRef.current = viewerId
    setChatError(null)
    setChatUnavailable(false)
    setBuyOpen(false)
    setFavoriteError(null)
  }, [viewerId])

  function handleChat() {
    const requestedBy = viewerId
    if (requestedBy === null) return
    setChatError(null)
    createConversation.mutate(
      { listingId, ownerId: requestedBy },
      {
        onSuccess: (conversation) => {
          if (viewerRef.current !== requestedBy) return
          void navigate({
            to: '/messages/$conversationId',
            params: { conversationId: conversation.id },
          })
        },
        onError: (error) => {
          if (viewerRef.current !== requestedBy) return
          if (error instanceof ApiError && error.code === 'CANNOT_CHAT_WITH_SELF') {
            setChatUnavailable(true)
            return
          }
          setChatError(describeCreateConversationFailure(error))
        },
      },
    )
  }

  /** 已收藏 → 取消（DELETE 无条件幂等）；未收藏 → 收藏（POST 仅在售可点，按钮已禁用兜底）。 */
  function handleFavoriteToggle() {
    if (viewerId === null) return
    const data = favoriteStateQuery.data
    if (data === undefined || data.kind !== 'loaded') return
    setFavoriteError(null)
    const mutate = data.favorited ? unfavoriteMutation : favoriteMutation
    mutate.mutate(listingId, {
      onSuccess: (result) => {
        if (result.kind === 'failed') setFavoriteError(result.message)
      },
    })
  }

  if (detail.isPending) return <LoadingState label="正在加载商品详情…" />

  if (detail.isError) {
    return <ErrorState message="商品详情加载失败" onRetry={() => void detail.refetch()} />
  }

  if (detail.data === null) {
    return (
      <EmptyState
        action={
          <Link
            className="rounded-lg bg-brand px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-lavender"
            to="/search"
          >
            去搜索其它商品
          </Link>
        }
        description="商品可能已下架，或者当前账号无权查看"
        emoji="📦"
        title="找不到商品"
      />
    )
  }

  const item = detail.data
  const favoriteRead: FavoriteReadState =
    favoriteStateQuery.data === undefined
      ? 'loading'
      : favoriteStateQuery.data.kind === 'loaded'
        ? favoriteStateQuery.data.favorited
          ? 'favorited'
          : 'notFavorited'
        : favoriteStateQuery.data.kind === 'notFound'
          ? 'notFound'
          : 'unknown'
  const moderationLabel =
    item.moderationStatus === 'REVIEW'
      ? '审核中'
      : item.moderationStatus === 'BLOCKED'
        ? '审核未通过'
        : null
  const statusLabel = moderationLabel === null ? STATUS_LABEL[item.status] : null

  return (
    <div className="space-y-6">
      <nav aria-label="面包屑" className="flex items-center gap-1.5 text-ink-3 text-sm">
        <Link className="inline-flex items-center gap-1 hover:text-brand" to="/">
          <Home className="size-4" />
          首页
        </Link>
        <ChevronRight className="size-3.5" />
        <Link className="hover:text-brand" to="/search">
          全部闲置
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="max-w-[420px] truncate text-ink-2">{item.title}</span>
      </nav>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)] items-start gap-7">
        <div className="space-y-6">
          <ListingGallery
            images={item.images}
            key={item.id}
            listingId={item.id}
            title={item.title}
          />

          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-lg">商品描述</h2>
            <p className="mt-4 whitespace-pre-wrap text-ink-2 text-sm leading-7">
              {item.description}
            </p>
          </Card>

          <CommentsSection listingId={item.id} />
        </div>

        <aside className="sticky top-24 space-y-4">
          <Card className="gap-0 border border-line p-6">
            <div className="flex flex-wrap gap-2">
              {statusLabel !== null ? <Badge variant="warn">{statusLabel}</Badge> : null}
              {moderationLabel !== null ? <Badge variant="danger">{moderationLabel}</Badge> : null}
              {item.urgent ? <Badge variant="danger">急出</Badge> : null}
              {item.free ? <Badge variant="brand">免费送</Badge> : null}
              {item.negotiable ? <Badge variant="secondary">可小刀</Badge> : null}
            </div>

            <h1 className="mt-4 font-semibold text-[28px] leading-tight tracking-[-0.03em]">
              {item.title}
            </h1>
            <PriceText
              cents={item.priceCents}
              className="mt-4 block font-bold text-[36px]"
              symbolClassName="text-xl"
            />

            <div className="mt-5 flex flex-wrap gap-2">
              <Badge className="h-7 px-2.5" variant="secondary">
                {categoryLabel(item.category)}
              </Badge>
              <Badge className="h-7 px-2.5" variant="secondary">
                {conditionLabel(item.condition)}
              </Badge>
              {item.images.length > 0 ? (
                <Badge className="h-7 gap-1.5 px-2.5" variant="secondary">
                  <Images className="size-3.5" />
                  {item.images.length} 张图
                </Badge>
              ) : null}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-ink-3 text-xs">
                <Clock className="size-3.5" />
                {formatRelativeTimeAt(item.createdAt)}发布
              </p>
              {/* 自己的商品不给自己举报入口：没有治理意义，只会产生无用的举报单。 */}
              {item.isOwner ? null : (
                <ReportEntry
                  className="text-ink-3"
                  size="sm"
                  target={{ type: 'LISTING', id: item.id, label: item.title }}
                  variant="ghost"
                >
                  <Flag className="size-3.5" />
                  举报商品
                </ReportEntry>
              )}
            </div>

            {item.listingNo !== undefined ? (
              // 公开编号（#382）：给人看的引用，可复制后直接在搜索框精确命中；内部 ID 不外显。
              <ListingNoLine listingNo={item.listingNo} />
            ) : null}
          </Card>

          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-base">卖家</h2>
            {/* 可点进他人主页：公开资料与 TA 的在售商品（匿名也能看）。 */}
            <Link
              className="mt-4 flex items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-surface-2"
              params={{ userId: item.seller.id }}
              to="/users/$userId"
            >
              <UserAvatar
                avatarUrl={item.seller.avatarUrl}
                emoji={item.seller.nickname.slice(0, 1)}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{item.seller.nickname}</p>
                <div className="mt-1.5">
                  {item.seller.authStatus === 'VERIFIED' ? (
                    <Badge className="gap-1" variant="success">
                      <ShieldCheck className="size-3.5" />
                      已认证
                    </Badge>
                  ) : (
                    <Badge variant="secondary">未认证</Badge>
                  )}
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-ink-3" />
            </Link>
            {/* 不能举报自己（服务端对 `USER` 目标 = 本人直接 422 `REPORT_SELF_TARGET`），
                所以卖家就是自己时不给这个入口。 */}
            {canReportUser(viewerId, item.seller.id) ? (
              <div className="mt-4 flex justify-end">
                <ReportEntry
                  className="text-ink-3"
                  size="sm"
                  target={{ type: 'USER', id: item.seller.id, label: item.seller.nickname }}
                  variant="ghost"
                >
                  <Flag className="size-3.5" />
                  举报该用户
                </ReportEntry>
              </div>
            ) : null}
            {item.isOwner ? (
              <p className="mt-5 rounded-xl bg-brand-soft px-3 py-2.5 text-brand text-sm">
                这是你发布的商品
              </p>
            ) : null}

            {!item.isOwner ? (
              isInitializing || (authError !== null && authError !== undefined) ? null : me ===
                null ? (
                item.status === 'ACTIVE' ? (
                  <Button asChild className="mt-5 w-full" variant="outline">
                    <Link search={{ redirect: currentHref() }} to="/login">
                      <Heart className="size-4" />
                      登录后收藏
                    </Link>
                  </Button>
                ) : null
              ) : (
                <div className="mt-5">
                  <FavoriteButtonView
                    onToggle={handleFavoriteToggle}
                    state={favoriteButtonState({
                      errorMessage:
                        favoriteStateQuery.data?.kind === 'failed'
                          ? favoriteStateQuery.data.message
                          : null,
                      pending: favoritePending,
                      read: favoriteRead,
                      status: item.status,
                    })}
                  />
                  {favoriteError !== null ? (
                    <p className="mt-2 text-danger text-xs">{favoriteError}</p>
                  ) : null}
                </div>
              )
            ) : null}

            {!item.isOwner && item.status === 'ACTIVE' && !chatUnavailable ? (
              authError !== null && authError !== undefined ? (
                <div className="mt-5 flex items-center justify-between gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-danger text-xs">
                  <span>登录状态加载失败</span>
                  <button
                    className="font-medium hover:underline"
                    onClick={refetchAuth}
                    type="button"
                  >
                    重试
                  </button>
                </div>
              ) : isInitializing ? (
                <Button className="mt-5 w-full" disabled type="button">
                  正在恢复登录状态…
                </Button>
              ) : me === null ? (
                <Button asChild className="mt-5 w-full">
                  <Link search={{ redirect: currentHref() }} to="/login">
                    <MessageCircle className="size-4" />
                    登录后聊一聊
                  </Link>
                </Button>
              ) : (
                <div className="mt-5 space-y-3">
                  <Button className="w-full" onClick={() => setBuyOpen(true)} type="button">
                    <HandCoins className="size-4" />
                    我想要
                  </Button>
                  <Button
                    className="w-full"
                    disabled={createConversation.isPending}
                    onClick={handleChat}
                    type="button"
                    variant="outline"
                  >
                    <MessageCircle className="size-4" />
                    {createConversation.isPending ? '正在建立会话…' : '聊一聊'}
                  </Button>
                </div>
              )
            ) : null}
            {chatError !== null ? <p className="mt-3 text-danger text-xs">{chatError}</p> : null}
            {!item.isOwner && item.status !== 'ACTIVE' ? (
              <p className="mt-5 text-ink-3 text-xs">商品当前不可发起新会话</p>
            ) : null}
          </Card>
        </aside>
      </div>

      {me !== null ? (
        <BuyDialog
          free={item.free}
          listingId={item.id}
          onListingStale={() => void detail.refetch()}
          onOpenChange={setBuyOpen}
          open={buyOpen}
          ownerId={me.id}
          priceCents={item.priceCents}
          title={item.title}
        />
      ) : null}
    </div>
  )
}
