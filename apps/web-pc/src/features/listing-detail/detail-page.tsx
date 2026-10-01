import type { ListingStatus } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Clock, Home, Images, MessageCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PriceText } from '../../components/price-text'
import { ApiError } from '../../lib/api-client'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel, conditionLabel } from '../../lib/labels'
import { currentHref } from '../../lib/redirect'
import { useAuth } from '../auth/auth-provider'
import { describeCreateConversationFailure } from '../chat/api'
import { useCreateConversation } from '../chat/queries'
import { useDetailTracking } from '../recommendation/use-detail-tracking'
import { CommentsSection } from './comments-section'
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
  const viewerRef = useRef(viewerId)
  const resetViewerRef = useRef(viewerId)
  viewerRef.current = viewerId

  useEffect(() => {
    if (resetViewerRef.current === viewerId) return
    resetViewerRef.current = viewerId
    setChatError(null)
    setChatUnavailable(false)
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

            <p className="mt-5 flex items-center gap-1.5 text-ink-3 text-xs">
              <Clock className="size-3.5" />
              {formatRelativeTimeAt(item.createdAt)}发布
            </p>

            {item.listingNo !== undefined ? (
              // 公开编号（#382）：给人看的引用，可复制后直接在搜索框精确命中；内部 ID 不外显。
              <ListingNoLine listingNo={item.listingNo} />
            ) : null}
          </Card>

          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-base">卖家</h2>
            <div className="mt-4 flex items-center gap-3">
              <UserAvatar
                avatarUrl={item.seller.avatarUrl}
                emoji={item.seller.nickname.slice(0, 1)}
                size="lg"
              />
              <div className="min-w-0">
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
            </div>
            {item.isOwner ? (
              <p className="mt-5 rounded-xl bg-brand-soft px-3 py-2.5 text-brand text-sm">
                这是你发布的商品
              </p>
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
                <Button
                  className="mt-5 w-full"
                  disabled={createConversation.isPending}
                  onClick={handleChat}
                  type="button"
                >
                  <MessageCircle className="size-4" />
                  {createConversation.isPending ? '正在建立会话…' : '聊一聊'}
                </Button>
              )
            ) : null}
            {chatError !== null ? <p className="mt-3 text-danger text-xs">{chatError}</p> : null}
            {!item.isOwner && item.status !== 'ACTIVE' ? (
              <p className="mt-5 text-ink-3 text-xs">商品当前不可发起新会话</p>
            ) : null}
          </Card>
        </aside>
      </div>
    </div>
  )
}
